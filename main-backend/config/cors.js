/**
 * One CORS policy for every frontend this backend serves.
 *
 * The base allowlist lives in config/env.js so the domains that may call this
 * API are visible in one place alongside the rest of the configuration; this
 * module only decides whether a given Origin is on it and builds the options
 * object the `cors` middleware wants.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 * 1. The origin callback answers `callback(null, false)` for a rejected
 *    origin, never `callback(new Error(...))`. Throwing turns a browser policy
 *    decision into a 500 from the error handler — a confusing log line, and a
 *    response the browser blocks anyway.
 *
 * 2. `credentials: true` and `Access-Control-Allow-Origin: *` are mutually
 *    exclusive; every browser rejects that combination. Because the origin is
 *    a function, the `cors` package echoes the *actual* request origin, so
 *    even allow-everything mode stays compatible with the Authorization
 *    header.
 *
 * 3. `exposedHeaders` carries Content-Disposition. Without it the leads panel
 *    cannot read the filename the server chose for a CSV export fetched with
 *    XHR rather than opened in a tab.
 */
const config = require('./env');

/** Compare on the origin alone — scheme + host + port, no trailing slash, no case. */
const normalize = (origin) => String(origin || '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * Build the options object for the `cors` middleware.
 *
 * @param {string[]} origins Extra allowed browser origins, on top of the ones
 * config/env.js already resolved from ALLOWED_ORIGINS / CORS_ORIGIN /
 * CORS_ALLOWED_ORIGINS. Passed by server.js so a deployment can add a host
 * without touching this file.
 */
const createCorsOptions = (origins = []) => {
  const allowedOrigins = [...new Set([
    ...config.cors.allowedOrigins.map(normalize),
    ...origins.map(normalize),
  ])];

  const isOriginAllowed = (origin) => {
    /* No Origin header at all: curl, Postman, server-to-server calls such as
       the Twilio webhooks, health probes, and the plain browser navigation
       the leads CSV export opens in a new tab. None of these are browser
       cross-origin requests, so CORS has no opinion on them. */
    if (!origin) return true;

    const clean = normalize(origin);
    if (config.cors.allowAll) return true;
    if (allowedOrigins.includes(clean)) return true;
    if (config.cors.patterns.some((pattern) => pattern.test(clean))) return true;

    /* Outside production an unlisted origin is almost always a teammate on a
       different Vite port, not an attacker. */
    return !config.isProduction;
  };

  const corsOptions = {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);

      // Answer without the CORS headers rather than throwing: the browser
      // blocks the response either way, and the server log stays readable.
      console.warn(`🚫 [CORS Blocked] Origin "${origin}" is not on the allowlist.`);
      return callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'Cache-Control',
      'X-Requested-With',
      'X-Correlation-ID',
      'x-employee-email', // Identifies the field agent on gated v1 writes
      'x-user-email',
    ],
    exposedHeaders: ['Content-Disposition', 'Content-Length'],
    credentials: true,
    maxAge: 86400, // Cache the preflight for a day
    /* Safari and some corporate proxies choke on 204 for a preflight. */
    optionsSuccessStatus: 200,
  };

  return { corsOptions, allowedOrigins, isOriginAllowed };
};

module.exports = { createCorsOptions, normalize };
