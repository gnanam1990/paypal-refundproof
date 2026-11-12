/**
 * Migration versions this build expects. The web process compares the database against it (health) without
 * reading the migrations directory; loadMigrations() refuses to run when the files on disk disagree, so the list
 * cannot drift silently.
 */
export const EXPECTED_MIGRATIONS = ['0001', '0002', '0003', '0004', '0005', '0006'] as const;
