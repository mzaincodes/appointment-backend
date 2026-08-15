/**
 * Creates the database and loads schema.sql + seed.sql.
 *
 *   npm run db:setup           create if missing, then apply schema + seed
 *   npm run db:setup -- --reset  DROP the database first, then recreate it
 *
 * Works against any reachable PostgreSQL — the one started by `npm run db:start`
 * or a system install — because it only ever talks to DATABASE_URL.
 *
 * This is the programmatic equivalent of:
 *   createdb dentist_booking
 *   psql -d dentist_booking -f database/schema.sql
 *   psql -d dentist_booking -f database/seed.sql
 * and exists so the project can be set up without the `psql` client installed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import {
  BOLD,
  DIM,
  DATABASE_DIR,
  RESET,
  type DbTarget,
  describeIfConnectionRefused,
  fail,
  isReachable,
  log,
  maintenanceTarget,
  ok,
  resolveTarget,
  warn,
} from './db-lib';

const SCHEMA_FILE = path.join(DATABASE_DIR, 'schema.sql');
const SEED_FILE = path.join(DATABASE_DIR, 'seed.sql');

function connectionConfig(target: DbTarget) {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    // Fail quickly rather than hanging when nothing is listening.
    connectionTimeoutMillis: 8000,
  };
}

async function withClient<T>(target: DbTarget, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(connectionConfig(target));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Runs a whole .sql file as one script. */
async function applyFile(target: DbTarget, file: string, label: string): Promise<void> {
  if (!fs.existsSync(file)) {
    fail(`${label} not found at ${file}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(file, 'utf8');
  await withClient(target, async (client) => {
    // The file is sent verbatim: it contains its own BEGIN/COMMIT, and both
    // files depend on statement order, so splitting on semicolons would be
    // both unnecessary and wrong (it would break dollar-quoted functions).
    await client.query(sql);
  });
  ok(`${label} applied`);
}

async function databaseExists(target: DbTarget): Promise<boolean> {
  return withClient(maintenanceTarget(target), async (client) => {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      target.database,
    ]);
    return result.rowCount === 1;
  });
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const target = resolveTarget();

  log(`\n${BOLD}Setting up the database${RESET}`);
  log(
    `  ${DIM}${target.host}:${target.port} · database ${target.database} · user ${target.user}${RESET}\n`,
  );

  if (!(await isReachable(target))) {
    fail(`No PostgreSQL server is listening on ${target.host}:${target.port}`);
    log(`\n  Start one with:   ${BOLD}npm run db:start${RESET}`);
    log(`  ${DIM}or install PostgreSQL and point DATABASE_URL at it.${RESET}\n`);
    process.exit(1);
  }

  try {
    if (reset && (await databaseExists(target))) {
      await withClient(maintenanceTarget(target), async (client) => {
        // Existing sessions would block the DROP; close them first.
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [target.database],
        );
        await client.query(`DROP DATABASE "${target.database}"`);
      });
      warn(`Dropped existing database "${target.database}"`);
    }

    if (await databaseExists(target)) {
      ok(`Database "${target.database}" already exists`);
    } else {
      await withClient(maintenanceTarget(target), async (client) => {
        // Identifiers cannot be bound as parameters. The name comes from the
        // operator's own DATABASE_URL, and is quoted to keep it a single
        // identifier.
        await client.query(`CREATE DATABASE "${target.database}"`);
      });
      ok(`Created database "${target.database}"`);
    }

    await applyFile(target, SCHEMA_FILE, 'database/schema.sql');
    await applyFile(target, SEED_FILE, 'database/seed.sql');

    const counts = await withClient(target, async (client) => {
      const result = await client.query<{ table_name: string; rows: string }>(`
        SELECT 'users' AS table_name, count(*)::text AS rows FROM users
        UNION ALL SELECT 'services',         count(*)::text FROM services
        UNION ALL SELECT 'clinic_hours',     count(*)::text FROM clinic_hours
        UNION ALL SELECT 'clinic_knowledge', count(*)::text FROM clinic_knowledge
        UNION ALL SELECT 'appointments',     count(*)::text FROM appointments
        UNION ALL SELECT 'chat_sessions',    count(*)::text FROM chat_sessions
        UNION ALL SELECT 'chat_messages',    count(*)::text FROM chat_messages
        ORDER BY table_name
      `);
      return result.rows;
    });

    log(`\n  ${BOLD}Loaded${RESET}`);
    for (const row of counts) {
      log(`    ${row.table_name.padEnd(18)} ${row.rows.padStart(4)}`);
    }

    log(`\n  ${BOLD}Development sign-in${RESET}`);
    log(`    admin@brightsmiledental.com   Admin@123    ${DIM}(admin)${RESET}`);
    log(`    zain@example.com              Patient@123  ${DIM}(patient)${RESET}`);
    log(`\n  Start the API with:  ${BOLD}npm run dev${RESET}\n`);
  } catch (error) {
    fail('Setup failed');
    const detail = describeIfConnectionRefused(error);
    log(`\n  ${detail}\n`);
    process.exit(1);
  }
}

void main();
