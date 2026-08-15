/* ══════════════════════════════════════════════════════════════════════════
   Single source of truth for configuration.

   This backend now serves three frontends from one process:

     lampose.com          the public site          → /api/v2/listings
     leads.lampose.com    the leads / scriper panel → /api/v2/{auth,users,scraper,properties}
     onboard.lampose.com  the onboarding app        → /api/v1/{properties,permissions,…}

   Everything the v2 surface needs is read here once. The v1 surface still
   reads process.env directly inside its own route files — deliberately left
   alone, because those files are the ones that must not change behaviour.

   dotenv is loaded from *this* module rather than from server.js so that any
   module reading configuration at require time sees a populated environment,
   whichever entry point pulled it in (server.js, or one of the scripts/).
   ══════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

/* Origins are compared as exact strings, so a trailing slash on one side is a
   silent mismatch. Every list entry is normalised the way the incoming Origin
   header is. */
const list = (value) => String(value || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/* A connection string pasted straight out of the Atlas UI still carries the
   literal `<db_password>` placeholder. Accepting it turns into an
   authentication failure several seconds into boot, which reads as "the
   database is down" rather than "the URI was never filled in". */
const usableUri = (uri) => {
  const value = String(uri || '').trim().replace(/^["']|["']$/g, '');
  if (!value) return null;
  if (/[<>]/.test(value)) return null;
  if (!/^mongodb(\+srv)?:\/\//i.test(value)) return null;
  return value;
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

/* ── Database ─────────────────────────────────────────────────────────────
   One database for everything. The data domains are kept apart by collection
   name, not by database:

     properties, admins, verificationrequests,
     permissionrequests                          the onboarding side (v1)
     scriper_users, scriper_jobs, scriper_leads  the leads panel (v2)

   MONGODB_URI and LAMPOSE_MONGO_URI are accepted as aliases so an existing
   deployment's variable keeps working. */
const mongoUri = usableUri(
  process.env.MONGO_URI || process.env.LAMPOSE_MONGO_URI || process.env.MONGODB_URI,
);
const dbName = (process.env.DB_NAME || process.env.LAMPOSE_DB_NAME || '').trim() || undefined;

/* auto → Mongo when a URI resolved, the local JSON files under data/
   otherwise. The JSON store is a development convenience for the leads data:
   container filesystems are ephemeral, so a production process writing to it
   loses every lead on the next deploy. server.js says so loudly at boot. */
const storageMode = (() => {
  const requested = String(process.env.SCRIPER_STORAGE || 'auto').trim().toLowerCase();
  if (requested === 'json') return 'json';
  if (requested === 'mongo') return 'mongo';
  return mongoUri ? 'mongo' : 'json';
})();

/* ── Secrets ──────────────────────────────────────────────────────────────
   A missing signing key must not be papered over in production. The original
   leads backend refused to boot over this; here it cannot, because the same
   process also serves the onboarding app and the public site — killing it
   would take down two working frontends to protect a third. Instead the v2
   auth routes answer 503 AUTH_NOT_CONFIGURED and no token is ever issued.
   In development a fixed (not random) fallback is used so a restart does not
   log everyone out. */
const DEV_JWT_SECRET = 'lampose-main-backend-development-only-secret-do-not-deploy';
const rawJwtSecret = String(process.env.JWT_SECRET || '').trim();
const jwtSecret = rawJwtSecret || (isProduction ? '' : DEV_JWT_SECRET);

const adminSecretKey = String(process.env.ADMIN_SECRET_KEY || process.env.ADMIN_PASSWORD || '').trim()
  || (isProduction ? '' : 'admin_secret_123');

/* ── CORS ─────────────────────────────────────────────────────────────────
   The union of both backends' lists. Anything a deployment adds later goes in
   ALLOWED_ORIGINS; CORS_ORIGIN and CORS_ALLOWED_ORIGINS are accepted as
   aliases because the two original deployments each used a different name. */
const DEFAULT_ORIGINS = [
  // The three production frontends, then the API's own host.
  'https://lampose.com',
  'https://www.lampose.com',
  'https://leads.lampose.com',
  'https://onboard.lampose.com',
  'https://api.lampose.com',
  'https://api.leads.lampose.com',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:8004',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
];

const envOrigins = [
  ...list(process.env.ALLOWED_ORIGINS),
  ...list(process.env.CORS_ORIGIN),
  ...list(process.env.CORS_ALLOWED_ORIGINS),
];
const allowAllOrigins = bool(process.env.CORS_ALLOW_ALL, false) || envOrigins.includes('*');
const allowedOrigins = Array.from(new Set([
  ...DEFAULT_ORIGINS,
  ...envOrigins.filter((o) => o !== '*'),
]));

const config = {
  nodeEnv: NODE_ENV,
  isProduction,
  isDevelopment: !isProduction && !isTest,
  isTest,

  /* 5001 is what this backend has always listened on; the leads backend used
     5000. PORT wins over both. */
  port: Number(process.env.PORT) || 5001,
  host: process.env.HOST || '0.0.0.0',
  /* Render, Railway, Nginx and friends terminate TLS at a proxy. Without
     this, req.ip is the proxy's and req.protocol is always http. */
  trustProxy: bool(process.env.TRUST_PROXY, true),
  /* 25mb, not the leads backend's 1mb: /api/v1/properties/upload-image accepts
     a base64 data URI in the JSON body, and base64 inflates a 15MB photo to
     roughly 20MB. Lowering this silently breaks image upload from the
     onboarding app. */
  bodyLimit: process.env.BODY_LIMIT || '25mb',

  log: {
    enabled: bool(process.env.REQUEST_LOGGING, !isTest),
    /* Bodies are redacted, never raw — see middleware/requestLogger.js. */
    bodies: bool(process.env.REQUEST_LOG_BODY, true),
    maxBodyChars: Number(process.env.REQUEST_LOG_BODY_CHARS) || 500,
  },

  db: {
    uri: mongoUri,
    dbName,
    options: { serverSelectionTimeoutMS: Number(process.env.DB_TIMEOUT_MS) || 8000 },
    retryMs: Number(process.env.DB_RETRY_MS) || 5000,
  },

  storage: { mode: storageMode },

  auth: {
    jwtSecret,
    /* False only when JWT_SECRET is missing in production. The v2 auth and
       user routes answer 503 instead of issuing a forgeable token. */
    configured: Boolean(jwtSecret),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    adminSecretKey,
    /* Guards the v2 routes that only ever run behind the leads panel's login
       screen. Set to false only if a client that cannot send an Authorization
       header needs them. */
    requireAuth: bool(process.env.REQUIRE_AUTH, true),
    /* admin@scriper.com / admin123 is fine on a laptop and a full compromise
       on a public deployment, so seeding is off in production. */
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

/* Problems worth saying out loud once at boot. Collected rather than thrown:
   this process serves three frontends, and a misconfiguration that only
   affects one of them must not stop the other two. */
const configErrors = [];
const configWarnings = [];

if (!mongoUri) {
  configWarnings.push(
    'MONGO_URI is not set — v2 data routes answer 503 and v1 falls back to its in-memory store.',
  );
}

if (!jwtSecret) {
  configErrors.push(
    'JWT_SECRET is not set. /api/v2/auth and /api/v2/users will answer 503 rather than '
    + 'issue forgeable tokens. The v1 onboarding and admin routes are unaffected.',
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
  configErrors.push('ADMIN_SECRET_KEY is not set — registering an ADMIN through /api/v2/auth/register is refused for everyone.');
} else if (isProduction && adminSecretKey === 'admin_secret_123') {
  configWarnings.push('ADMIN_SECRET_KEY is still the example value — anyone who has read the repo can register as ADMIN.');
}

if (storageMode === 'mongo' && !mongoUri) {
  configErrors.push('SCRIPER_STORAGE=mongo but MONGO_URI is missing or unusable.');
}

if (storageMode === 'json' && isProduction) {
  configWarnings.push(
    'Leads data is on the local JSON store in production. Container filesystems are ephemeral: '
    + 'users, jobs and leads will be lost on the next deploy. Set MONGO_URI.',
  );
}

if (isProduction && config.auth.seedDefaultUsers) {
  configWarnings.push('SEED_DEFAULT_USERS is on in production — the well-known demo accounts will be created.');
}

if (isProduction && config.cors.allowAll) {
  configWarnings.push('CORS is set to allow every origin in production (CORS_ALLOW_ALL / CORS_ORIGIN=*).');
}

module.exports = config;
module.exports.config = config;
module.exports.configErrors = configErrors;
module.exports.configWarnings = configWarnings;
