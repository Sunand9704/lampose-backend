/* ══════════════════════════════════════════════════════════════════════════
   Boot.

   config/env.js is required first because it is what loads .env — every other
   module reads its configuration from there rather than from process.env, so
   nothing can observe a half-loaded environment.

   This process now serves all three frontends:

     lampose.com          → /api/v2/listings                    (public site)
     leads.lampose.com    → /api/v2/{auth,users,scraper,properties}
     onboard.lampose.com  → /api/v1/{properties,permissions,…}  + /api/v2/auth
   ══════════════════════════════════════════════════════════════════════════ */
const config = require('./config/env');
const { configErrors, configWarnings } = require('./config/env');
const { connectDB, closeConnections, getIsInMemory } = require('./config/db');
const dbStore = require('./storage/dbStore');
const { initStore, countUsers } = require('./storage/dbStore');
const { stopAllJobs } = require('./services/playwrightScraper');
const { routeMap } = require('./routes');
const app = require('./app');
const { allowedOrigins } = app;

const banner = () => {
  const map = routeMap();
  const line = '='.repeat(78);

  console.log(`\n${line}`);
  console.log(`🚀 [Lampose Main Backend] listening on port ${config.port}  (${config.nodeEnv})`);
  console.log(line);

  console.log('\n📦 Datastore');
  console.log(`   MongoDB       ${config.db.uri ? `configured (${config.db.dbName || 'database named in the URI'})` : 'NOT CONFIGURED'}`);
  console.log(`   leads store   ${config.storage.mode === 'mongo' ? 'MongoDB (scriper_* collections)' : 'local JSON files under data/'}`);
  console.log(`   v1 failover   ${getIsInMemory() ? 'ACTIVE — writes are in memory only' : 'idle (MongoDB reachable)'}`);

  console.log('\n🔐 Guards');
  console.log(`   v2 auth       ${config.auth.configured ? (config.auth.requireAuth ? 'on' : 'OFF (REQUIRE_AUTH=false)') : 'UNCONFIGURED — /api/v2/auth and /api/v2/users answer 503'}`);
  console.log(`   request log   ${config.log.enabled ? `on${config.log.bodies ? ' (with redacted bodies)' : ''}` : 'off'}`);
  console.log(`   body limit    ${config.bodyLimit}`);

  console.log('\n🛣️  API v1  — onboard.lampose.com, admin console');
  map.v1.forEach(({ path, description }) => {
    console.log(`   ${path.padEnd(26)} ${description}`);
  });

  console.log('\n🛣️  API v2  — lampose.com, leads.lampose.com');
  map.v2.forEach(({ path, description }) => {
    console.log(`   ${path.padEnd(26)} ${description}`);
  });

  console.log('\n🔁 Unversioned aliases (what the current frontends call)');
  map.legacy.forEach(({ path, servedBy }) => {
    console.log(`   ${path.padEnd(26)} → ${servedBy}`);
  });

  console.log('\n🌍 CORS allowed origins');
  allowedOrigins.forEach((origin) => console.log(`   - ${origin}`));
  console.log('   + any *.lampose.com, localhost, and preview host (see config/env.js patterns)');

  console.log(`\n${line}\n`);
};

/* An empty user collection in production is not an error, but it does mean
   nobody can sign in to the leads panel — and the reason (seeding is off
   outside development) is not something an operator would guess from a failed
   login. */
const reportFirstAdmin = async () => {
  try {
    const users = await countUsers();
    if (users === 0) {
      console.warn(
        '\n[setup] No leads-panel accounts exist yet. Demo accounts are not seeded in production.\n'
        + '[setup] Create the first administrator with:\n'
        + `[setup]   curl -X POST http://localhost:${config.port}/api/v2/auth/register \\\n`
        + '[setup]     -H "Content-Type: application/json" \\\n'
        + '[setup]     -d \'{"name":"Admin","email":"you@lampose.in","password":"<password>",'
        + '"role":"ADMIN","adminCode":"<ADMIN_SECRET_KEY>"}\'\n',
      );
    }
  } catch { /* the store is still connecting; not worth a warning of its own */ }
};

const startServer = async () => {
  for (const warning of configWarnings) console.warn(`⚠️  [config] ${warning}`);
  for (const error of configErrors) console.error(`❌ [config] ${error}`);

  /* Unlike the leads backend this merge came from, a configuration error does
     not exit here. One process now serves three frontends, and a missing
     JWT_SECRET — which only affects the leads panel's login — must not take
     the public site and the onboarding app down with it. The affected routes
     answer 503 AUTH_NOT_CONFIGURED instead, so no forgeable token is ever
     issued and the fault is still loud. */
  if (configErrors.length && config.isProduction) {
    console.error('❌ [config] Starting anyway: the routes above are disabled, the rest keep serving.');
  }

  /* Does not block the listen: connectDB retries in the background, the v2
     routes answer 503 until it lands, and the v1 routes fall back to their
     in-memory store. A server that refuses to start because the database is
     unreachable can only report the wrong fault. */
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
      console.error(`❌ [server] Port ${config.port} is already in use. `
        + 'Stop the other process or set PORT to something else.');
      process.exit(1);
    }
    console.error('❌ [server] failed to start:', error);
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
    if (forceExit.unref) forceExit.unref();

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

if (require.main === module) {
  startServer().catch((error) => {
    console.error('❌ [server] failed to start:', error);
    process.exit(1);
  });
}

module.exports = { startServer, app, dbStore };
