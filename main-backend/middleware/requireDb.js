/* A query issued while the connection is down sits in mongoose's buffer until
   it times out and surfaces as a generic 500 ten seconds later. None of the
   three frontends has fallback data, so the visitor is looking at an error
   either way — it should be the true one, immediately.

   `DB_DISCONNECTED` is the code the Lampose client keys off to say "the
   server is up but its database is not" rather than "the server is down".

   These guard the v2 routes only. The v1 onboarding routes have their own
   in-memory failover (config/db.js `getIsInMemory`) and must not be given a
   503 in front of it. */
const config = require('../config/env');
const { isLamposeUp, isScriperUp } = require('../config/db');

const unavailable = (res, which) => res.status(503).json({
  success: false,
  code: 'DB_DISCONNECTED',
  message: `The server is running but not connected to the ${which} database.`,
  error: `The server is running but not connected to the ${which} database.`,
});

const requireLamposeDb = (req, res, next) => (
  isLamposeUp() ? next() : unavailable(res, 'listings')
);

const requireScriperStore = (req, res, next) => (
  isScriperUp() ? next() : unavailable(res, 'leads')
);

/* Only ever trips when JWT_SECRET is missing in production. Refusing here is
   what lets the process stay up for the other two frontends instead of
   exiting at boot — and no forgeable token is ever issued. */
const requireAuthConfig = (req, res, next) => {
  if (config.auth.configured) return next();
  const message = 'Authentication is not configured on this server (JWT_SECRET is missing).';
  return res.status(503).json({
    success: false,
    code: 'AUTH_NOT_CONFIGURED',
    message,
    error: message,
  });
};

module.exports = { requireLamposeDb, requireScriperStore, requireAuthConfig };
