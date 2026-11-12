/**
 * Deterministic redaction of customer evidence before display or model use. Order matters: card numbers
 * before generic digit runs. Each rule replaces matches with a labeled placeholder and is counted.
 */
const RULES: Array<[label: string, re: RegExp]> = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['CARD', /\b(?:\d[ -]?){12,18}\d\b/g],
  ['IBAN', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g],
  ['PHONE', /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]\d{3,4}\b/g],
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/g],
];

export interface RedactionReport {
  rules: Record<string, number>;
  version: 'redact-v1';
}

export function redact(text: string): { text: string; report: RedactionReport } {
  const rules: Record<string, number> = {};
  let out = text;
  for (const [label, re] of RULES) {
    out = out.replace(re, () => {
      rules[label] = (rules[label] ?? 0) + 1;
      return `[REDACTED:${label}]`;
    });
  }
  return { text: out, report: { rules, version: 'redact-v1' } };
}
