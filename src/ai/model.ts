import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ProposalOutput } from './schema';
import type { ProposalPrompt } from './prompt';

export interface ModelResult {
  /** Raw text of the model's JSON answer; validated by src/ai/verify.ts, never trusted. */
  text: string;
  modelServed: string;
  providerRequestId: string | null;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
}

export class ModelTimeoutError extends Error {
  override readonly name = 'ModelTimeoutError';
}
export class ModelProviderError extends Error {
  override readonly name = 'ModelProviderError';
  constructor(
    message: string,
    readonly errorClass: string,
  ) {
    super(message);
  }
}

/**
 * The proposal model boundary. Implementations receive only the redacted prompt and return text. They have no
 * access to the database, the approval service, the operation ledger, the outbox, or the PayPal adapter
 * (enforced by lint: src/ai/** may not import them).
 */
export interface ProposalModel {
  readonly provider: 'anthropic' | 'ollama' | 'local-fixture';
  readonly model: string;
  propose(prompt: ProposalPrompt, deadlineMs: number): Promise<ModelResult>;
}

type JsonSchema = Record<string, unknown>;

/**
 * Ollama consumes JSON Schema directly. The Anthropic SDK helper intentionally moves several Zod constraints into
 * descriptions, which is suitable for Anthropic structured output but would leave local grammar generation without
 * real enum/const constraints. Keep a native Zod schema for Ollama and bind request-specific identifiers exactly.
 */
const OLLAMA_PROPOSAL_JSON_SCHEMA = z.toJSONSchema(ProposalOutput) as JsonSchema;

function ollamaSchemaFor(prompt: ProposalPrompt): JsonSchema {
  const schema = structuredClone(OLLAMA_PROPOSAL_JSON_SCHEMA);
  const properties = schema.properties as JsonSchema;
  properties.captureId = { type: 'string', const: prompt.captureId };

  const citations = properties.citations as JsonSchema;
  const items = citations.items as JsonSchema;
  const citationProperties = items.properties as JsonSchema;
  citationProperties.evidence = { type: 'string', enum: prompt.evidenceLabels };
  return schema;
}

const OllamaResponse = z.strictObject({
  model: z.string().min(1).max(100),
  message: z.strictObject({
    role: z.string().optional(),
    content: z.string().min(1),
    thinking: z.string().optional(),
  }),
  done: z.boolean().optional(),
  done_reason: z.string().max(64).optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  created_at: z.string().optional(),
  total_duration: z.number().nonnegative().optional(),
  load_duration: z.number().nonnegative().optional(),
  prompt_eval_duration: z.number().nonnegative().optional(),
  eval_duration: z.number().nonnegative().optional(),
});

/**
 * A real local-model adapter for Ollama. Only a loopback origin is accepted: RefundProof never turns a configurable
 * model URL into an SSRF primitive. The request is non-streaming, temperature-zero and constrained with the same
 * closed proposal JSON schema as the hosted provider. The answer still goes through verifyProposal().
 */
export class OllamaProposalModel implements ProposalModel {
  readonly provider = 'ollama' as const;
  private readonly endpoint: URL;

  constructor(
    readonly model: string,
    origin = 'http://127.0.0.1:11434',
  ) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new ModelProviderError(
        'Ollama origin must be an unauthenticated loopback URL',
        'OllamaOriginError',
      );
    }
    this.endpoint = new URL('/api/chat', url);
  }

  async propose(prompt: ProposalPrompt, deadlineMs: number): Promise<ModelResult> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          format: ollamaSchemaFor(prompt),
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(deadlineMs),
      });
      if (!response.ok) {
        throw new ModelProviderError(`Ollama provider error ${response.status}`, 'OllamaHttpError');
      }
      const body = OllamaResponse.safeParse(await response.json());
      if (!body.success) {
        throw new ModelProviderError('Ollama returned an invalid response envelope', 'OllamaResponseError');
      }
      return {
        text: body.data.message.content,
        modelServed: body.data.model,
        providerRequestId: null,
        stopReason: body.data.done_reason ?? null,
        usage: {
          inputTokens: body.data.prompt_eval_count ?? null,
          outputTokens: body.data.eval_count ?? null,
        },
      };
    } catch (e) {
      if (e instanceof ModelProviderError) throw e;
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new ModelTimeoutError('model call exceeded its deadline');
      }
      throw new ModelProviderError('Ollama model call failed', e instanceof Error ? e.name : 'Error');
    }
  }
}

export const PROPOSAL_JSON_SCHEMA = zodOutputFormat(ProposalOutput).schema;

/**
 * Claude via the official SDK. Credentials are resolved by the SDK from the server environment; this code never
 * reads, logs or stores them. No tools are offered; output is constrained to the closed proposal schema and
 * re-validated locally. One attempt per call (maxRetries 0): a timeout is recorded, never blindly retried.
 */
export class AnthropicProposalModel implements ProposalModel {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;
  constructor(
    readonly model: string,
    private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  ) {
    this.client = new Anthropic({ maxRetries: 0 });
  }

  async propose(prompt: ProposalPrompt, deadlineMs: number): Promise<ModelResult> {
    try {
      const res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          output_config: {
            effort: this.effort,
            format: { type: 'json_schema', schema: PROPOSAL_JSON_SCHEMA },
          },
        },
        { timeout: deadlineMs, maxRetries: 0, signal: AbortSignal.timeout(deadlineMs) },
      );
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        text,
        modelServed: res.model,
        providerRequestId: res.id,
        stopReason: res.stop_reason,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        },
      };
    } catch (e) {
      if (
        e instanceof Anthropic.APIConnectionTimeoutError ||
        (e instanceof Error && e.name === 'TimeoutError')
      ) {
        throw new ModelTimeoutError('model call exceeded its deadline');
      }
      if (e instanceof Anthropic.APIError) {
        throw new ModelProviderError(`model provider error ${e.status ?? ''}`.trim(), e.constructor.name);
      }
      throw new ModelProviderError('model call failed', e instanceof Error ? e.name : 'Error');
    }
  }
}

/**
 * Deterministic local model for development and tests (provider "local-fixture"). It reads only the prompt it is
 * given and extracts an amount, a reason and supporting quotes with fixed rules. Its output always carries an
 * explicit uncertainty so a fixture draft can never reach review without a human correction. Refused in
 * production by src/config.ts.
 */
export class LocalFixtureProposalModel implements ProposalModel {
  readonly provider = 'local-fixture' as const;
  readonly model = 'local-fixture/v1';
  constructor(private readonly behaviour: (prompt: ProposalPrompt) => string = fixtureAnswer) {}
  async propose(prompt: ProposalPrompt): Promise<ModelResult> {
    return {
      text: this.behaviour(prompt),
      modelServed: this.model,
      providerRequestId: null,
      stopReason: 'end_turn',
      usage: null,
    };
  }
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const REASONS: Array<[RegExp, string]> = [
  [/charged twice|double charge|duplicate/i, 'DUPLICATE_CHARGE'],
  [/never (arrived|received)|not received|didn'?t arrive/i, 'ITEM_NOT_RECEIVED'],
  [/broken|defective|damaged|faulty/i, 'ITEM_DEFECTIVE'],
  [/not as described|different from/i, 'NOT_AS_DESCRIBED'],
];

function sentenceAround(text: string, index: number) {
  const start = Math.max(text.lastIndexOf('.', index) + 1, text.lastIndexOf('\n', index) + 1, 0);
  const endDot = text.indexOf('.', index);
  const end = endDot === -1 ? text.length : endDot + 1;
  return text.slice(start, end).trim().slice(0, 400);
}

function fixtureAnswer(prompt: ProposalPrompt): string {
  const cap = /<capture id="([^"]*)" status="[^"]*" currency="([^"]*)" amount="([^"]*)"/.exec(prompt.user);
  const captureId = unescape(cap?.[1] ?? 'UNKNOWN');
  const currency = cap?.[2] ?? 'USD';
  const evidence = [
    ...prompt.user.matchAll(/<evidence id="(E\d+)" kind="[^"]*">\n([\s\S]*?)\n<\/evidence>/g),
  ].map((m) => ({ label: m[1]!, text: unescape(m[2]!) }));
  const citations: Array<{ claim: string; evidence: string; quote: string }> = [];
  let amount: unknown = { kind: 'FULL' };
  let reasonCode = 'OTHER';
  for (const e of evidence) {
    const money = /(?:\$|USD\s?)(\d{1,7}(?:\.\d{2})?)|(\d{1,7}\.\d{2})\s?(?:USD|dollars)/i.exec(e.text);
    if (money && citations.every((c) => c.claim !== 'AMOUNT')) {
      amount = { kind: 'EXACT', amount: { currency, value: money[1] ?? money[2] } };
      citations.push({ claim: 'AMOUNT', evidence: e.label, quote: sentenceAround(e.text, money.index) });
    }
    for (const [re, code] of REASONS) {
      const m = re.exec(e.text);
      if (m && citations.every((c) => c.claim !== 'REASON')) {
        reasonCode = code;
        citations.push({ claim: 'REASON', evidence: e.label, quote: sentenceAround(e.text, m.index) });
      }
    }
    if (citations.every((c) => c.claim !== 'CAPTURE_MATCH') && e.text.includes(captureId)) {
      citations.push({ claim: 'CAPTURE_MATCH', evidence: e.label, quote: captureId });
    }
  }
  if (citations.length === 0 && evidence[0]) {
    citations.push({ claim: 'REASON', evidence: evidence[0].label, quote: evidence[0].text.slice(0, 120) });
  }
  return JSON.stringify({
    captureId,
    amount,
    reasonCode,
    noteToPayer: null,
    rationale: 'Deterministic local fixture draft from keyword and amount rules; a human must confirm it.',
    citations: citations.length ? citations : [{ claim: 'REASON', evidence: 'E1', quote: 'n/a' }],
    uncertainties: [
      {
        field: 'AMOUNT',
        note: 'Drafted by the local fixture model, not a real model call; confirm every field.',
      },
    ],
  });
}
