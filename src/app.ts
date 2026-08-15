import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import routes from './routes';
import { apiLimiter } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { logger } from './utils/logger';

/**
 * Express application.
 *
 * Middleware order matters and is deliberate:
 *
 *   1. helmet      — security headers on every response, including errors
 *   2. cors        — reject disallowed origins before doing any work
 *   3. body parser — populate req.body
 *   4. logger      — assign a request id, time the whole request
 *   5. rate limit  — cheap rejection before routing
 *   6. routes
 *   7. 404         — only reached when nothing matched
 *   8. errors      — last, so it catches everything above it
 *
 * The server (HTTP listener, Socket.IO, shutdown) lives in `server.ts`; keeping
 * the app itself free of side effects makes it importable in tests.
 */
export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy, trust the first hop so `req.ip` — which rate
  // limiting keys on — is the real client rather than the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON to a separate frontend origin; CSP belongs on the
      // frontend, and CORP would block cross-origin reads from it.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Requests without an Origin header (curl, server-to-server, same-origin
        // navigation) are allowed; browsers always send one for cross-origin.
        if (!origin || env.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        // Deny by *omitting* the CORS headers rather than throwing. Throwing
        // turns a routine policy decision into a 500 — which looks like the API
        // is broken, buries the real cause, and fills the logs with errors. The
        // browser still blocks the request; this just makes the reason legible.
        logger.warn('Blocked by CORS', { origin, allowed: env.allowedOrigins });
        callback(null, false);
      },
      credentials: true,
    }),
  );

  // 100kb is generous for this API's largest payload and keeps an oversized
  // body from being buffered.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());

  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
  });

  // Platform health probes and anyone opening the service URL in a browser hit
  // `/`. Without this they get a 404, which reads like a broken deploy in the
  // logs. Answer with a small banner that says what this service is.
  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        service: 'Bright Smile Dental API',
        status: 'ok',
        docs: 'This is the API. The patient site is a separate application.',
        endpoints: ['/health', '/api/clinic', '/api/appointments/availability?date=YYYY-MM-DD'],
      },
    });
  });

  app.use('/api', apiLimiter, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
