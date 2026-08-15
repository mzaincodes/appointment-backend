import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared helpers for the database scripts.
 *
 * These run outside the application (they exist to *create* the database the
 * application needs), so they deliberately avoid importing `src/config/env` —
 * that module exits the process when DATABASE_URL is missing, which is exactly
 * the situation these scripts are meant to fix.
 */

export const BACKEND_ROOT = path.resolve(__dirname, '..');
/** schema.sql / seed.sql live inside this package — it is what applies them. */
export const DATABASE_DIR = path.join(BACKEND_ROOT, 'database');
export const DATA_DIR = path.join(BACKEND_ROOT, '.pgdata');

export const GREEN = '\x1b[32m';
export const RED = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const DIM = '\x1b[2m';
export const BOLD = '\x1b[1m';
export const RESET = '\x1b[0m';

export function log(message = ''): void {
  process.stdout.write(`${message}\n`);
}
export function ok(message: string): void {
  log(`  ${GREEN}✓${RESET} ${message}`);
}
export function warn(message: string): void {
  log(`  ${YELLOW}!${RESET} ${message}`);
}
export function fail(message: string): void {
  log(`  ${RED}✗${RESET} ${message}`);
}

/** Loads DATABASE_URL from backend/.env without pulling in the app's config. */
export function readEnvFile(): Record<string, string> {
  const envPath = path.join(BACKEND_ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return result;
}

export interface DbTarget {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const DEFAULT_URL = 'postgresql://postgres:postgres@localhost:5432/dentist_booking';

/**
 * Resolves the database to operate on.
 *
 * Precedence: a real environment variable, then backend/.env, then the
 * documented default. The same order the application itself uses.
 */
export function resolveTarget(): DbTarget {
  const url = process.env.DATABASE_URL || readEnvFile().DATABASE_URL || DEFAULT_URL;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL is not a valid connection string:\n    ${url}`);
  }

  return {
    url,
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: decodeURIComponent(parsed.password) || 'postgres',
    // Strip the leading slash; ignore any query string.
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'dentist_booking',
  };
}

/** Same connection, but pointed at the `postgres` maintenance database. */
export function maintenanceTarget(target: DbTarget): DbTarget {
  return { ...target, database: 'postgres' };
}

/**
 * Locates the bundled PostgreSQL binaries.
 *
 * `embedded-postgres` declares one optional dependency per platform, so npm
 * installs only the matching build. Rather than hard-coding a platform we look
 * for whichever package actually landed.
 */
export function findBundledBinaries(): string | null {
  const scope = path.join(BACKEND_ROOT, 'node_modules', '@embedded-postgres');
  if (!fs.existsSync(scope)) return null;

  for (const entry of fs.readdirSync(scope)) {
    const bin = path.join(scope, entry, 'native', 'bin');
    if (fs.existsSync(path.join(bin, 'pg_ctl'))) return bin;
  }
  return null;
}

/** True when the data directory has been initialised by `initdb`. */
export function isInitialised(): boolean {
  return fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
}

/**
 * Renders an error usefully.
 *
 * Node reports a refused connection to `localhost` as an AggregateError with an
 * EMPTY `.message` — it tried both `::1` and `127.0.0.1` and the real causes sit
 * in `.errors`. Printing `error.message` alone yields a blank line, so the
 * aggregate is unwrapped here.
 */
interface SocketError extends NodeJS.ErrnoException {
  address?: string;
  port?: number;
}

export function describeIfConnectionRefused(error: unknown): string {
  const parts: Error[] =
    error instanceof AggregateError && Array.isArray(error.errors)
      ? (error.errors as Error[])
      : error instanceof Error
        ? [error]
        : [];

  const rendered = parts
    .map((part) => {
      const errno = part as SocketError;
      const where = errno.address ? ` (${errno.address}:${errno.port ?? ''})` : '';
      return `${errno.code ? `${errno.code} ` : ''}${part.message || 'connection failed'}${where}`;
    })
    .filter(Boolean);

  return rendered.length > 0 ? rendered.join('\n  ') : String(error);
}

/** True when a server is accepting connections on host:port. */
export async function isReachable(target: DbTarget, timeoutMs = 1500): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(target.port, target.host === 'localhost' ? '127.0.0.1' : target.host);
  });
}
