// index.js
const http = require('http');
const { initializeAriClient, ariClient } = require('./asterisk');
const { config, logger } = require('./config');

process.title = 'asterisk-openai-realtime';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

let server; // optional health server
let started = false;

/**
 * Start the health probe HTTP server if configured.
 * - Responds 200 with minimal process stats.
 * - Safe to call multiple times; only starts once.
 */
function maybeStartHealthServer() {
  const port = Number(process.env.HEALTH_PORT || config.HEALTH_PORT || 0);
  if (!port || server) return;

  server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/' || req.url === '/ready') {
      const body = JSON.stringify({
        status: 'ok',
        uptime_s: Math.round(process.uptime()),
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        ariConnected: !!ariClient, // presence only; ARI lifecycle is managed in asterisk.js
        pid: process.pid,
        started
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    logger.info(`Health server listening on 0.0.0.0:${port} (paths: /health, /ready)`);
  });

  server.on('error', (err) => {
    logger.warn(`Health server error: ${err.message}`);
  });
}

async function startApplication() {
  try {
    logger.info('Starting application');
    maybeStartHealthServer();
    await initializeAriClient();
    started = true;
    logger.info('Application started successfully');
  } catch (e) {
    logger.error(`Startup error: ${e.message}`);
    // Give logs a moment to flush, then exit so systemd can restart us
    setTimeout(() => process.exit(1), 200);
  }
}

/**
 * Graceful shutdown:
 * - We emit SIGINT so the cleanup path in asterisk.js runs (it already listens for SIGINT).
 * - As a fallback, force-exit after a timeout.
 */
function requestShutdown(tag = 'unknown') {
  logger.info(`Shutdown requested (${tag})`);
  try {
    // Reuse the cleanup logic registered in asterisk.js on SIGINT:
    process.emit('SIGINT');
  } catch (e) {
    logger.warn(`Failed to emit SIGINT: ${e.message}`);
  } finally {
    // Hard stop if cleanup stalls
    const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 8000);
    setTimeout(() => {
      logger.warn(`Forcing process exit after ${timeoutMs}ms shutdown grace`);
      process.exit(0);
    }, timeoutMs).unref();
  }
}

// Map SIGTERM (systemd stop) to the same cleanup path
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

// Extra hardening: if someone sends SIGINT directly, let asterisk.js handler run.
// We add a guard timeout here too in case something hangs.
process.on('SIGINT', () => {
  const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 8000);
  setTimeout(() => {
    logger.warn(`SIGINT cleanup watchdog forcing exit after ${timeoutMs}ms`);
    process.exit(0);
  }, timeoutMs).unref();
});

// Crash guards — log and exit so the supervisor can restart us
process.on('unhandledRejection', (reason, p) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  logger.error(`UnhandledRejection at: ${p} reason: ${msg}`);
  setTimeout(() => process.exit(1), 50);
});

process.on('uncaughtException', (err) => {
  logger.error(`UncaughtException: ${err.stack || err.message}`);
  setTimeout(() => process.exit(1), 50);
});

// Surface process warnings (deprecations, etc.) to logs
process.on('warning', (w) => {
  logger.warn(`Process warning: ${w.name}: ${w.message}`);
});

// Helpful note on exit
process.on('exit', (code) => {
  logger.info(`Process exiting with code ${code}`);
});

startApplication();
