/* ══════════════════════════════════════════════════════════════════════════
   Single source of truth for configuration.

   dotenv is loaded from *this* module rather than from server.js on purpose.
   ES module imports are evaluated before the importing module's body runs, so
   anything that reads process.env at import time (a CORS list, a JWT secret)
   would see an empty environment if dotenv.config() lived in server.js. Every
   module that needs configuration imports it from here, which guarantees the
   .env file is read first.
   ══════════════════════════════════════════════════════════════════════════ */
import 'dotenv/config';

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

/* Origins are compared as exact strings, so a trailing slash on one side is a
   silent mismatch. Every list entry is normalised the same way the incoming
   Origin header is. */
const list = (value) => String(value || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/* A connection string pasted straight out of the Atlas UI still carries the
   literal `<db_password>` placeholder. Accepting it turns into an
   authentication failure several seconds into boot, which reads as "the
   database is down" rather than "the URI was never filled in". Treat any
   placeholder as "not configured" instead. */
const usableUri = (uri) => {
  const value = String(uri || '').trim();
  if (!value) return null;
  if (/[<>]/.test(value)) return null;
  if (!/^mongodb(\+srv)?:\/\//i.test(value)) return null;
  return value;
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

/* ── Database ─────────────────────────────────────────────────────────────
   One database for everything. Both data domains live in it and are kept
   apart by collection name:

     properties, admins, verificationrequests   the onboarding backend's, and
                                                `properties` is shared
     scriper_users, scriper_jobs, scriper_leads  this backend's alone

   MONGODB_URI and LAMPOSE_MONGO_URI are accepted as aliases so an existing
   deployment's variable keeps working. DB_NAME overrides the database named
   in the URI; it is a mongoose option rather than string surgery on the URI,
   so credentials and query parameters are never re-encoded. */
const mongoUri = usableUri(
  process.env.MONGO_URI || process.env.LAMPOSE_MONGO_URI || process.env.MONGODB_URI,
);
const dbName = (process.env.DB_NAME || process.env.LAMPOSE_DB_NAME || '').trim() || undefined;

/* auto → Mongo when a URI resolved, the local JSON files otherwise.
   The JSON store is a development convenience for the scriper data:
   container filesystems are ephemeral, so a production process writing to it
   loses every lead on the next deploy. server.js says so loudly at boot. */
const storageMode = (() => {
  const requested = String(process.env.SCRIPER_STORAGE || 'auto').trim().toLowerCase();
  if (requested === 'json') return 'json';
  if (requested === 'mongo') return 'mongo';
  return mongoUri ? 'mongo' : 'json';
})();

/* ── Secrets ──────────────────────────────────────────────────────────────
   A missing signing key must not be papered over in production — unsigned or
   predictably-signed tokens are worse than a failed boot. In development a
   fixed (not random) fallback is used so a nodemon restart does not log
   everyone out. */
const DEV_JWT_SECRET = 'lampose-main-backend-development-only-secret-do-not-deploy';
const rawJwtSecret = String(process.env.JWT_SECRET || '').trim();
const jwtSecret = rawJwtSecret || (isProduction ? '' : DEV_JWT_SECRET);

const adminSecretKey = String(process.env.ADMIN_SECRET_KEY || process.env.ADMIN_PASSWORD || '').trim()
  || (isProduction ? '' : 'admin_secret_123');

/* ── CORS ─────────────────────────────────────────────────────────────────
   Both original backends kept their own list; this is the union. Anything the
   deployment adds later goes in ALLOWED_ORIGINS (CORS_ORIGIN is accepted too,
   because the scriper deployment already uses that name). */
const DEFAULT_ORIGINS = [
  // The three production frontends, then the API's own host.
  'https://lampose.com',
  'https://www.lampose.com',
  'https://leads.lampose.com',
  'https://onboard.lampose.com',
  'https://api.lampose.com',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

const envOrigins = [...list(process.env.ALLOWED_ORIGINS), ...list(process.env.CORS_ORIGIN)];
const allowAllOrigins = bool(process.env.CORS_ALLOW_ALL, false) || envOrigins.includes('*');
const allowedOrigins = Array.from(new Set([...DEFAULT_ORIGINS, ...envOrigins.filter((o) => o !== '*')]));

const config = {
  nodeEnv: NODE_ENV,
  isProduction,
  isDevelopment: !isProduction && !isTest,
  isTest,

  port: Number(process.env.PORT) || 5000,
  host: process.env.HOST || '0.0.0.0',
  /* Render, Railway and friends terminate TLS at a proxy. Without this,
     req.ip is the proxy and req.protocol is always http. */
  trustProxy: bool(process.env.TRUST_PROXY, true),
  bodyLimit: process.env.BODY_LIMIT || '1mb',
  requestLogging: bool(process.env.REQUEST_LOGGING, !isTest),

  db: {
    uri: mongoUri,
    dbName,
    /* Fail fast instead of buffering a query for ten seconds and surfacing a
       timeout that names nothing. Routes answer 503 DB_DISCONNECTED instead. */
    options: { bufferCommands: false, serverSelectionTimeoutMS: 5000 },
    retryMs: Number(process.env.DB_RETRY_MS) || 5000,
  },

  storage: { mode: storageMode },

  auth: {
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    adminSecretKey,
    /* Guards routes that only ever run behind the panel's login screen. Set
       to false only if a client that cannot send an Authorization header
       needs them. */
    requireAuth: bool(process.env.REQUIRE_AUTH, true),
    /* admin@scriper.com / admin123 is fine on a laptop and a full compromise
       on a public deployment, so seeding is off in production. server.js
       explains how to create the first administrator instead. */
    seedDefaultUsers: bool(process.env.SEED_DEFAULT_USERS, !isProduction),
  },

  cors: {
    allowAll: allowAllOrigins,
    allowedOrigins,
    /* Preview deployments get a new hostname on every push, so they are
       matched by shape rather than listed one by one. */
    patterns: [
      /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i,
      /^https:\/\/([a-z0-9-]+\.)*lampose\.com$/i,
      /^https:\/\/([a-z0-9-]+\.)*(vercel\.app|netlify\.app|onrender\.com|railway\.app|fly\.dev)$/i,
    ],
  },

  scraper: {
    defaultDepth: Number(process.env.SCRAPER_DEFAULT_DEPTH) || 15,
    maxDepth: Number(process.env.SCRAPER_MAX_DEPTH) || 100,
    /* The original engine topped up short Google Maps results with generated
       rows so a demo always looked full. Real leads and invented ones are
       indistinguishable downstream, so it is opt-in and off by default. */
    fillShortResults: bool(process.env.SCRAPER_FILL_SHORT_RESULTS, false),
    enabled: bool(process.env.SCRAPER_ENABLED, true),
  },
};

/* Problems that must stop the boot, and problems worth saying out loud once.
   Collected rather than thrown so a misconfigured deployment reports every
   fault in one pass instead of one per restart. */
export const configErrors = [];
export const configWarnings = [];

if (!mongoUri) {
  configWarnings.push(
    'MONGO_URI is not set — every data route will answer 503 (DB_DISCONNECTED).',
  );
}

if (!jwtSecret) {
  configErrors.push(
    'JWT_SECRET is not set. Refusing to start in production: every login token would be forgeable.',
  );
} else if (isProduction) {
  if (jwtSecret.length < 32) {
    configWarnings.push(`JWT_SECRET is only ${jwtSecret.length} characters — use 32 or more in production.`);
  }
  if (jwtSecret === DEV_JWT_SECRET || jwtSecret === 'change_me_to_a_long_random_string') {
    configErrors.push('JWT_SECRET is still the example value. Replace it before deploying.');
  }
}

if (!adminSecretKey) {
  configErrors.push('ADMIN_SECRET_KEY is not set — ADMIN registration would be unguarded.');
} else if (isProduction && adminSecretKey === 'admin_secret_123') {
  configWarnings.push('ADMIN_SECRET_KEY is still the example value — anyone who has read the repo can register as ADMIN.');
}

if (storageMode === 'mongo' && !mongoUri) {
  configErrors.push('SCRIPER_STORAGE=mongo but MONGO_URI is missing or unusable.');
}

if (storageMode === 'json' && isProduction) {
  configWarnings.push(
    'Scriper data is on the local JSON store in production. Container filesystems are ephemeral: '
    + 'users, jobs and leads will be lost on the next deploy. Set MONGO_URI.',
  );
}

if (isProduction && config.auth.seedDefaultUsers) {
  configWarnings.push('SEED_DEFAULT_USERS is on in production — the well-known demo accounts will be created.');
}

if (isProduction && config.cors.allowAll) {
  configWarnings.push('CORS is set to allow every origin in production (CORS_ALLOW_ALL / CORS_ORIGIN=*).');
}

export default config;
