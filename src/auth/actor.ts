export const ROLES = ['OPERATOR', 'APPROVER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  readonly id: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly email: string;
  readonly displayName: string;
  readonly seeded?: boolean;
}

export interface DenialAudit {
  tenantId: string;
  actorId: string;
  subjectType: string;
  subjectId: string;
  reason: string;
}

export class AppError extends Error {
  /** Security-relevant denial to record after any enclosing transaction has rolled back. */
  denial?: DenialAudit;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function withDenialAudit(
  e: AppError,
  actor: Actor,
  subjectType: string,
  subjectId: string,
  reason = e.code,
) {
  e.denial = {
    tenantId: actor.tenantId,
    actorId: actor.id,
    subjectType,
    subjectId: subjectId.slice(0, 64),
    reason,
  };
  return e;
}

export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
export const forbidden = (why = 'Your role does not permit this action') =>
  new AppError(403, 'FORBIDDEN', why);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) =>
  new AppError(409, code, msg, details);

export function requireRole(actor: Actor, ...roles: Role[]) {
  if (!roles.includes(actor.role))
    throw withDenialAudit(forbidden(), actor, 'role', actor.role, `requires ${roles.join('|')}`);
}
