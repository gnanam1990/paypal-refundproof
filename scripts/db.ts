// Database migrations: `tsx scripts/db.ts up | down [steps] | status`. Requires DATABASE_URL.
import { migrateDown, migrateUp, migrationStatus } from '../src/db/migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const [cmd = 'status', arg] = process.argv.slice(2);
const out =
  cmd === 'up'
    ? { applied: await migrateUp(url) }
    : cmd === 'down'
      ? { rolledBack: await migrateDown(url, Number(arg ?? 1)) }
      : await migrationStatus(url);
console.log(JSON.stringify(out, null, 2));
