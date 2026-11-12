/**
 * One rule for every identifier an approval binds (tenant, case, capture, policy, revision, approver):
 * 1..128 printable ASCII characters, no whitespace or control characters. Shared by the domain kernel, the
 * zod schema and the exported JSON Schema, so content can never be valid yet unapprovable.
 */
export const BOUND_ID_SOURCE = '^[\\x21-\\x7e]{1,128}$';
export const BOUND_ID = new RegExp(BOUND_ID_SOURCE);
export const isBoundId = (v: unknown): v is string => typeof v === 'string' && BOUND_ID.test(v);
