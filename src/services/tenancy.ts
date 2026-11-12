import type { Queryable } from '../db/pool';
import { hashPassword } from '../auth/password';
import type { Actor, Role } from '../auth/actor';
import { newId } from '../ids';

export async function createTenant(db: Queryable, name: string) {
  const id = newId('ten');
  await db.query('insert into tenants (id, name) values ($1, $2)', [id, name]);
  return { id, name };
}

export async function createActor(
  db: Queryable,
  a: { tenantId: string; role: Role; email: string; displayName: string; password: string; seeded?: boolean },
): Promise<Actor> {
  const id = newId('act');
  const email = a.email.trim().toLowerCase();
  await db.query(
    `insert into actors (id, tenant_id, email, display_name, role, password_hash, seeded)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, a.tenantId, email, a.displayName, a.role, await hashPassword(a.password), a.seeded ?? false],
  );
  return {
    id,
    tenantId: a.tenantId,
    role: a.role,
    email,
    displayName: a.displayName,
    seeded: a.seeded ?? false,
  };
}
