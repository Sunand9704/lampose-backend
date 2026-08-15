/* ══════════════════════════════════════════════════════════════════════════
   The database connection.

   One MongoDB database holds everything: the onboarding `properties` the
   public site lists, and the scriper users, jobs and leads. They are kept
   apart by collection name rather than by database — the scriper collections
   are prefixed `scriper_`, because this database has a second writer
   (onboard.lampose.com) whose code is not in this repo and which could
   otherwise claim a generic name like `users` out from under us.

   connect() never exits the process on failure. Killing the server because
   MongoDB is unreachable turns "the database is down" into "nothing is
   listening on port 5000", and a browser cannot tell those apart: the site
   would report a network or CORS fault for a database problem. The API stays
   up, keeps retrying, and answers 503 with the real reason meanwhile.
   ══════════════════════════════════════════════════════════════════════════ */
import mongoose from 'mongoose';
import config from './env.js';

const DB_STATE = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export const dbStatus = () => ({
  state: DB_STATE[mongoose.connection.readyState] || 'unknown',
  connected: mongoose.connection.readyState === 1,
  name: mongoose.connection.name || null,
});

export const isDbUp = () => mongoose.connection.readyState === 1;

/* Kept as separate names because the health endpoint reports the two data
   domains apart — a client should be able to say which half is unavailable
   even though one connection now serves both. */
export const isLamposeUp = isDbUp;
export const isScriperUp = () => (config.storage.mode === 'json' ? true : isDbUp());

export const lamposeStatus = dbStatus;
export const scriperStatus = () => (
  config.storage.mode === 'json'
    ? { state: 'json-store', connected: true, name: 'local-json' }
    : dbStatus()
);

/* One retry timer. Without the guard, every failed attempt would schedule
   another *and* keep the previous one, so the retry rate doubles each round
   until the process is hammering the cluster. */
let retryTimer = null;

const connectWithRetry = async () => {
  const { uri, dbName } = config.db;

  const attempt = async () => {
    retryTimer = null;
    try {
      await mongoose.connect(uri, { ...config.db.options, dbName });
      console.log(`[db] connected — ${mongoose.connection.name}`);
    } catch (error) {
      console.error(`[db] ${error.message}`);
      console.error(`[db] retrying in ${config.db.retryMs / 1000}s. `
        + 'The API stays up and answers 503 (DB_DISCONNECTED) meanwhile.');
      if (!retryTimer) {
        retryTimer = setTimeout(attempt, config.db.retryMs);
        retryTimer.unref?.();
      }
    }
  };

  await attempt();
};

export const connectDB = async () => {
  if (!config.db.uri) {
    console.error('[db] MONGO_URI is not set — every data route will answer 503.');
    return;
  }

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] disconnected — requests will answer 503 until it returns.');
  });
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected.'));
  /* Driver-level errors arrive here. Without a listener mongoose re-emits
     them as an unhandled 'error' event, which crashes the process. */
  mongoose.connection.on('error', (error) => {
    console.error(`[db] connection error: ${error.message}`);
  });

  await connectWithRetry();
};

export const closeConnections = async () => {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close(false);
};

export default connectDB;
