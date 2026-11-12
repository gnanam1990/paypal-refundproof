import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProviderError, ModelTimeoutError, OllamaProposalModel } from '../../src/ai/model';

const prompt = {
  system: 'system rules',
  user: '<evidence>redacted data</evidence>',
  digest: 'a'.repeat(64),
  captureId: 'CAP',
  evidenceLabels: ['E1'],
};

afterEach(() => vi.unstubAllGlobals());

describe('OllamaProposalModel', () => {
  it('calls only the loopback chat endpoint with the closed proposal schema', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        model: 'qwen3:4b',
        message: { role: 'assistant', content: '{"captureId":"CAP"}', thinking: 'not exposed' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 123,
        eval_count: 45,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const model = new OllamaProposalModel('qwen3:4b');

    await expect(model.propose(prompt, 5_000)).resolves.toEqual({
      text: '{"captureId":"CAP"}',
      modelServed: 'qwen3:4b',
      providerRequestId: null,
      stopReason: 'stop',
      usage: { inputTokens: 123, outputTokens: 45 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'qwen3:4b',
      stream: false,
      think: false,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      options: { temperature: 0 },
    });
    expect(body.format.properties.captureId).toEqual({ type: 'string', const: 'CAP' });
    expect(body.format.properties.citations.items.properties.claim.enum).toEqual([
      'AMOUNT',
      'REASON',
      'CAPTURE_MATCH',
      'NOTE_TO_PAYER',
    ]);
    expect(body.format.properties.citations.items.properties.evidence).toEqual({
      type: 'string',
      enum: ['E1'],
    });
  });

  it('refuses non-loopback origins', () => {
    expect(() => new OllamaProposalModel('qwen3:4b', 'https://models.example.com')).toThrow(
      ModelProviderError,
    );
    expect(() => new OllamaProposalModel('qwen3:4b', 'http://user:secret@127.0.0.1:11434')).toThrow(
      /loopback/,
    );
  });

  it('classifies timeouts, HTTP failures and malformed envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('late');
        error.name = 'TimeoutError';
        throw error;
      }),
    );
    await expect(new OllamaProposalModel('qwen3:4b').propose(prompt, 1_000)).rejects.toBeInstanceOf(
      ModelTimeoutError,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    await expect(new OllamaProposalModel('qwen3:4b').propose(prompt, 1_000)).rejects.toMatchObject({
      errorClass: 'OllamaHttpError',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ model: 'qwen3:4b' })),
    );
    await expect(new OllamaProposalModel('qwen3:4b').propose(prompt, 1_000)).rejects.toMatchObject({
      errorClass: 'OllamaResponseError',
    });
  });
});
