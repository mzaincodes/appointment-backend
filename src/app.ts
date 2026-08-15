import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import routes from './routes';
import { apiLimiter } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';

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
        callback(new Error(`Origin ${origin} is not allowed by CORS.`));
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

  app.use('/api', apiLimiter, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
