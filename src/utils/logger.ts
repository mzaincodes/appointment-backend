import { env } from '../config/env';

/**
 * Small structured logger.
 *
 * Deliberately dependency-free: the application needs levels, timestamps and
 * a request id on every line, and that is about 60 lines of code. In
 * development it prints a readable coloured line; in production it emits JSON
 * so a log shipper can parse it without a custom grok pattern.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m', // grey
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const threshold = LEVEL_ORDER[env.LOG_LEVEL];

/**
 * Keys whose values must never reach the log, wherever they appear in a
 * metadata object. AI keys, passwords and tokens are the ones that realistically
 * get passed around in this codebase.
 */
const REDACTED_KEYS = new Set([
  'password',
  'confirmpassword',
  'currentpassword',
  'newpassword',
  'password_hash',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'ai_api_key',
  'jwt_secret',
  'secret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const timestamp = new Date().toISOString();
  const safeMeta = meta ? (redact(meta) as Record<string, unknown>) : undefined;

  if (env.isProduction) {
    // One JSON object per line — machine readable.
    process.stdout.write(`${JSON.stringify({ timestamp, level, message, ...safeMeta })}\n`);
    return;
  }

  const time = timestamp.slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const extras =
    safeMeta && Object.keys(safeMeta).length > 0 ? ` ${DIM}${JSON.stringify(safeMeta)}${RESET}` : '';
  process.stdout.write(`${DIM}${time}${RESET} ${COLORS[level]}${tag}${RESET} ${message}${extras}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),

  /** Returns a logger that stamps every line with the same fixed metadata. */
  child(bindings: Record<string, unknown>) {
    return {
      debug: (message: string, meta?: Record<string, unknown>) =>
        emit('debug', message, { ...bindings, ...meta }),
      info: (message: string, meta?: Record<string, unknown>) =>
        emit('info', message, { ...bindings, ...meta }),
      warn: (message: string, meta?: Record<string, unknown>) =>
        emit('warn', message, { ...bindings, ...meta }),
      error: (message: string, meta?: Record<string, unknown>) =>
        emit('error', message, { ...bindings, ...meta }),
    };
  },
};

export type Logger = typeof logger;
