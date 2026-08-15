import { createServer } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { closePool, describeConnectionError, verifyConnection } from './db/pool';
import { createSocketServer } from './socket';
import { aiService } from './services/ai/ai.service';
import { logger } from './utils/logger';

/**
 * Process entry point: verify dependencies, start listening, shut down cleanly.
 */
async function start(): Promise<void> {
  // Fail fast and loudly if the database is unreachable. Booting a server that
  // 500s on every request is worse than not booting at all.
  //
  // The failure is spelled out rather than logged as a bare message: an
  // unreachable `localhost` produces an AggregateError with an empty message,
  // so the naive version prints nothing useful at all.
  try {
    await verifyConnection();
  } catch (error) {
    const { reason, hint } = describeConnectionError(error);
    // Redact the password before echoing the connection string back.
    const safeUrl = env.DATABASE_URL.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:****@');

    logger.error('Could not connect to PostgreSQL', { reason, url: safeUrl });
    process.stderr.write(`\n  ${hint}\n\n`);
    process.exit(1);
  }

  const app = createApp();
  const httpServer = createServer(app);

  // Socket.IO shares the HTTP server, so both run on one port.
  const io = createSocketServer(httpServer);

  const provider = aiService.getProviderInfo();

  httpServer.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`, {
      environment: env.NODE_ENV,
      frontend: env.allowedOrigins.join(', '),
      aiProvider: `${provider.name}/${provider.model}${provider.isLive ? '' : ' (offline fallback)'}`,
    });
  });

  /**
   * Graceful shutdown: stop accepting connections, close sockets, drain the
   * pool. The timeout is a backstop so a hung connection cannot block exit.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down`);

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out; exiting immediately');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await closePool();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A promise rejection that reaches here is a bug. Log it with its stack
  // rather than letting Node print a bare warning and continue in an unknown
  // state.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception — exiting', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

void start();
