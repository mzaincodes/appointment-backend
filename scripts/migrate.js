#!/usr/bin/env node
/**
 * Applies database/schema.sql to DATABASE_URL.
 *
 *   npm run migrate
 *
 * ## Why this is plain JavaScript
 *
 * This is the command a deploy runs. Hosts commonly build with
 * `NODE_ENV=production`, which prunes devDependencies — so anything that needs
 * `tsx` or `typescript` is unavailable by the time migrations run. This script
 * depends only on `pg`, which is a production dependency, so it works wherever
 * the server itself works.
 *
 * `schema.sql` is idempotent: it creates only what is missing and never drops
 * anything, so running this on every deploy is safe and leaves existing rows
 * untouched. It deliberately does NOT load seed data — demo rows have no place
 * in a real database.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// Load backend/.env when the variables are not already in the environment.
// Hosts inject them directly (and win, because dotenv never overrides), while
// locally this is what makes `npm run migrate` behave like every other db:*
// script instead of reporting DATABASE_URL as unset.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const SCHEMA_FILE = path.join(__dirname, '..', 'database', 'schema.sql');

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('\n  DATABASE_URL is not set — nothing to migrate.\n');
    process.exit(1);
  }
  return url;
}

/** Unwraps the AggregateError Node raises when every address is refused. */
function describe(error) {
  const parts =
    error instanceof AggregateError && Array.isArray(error.errors) ? error.errors : [error];
  return parts
    .map((part) => {
      const code = part && part.code ? `${part.code} ` : '';
      return `${code}${(part && part.message) || String(part)}`;
    })
    .join('; ');
}

async function main() {
  const connectionString = requireDatabaseUrl();

  if (!fs.existsSync(SCHEMA_FILE)) {
    console.error(`\n  schema.sql not found at ${SCHEMA_FILE}\n`);
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15000,
    // Managed Postgres (Render, Heroku, Supabase…) terminates TLS with a
    // certificate the container has no root for. Honour both the explicit flag
    // and the `?sslmode=require` these providers put in the URL themselves.
    ssl:
      process.env.DATABASE_SSL === 'true' ||
      /[?&]sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
  });

  const redacted = connectionString.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:****@');
  console.log(`\n  Applying schema to ${redacted}`);

  try {
    await client.connect();
  } catch (error) {
    console.error(`\n  Could not connect: ${describe(error)}\n`);
    process.exit(1);
  }

  try {
    await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    const { rows } = await client.query(
      `SELECT count(*)::int AS tables
       FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    console.log(`  Schema applied — ${rows[0].tables} tables present.\n`);
  } catch (error) {
    console.error(`\n  Migration failed: ${describe(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
