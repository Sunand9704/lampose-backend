/* ══════════════════════════════════════════════════════════════════════════
   Boot.

   config/env.js is imported first because it is what loads .env — every other
   module reads its configuration from there rather than from process.env, so
   nothing can observe a half-loaded environment.
   ══════════════════════════════════════════════════════════════════════════ */
import config, { configErrors, configWarnings } from './config/env.js';
import { connectDB, closeConnections } from './config/db.js';
import dbStore, { initStore, countUsers } from './storage/dbStore.js';
import { stopAllJobs } from './services/playwrightScraper.js';
import app from './app.js';

const banner = () => {
  const lines = [
    `environment   ${config.nodeEnv}`,
    `listening     http://localhost:${config.port}`,
    `database      ${config.db.uri ? `MongoDB (${config.db.dbName || 'named in the URI'})` : 'NOT CONFIGURED'}`,
    `collections   properties  +  scriper_users / scriper_jobs / scriper_leads`,
    `scriper store ${config.storage.mode === 'mongo' ? 'MongoDB' : 'local JSON files'}`,
    `auth guards   ${config.auth.requireAuth ? 'on' : 'OFF (REQUIRE_AUTH=false)'}`,
    `cors          ${config.cors.allowAll ? 'all origins' : `${config.cors.allowedOrigins.length} origins + preview patterns`}`,
    'endpoints     /api/health  /api/listings  /api/properties  /api/auth  /api/users  /api/scraper',
  ];
  console.log(`\n${'─'.repeat(72)}\n${lines.map((l) => `  ${l}`).join('\n')}\n${'─'.repeat(72)}\n`);
};

/* An empty user collection in production is not an error, but it does mean
   nobody can sign in — and the reason (seeding is off outside development) is
   not something an operator would guess from a failed login. */
const reportFirstAdmin = async () => {
  try {
    const users = await countUsers();
    if (users === 0) {
      console.warn(
        '\n[setup] No accounts exist yet. Default demo accounts are not seeded in production.\n'
        + '[setup] Create the first administrator with:\n'
        + `[setup]   curl -X POST http://localhost:${config.port}/api/auth/register \\\n`
        + '[setup]     -H "Content-Type: application/json" \\\n'
        + '[setup]     -d \'{"name":"Admin","email":"you@lampose.in","password":"<password>",'
        + '"role":"ADMIN","adminCode":"<ADMIN_SECRET_KEY>"}\'\n',
      );
    }
  } catch { /* the store is still connecting; not worth a warning of its own */ }
};

const startServer = async () => {
  for (const warning of configWarnings) console.warn(`[config] ${warning}`);

  if (configErrors.length) {
    for (const error of configErrors) console.error(`[config] ${error}`);
    /* Refusing to boot is the point: a forgeable token or an unguarded admin
       registration is worse than an outage, and an outage gets fixed. */
    if (config.isProduction) {
      console.error('[config] Refusing to start in production with the errors above.');
      process.exit(1);
    }
    console.warn('[config] Continuing anyway because this is not production.');
  }

  /* Does not block the listen: it retries in the background and the data
     routes answer 503 until it lands. A server that refuses to start because
     the database is unreachable can only report the wrong fault. */
  await connectDB();
  await initStore();

  const server = app.listen(config.port, config.host, () => {
    banner();
    if (config.isProduction) reportFirstAdmin();
  });

  /* Load balancers hold connections open; without this a slow client can keep
     a shutting-down process alive past the platform's kill timeout. */
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] Port ${config.port} is already in use. `
        + 'Stop the other process or set PORT to something else.');
      process.exit(1);
    }
    console.error('[server] failed to start:', error);
    process.exit(1);
  });

  /* ── Shutdown ───────────────────────────────────────────────────────────
     Platforms send SIGTERM and then SIGKILL a few seconds later. Closing the
     listener first lets in-flight requests finish; the timer is the backstop
     for a connection that never does. */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received — shutting down.`);

    const forceExit = setTimeout(() => {
      console.error('[server] did not close in 10s, exiting anyway.');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    stopAllJobs();
    server.close(async () => {
      await closeConnections();
      clearTimeout(forceExit);
      console.log('[server] closed cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /* A rejected promise nobody awaited must not take the process down: a
     transient database write inside a background scrape is not a reason to
     stop serving listings. It is logged loudly instead. */
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled promise rejection:', reason);
  });

  /* An uncaught exception leaves the process in an unknown state, so this one
     does exit — after letting the platform's restart handle it. */
  process.on('uncaughtException', (error) => {
    console.error('[server] uncaught exception:', error);
    shutdown('uncaughtException');
  });

  return server;
};

startServer().catch((error) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});

export { startServer, dbStore };
