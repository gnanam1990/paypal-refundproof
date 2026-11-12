#!/usr/bin/env node
// Scans git-tracked files (or the paths given) for credential material. Exit 1 on any finding.
// Findings print file:line and the rule only — never the matched value.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['paypal-access-token', /\bA21AA[A-Za-z0-9_-]{40,}/],
  ['bearer-literal', /Authorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{24,}/i],
  [
    'env-secret-assignment',
    /\b(?:PAYPAL_CLIENT_SECRET|ANTHROPIC_API_KEY|REFUNDPROOF_DATA_KEY|SESSION_SECRET)\s*=\s*[^\s<'"$][^\s]{11,}/,
  ],
];
// Vendor API schemas contain illustrative sample tokens; they are documentation, not credentials.
const ALLOW = [/^docs\/evidence\/provider-schemas\//, /^pnpm-lock\.yaml$/];

const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);

let findings = 0;
for (const f of files) {
  if (ALLOW.some((r) => r.test(f))) continue;
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [rule, re] of RULES) {
      if (re.test(line)) {
        findings++;
        console.log(`${f}:${i + 1}: ${rule}`);
      }
    }
  });
}
console.log(
  findings === 0 ? `secret-scan: 0 findings in ${files.length} files` : `secret-scan: ${findings} finding(s)`,
);
process.exit(findings === 0 ? 0 : 1);
