/* ══════════════════════════════════════════════════════════════════════════
   The database connection.

   One MongoDB database holds everything the three frontends need — the
   onboarding `properties`, `admins`, `verificationrequests` and
   `permissionrequests`, and the leads panel's `scriper_*` collections beside
   them.

   Two things this module has to do at once:

   1. Keep the original in-memory failover the v1 onboarding routes rely on.
      `getIsInMemory()` / `getMemoryStore()` are exported with exactly the
      meaning routes/v1/* already expect.

   2. Never exit the process on a connection failure. Killing the server
      because MongoDB is unreachable turns "the database is down" into
      "nothing is listening", and a browser cannot tell those apart — the
      site would report a network or CORS fault for a database problem.
      The API stays up, keeps retrying, and answers 503 with the real reason.
   ══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');
const config = require('./env');

const DB_STATE = ['disconnected', 'connected', 'connecting', 'disconnecting'];

let isInMemoryFallback = false;
const memoryStore = [];

/* One retry timer. Without the guard, every failed attempt would schedule
   another *and* keep the previous one, so the retry rate doubles each round
   until the process is hammering the cluster. */
let retryTimer = null;
let listenersBound = false;

const dbStatus = () => ({
  state: DB_STATE[mongoose.connection.readyState] || 'unknown',
  connected: mongoose.connection.readyState === 1,
  name: mongoose.connection.name || null,
  host: mongoose.connection.host || null,
});

const isDbUp = () => mongoose.connection.readyState === 1;

/* Kept as separate names because the health endpoint reports the two data
   domains apart — a client should be able to say which half is unavailable
   even though one connection now serves both. */
const isLamposeUp = isDbUp;
const isScriperUp = () => (config.storage.mode === 'json' ? true : isDbUp());

const lamposeStatus = dbStatus;
const scriperStatus = () => (
  config.storage.mode === 'json'
    ? { state: 'json-store', connected: true, name: 'local-json', host: null }
    : dbStatus()
);

const bindConnectionListeners = () => {
  if (listenersBound) return;
  listenersBound = true;

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  [MongoDB] disconnected — v2 routes answer 503 until it returns.');
  });
  mongoose.connection.on('reconnected', () => {
    console.log('✅ [MongoDB] reconnected.');
    isInMemoryFallback = false;
  });
  /* Driver-level errors arrive here. Without a listener mongoose re-emits
     them as an unhandled 'error' event, which crashes the process. */
  mongoose.connection.on('error', (error) => {
    console.error(`❌ [MongoDB] connection error: ${error.message}`);
  });
};

const attempt = async ({ initial = false } = {}) => {
  retryTimer = null;
  const uri = config.db.uri || 'mongodb://127.0.0.1:27017/lamp_onboarding';

  try {
    mongoose.set('strictQuery', false);
    const conn = await mongoose.connect(uri, { ...config.db.options, dbName: config.db.dbName });
    console.log(`✅ [MongoDB Connected]: ${conn.connection.host} — database "${conn.connection.name}"`);

    /* A retry that lands after the initial failure has to clear the failover,
       otherwise every subsequent write goes to a process-local array that
       nothing ever reads back and the data silently splits in two. */
    if (isInMemoryFallback) {
      console.warn('⚠️  [MongoDB] connection recovered — leaving in-memory failover mode. '
        + 'Anything written while it was down lives only in this process.');
      isInMemoryFallback = false;
    }
    return true;
  } catch (error) {
    if (initial) {
      console.warn(`⚠️  [MongoDB Warning]: Could not connect (${error.message}). `
        + 'Switching to the in-memory store so the onboarding routes keep answering.');
      isInMemoryFallback = true;
    } else {
      console.error(`❌ [MongoDB] ${error.message}`);
    }
    console.error(`   ↻ retrying in ${config.db.retryMs / 1000}s. `
      + 'v2 routes answer 503 (DB_DISCONNECTED) meanwhile.');

    if (!retryTimer) {
      retryTimer = setTimeout(() => { attempt().catch(() => {}); }, config.db.retryMs);
      if (retryTimer.unref) retryTimer.unref();
    }
    return false;
  }
};

/**
 * Connect, and keep trying in the background if the first attempt fails.
 * Resolves either way — the caller starts listening regardless.
 */
const connectDB = async () => {
  bindConnectionListeners();
  return attempt({ initial: true });
};

const closeConnections = async () => {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close(false);
};

const getIsInMemory = () => isInMemoryFallback;
const getMemoryStore = () => memoryStore;

module.exports = {
  connectDB,
  closeConnections,
  getIsInMemory,
  getMemoryStore,
  dbStatus,
  isDbUp,
  isLamposeUp,
  isScriperUp,
  lamposeStatus,
  scriperStatus,
};
