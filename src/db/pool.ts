import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * PostgreSQL connection pool and query helpers.
 *
 * This module is the only place in the backend that talks to `pg` directly.
 * Repositories import `query` / `withTransaction` from here, which keeps the
 * driver swappable and gives us one place to add timing, logging and type
 * coercion.
 */

// ---------------------------------------------------------------------------
//  Type parsers
// ---------------------------------------------------------------------------
//  By default node-postgres converts DATE and TIMESTAMP columns into JavaScript
//  `Date` objects interpreted in the *server's* local timezone. For a DATE
//  column that is actively harmful: `2026-08-17` becomes a Date at local
//  midnight, which serialises back to `2026-08-16T19:00:00Z` in a UTC+5 shell
//  and silently moves every appointment a day earlier.
//
//  The domain works in wall-clock strings (see utils/datetime.ts), so we tell
//  the driver to hand these columns back exactly as PostgreSQL rendered them.
const OID_DATE = 1082;
const OID_TIME = 1083;
const OID_TIMETZ = 1266;
const OID_NUMERIC = 1700;

types.setTypeParser(OID_DATE, (value) => value); // '2026-08-17'
types.setTypeParser(OID_TIME, (value) => value); // '14:30:00'
types.setTypeParser(OID_TIMETZ, (value) => value);
types.setTypeParser(OID_NUMERIC, (value) => (value === null ? null : Number(value)));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Honour both the explicit flag and the `?sslmode=require` that managed
  // providers put in their connection strings, so a pasted URL works as-is.
  ssl:
    env.DATABASE_SSL || /[?&]sslmode=(require|verify-ca|verify-full)/i.test(env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
});

pool.on('error', (error) => {
  // Fires for idle clients dropped by the server; the pool recovers on its own.
  logger.error('Unexpected PostgreSQL pool error', { error: error.message });
});

/** Slow-query threshold, in milliseconds. */
const SLOW_QUERY_MS = 200;

/**
 * Runs a parameterised query.
 *
 * Always pass values through `params` — string interpolation into SQL is what
 * creates injection holes, and there is no case in this codebase that needs it.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const startedAt = Date.now();
  try {
    const result = await pool.query<T>(text, params as unknown[]);
    const duration = Date.now() - startedAt;
    if (duration > SLOW_QUERY_MS) {
      logger.warn('Slow query', { duration, sql: collapse(text) });
    }
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    logger.error('Query failed', {
      sql: collapse(text),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Convenience for lookups that should return at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const { rows } = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on any
 * thrown error.
 *
 * Booking uses this so that the availability re-check and the INSERT are
 * atomic — see services/appointments/appointment.service.ts.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('Rollback failed', {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Verifies the database is reachable; called once during boot. */
export async function verifyConnection(): Promise<void> {
  const result = await pool.query<{ version: string }>('SELECT version()');
  const version = result.rows[0]?.version?.split(',')[0] ?? 'unknown';
  logger.info('Database connected', { version });
}

/**
 * A socket-level error as Node actually reports it.
 *
 * `NodeJS.ErrnoException` covers `code`/`errno` but not the connection details,
 * which are exactly the fields worth showing here.
 */
interface SocketError extends NodeJS.ErrnoException {
  address?: string;
  port?: number;
}

/**
 * Turns a connection failure into something actionable.
 *
 * Two things make the raw error useless on its own:
 *
 *  1. `localhost` resolves to both `::1` and `127.0.0.1`. When nothing is
 *     listening, Node tries both, and reports an `AggregateError` whose own
 *     `.message` is an EMPTY STRING — the real causes are in `.errors`. Logging
 *     `error.message` therefore prints nothing at all, which is what makes this
 *     failure so confusing to diagnose.
 *  2. `pg` surfaces the useful part as `code` (`ECONNREFUSED`, `28P01`, …)
 *     rather than in the message.
 *
 * So we unwrap the aggregate, keep the distinct codes, and translate the common
 * ones into a fix the reader can act on.
 */
export function describeConnectionError(error: unknown): { reason: string; hint: string } {
  const parts: Error[] =
    error instanceof AggregateError && Array.isArray(error.errors)
      ? (error.errors as Error[])
      : error instanceof Error
        ? [error]
        : [];

  const codes = new Set(
    parts
      .map((part) => (part as NodeJS.ErrnoException).code)
      .filter((code): code is string => Boolean(code)),
  );

  // Node's message for a socket error already embeds the code and the address
  // ("connect ECONNREFUSED 127.0.0.1:5432"), so each part is only added when
  // the message does not already carry it — otherwise the line reads
  // "ECONNREFUSED connect ECONNREFUSED 127.0.0.1:5432 127.0.0.1:5432".
  const reason =
    [
      ...new Set(
        parts.map((part) => {
          const errno = part as SocketError;
          const message = part.message || '';
          const address = errno.address ? `${errno.address}:${errno.port ?? ''}` : '';

          const pieces = [message];
          if (errno.code && !message.includes(errno.code)) pieces.unshift(errno.code);
          if (address && !message.includes(address)) pieces.push(`(${address})`);

          return pieces.filter(Boolean).join(' ').trim();
        }),
      ),
    ]
      .filter(Boolean)
      .join('; ') || String(error);

  let hint =
    'Check that PostgreSQL is running and that DATABASE_URL in backend/.env is correct.';

  if (codes.has('ECONNREFUSED')) {
    hint =
      'Nothing is listening on that host and port — PostgreSQL is not running.\n' +
      '  Start a local database with:   npm run db:start\n' +
      '  then create the schema with:   npm run db:setup';
  } else if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    hint = 'The database host in DATABASE_URL could not be resolved. Check the hostname.';
  } else if (codes.has('ETIMEDOUT')) {
    hint = 'The connection timed out. Check the host, the port, and any firewall in between.';
  } else if (codes.has('28P01')) {
    hint = 'Password authentication failed. Check the user and password in DATABASE_URL.';
  } else if (codes.has('3D000')) {
    hint = 'That database does not exist yet. Create it with:   npm run db:setup';
  } else if (/ssl|tls/i.test(reason)) {
    // PostgreSQL reports "SSL/TLS required" as 28000
    // (invalid_authorization_specification) — the same code it uses for an
    // unknown role. Reading the code alone therefore produces the wrong advice,
    // so the message decides which of the two this is.
    hint =
      'The server requires TLS. Set DATABASE_SSL=true in backend/.env\n' +
      '  (managed providers such as Render, Heroku, Supabase and Neon require it\n' +
      '  on their external connection URLs).';
  } else if (codes.has('28000')) {
    hint = 'That PostgreSQL role does not exist. Check the username in DATABASE_URL.';
  }

  return { reason, hint };
}

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}

function collapse(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

// ---------------------------------------------------------------------------
//  PostgreSQL error codes referenced by the service layer
// ---------------------------------------------------------------------------
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  /** Raised by the `appointments_no_overlap` EXCLUDE constraint. */
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

/** Narrows an unknown caught value to something with a PostgreSQL error code. */
export function isPgError(error: unknown): error is { code: string; constraint?: string; detail?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}
