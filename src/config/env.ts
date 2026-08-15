import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the backend package root regardless of the cwd the process
// was started from (npm scripts, tsx watch and node dist/ all differ).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Environment schema.
 *
 * Every variable the application reads is declared here and nowhere else, so
 * `process.env` is touched exactly once in the codebase. A missing or malformed
 * value fails fast at boot with a readable message rather than surfacing as an
 * `undefined` deep inside a request handler.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // PostgreSQL connection string, e.g.
  //   postgresql://user:password@localhost:5432/dentist_booking
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Signing secret for access tokens. Must be overridden outside development.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Browser origin allowed to call the API and open a Socket.IO connection.
  // Accepts a comma-separated list so a LAN/device origin can be added locally.
  FRONTEND_URL: z.string().default('http://localhost:3000'),

  // ---- AI provider -------------------------------------------------------
  // Leave AI_API_KEY empty to run the assistant on its offline rule-based
  // provider. See src/services/ai/README-style comment in provider.ts.
  AI_PROVIDER: z.enum(['mistral', 'openai', 'local']).default('mistral'),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('mistral-small-latest'),
  AI_BASE_URL: z.string().default('https://api.mistral.ai/v1'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().positive().max(8).default(4),

  // ---- Rate limits -------------------------------------------------------
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(40),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('debug'),

  /**
   * IANA timezone the clinic operates in, e.g. `America/Los_Angeles`.
   * Empty falls back to the host's timezone — see config/clinic.ts for why
   * that is the right default for local development.
   */
  CLINIC_TIMEZONE: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in the values.\n`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  /** Origins permitted by CORS and the Socket.IO handshake. */
  allowedOrigins: raw.FRONTEND_URL.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  /**
   * True when a real LLM provider is reachable. When false the assistant runs
   * on the deterministic offline provider so the app stays fully usable —
   * including live booking — without an API key.
   */
  hasAiCredentials: raw.AI_PROVIDER !== 'local' && raw.AI_API_KEY.trim().length > 0,
} as const;

export type Env = typeof env;
