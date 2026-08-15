/* ══════════════════════════════════════════════════════════════════════════
   One CORS policy for every frontend this backend serves.

   Three things here are deliberate and easy to get wrong:

   1. The origin callback answers `callback(null, false)` for a rejected
      origin, never `callback(new Error(...))`. Throwing turns a browser
      policy decision into a 500 from the error handler, which is both a
      confusing log line and a response the browser blocks anyway.

   2. `credentials: true` and `Access-Control-Allow-Origin: *` are mutually
      exclusive — every browser rejects that combination. Because the origin
      is a function, the `cors` package echoes the *actual* request origin, so
      even the allow-everything mode stays compatible with cookies and the
      Authorization header.

   3. There is no `app.options('*')` anywhere. Express 5 routes through
      path-to-regexp v8, where a bare `*` is a syntax error; the cors
      middleware already answers preflights on its own when it runs first.
   ══════════════════════════════════════════════════════════════════════════ */
import config from './env.js';

/* The Origin header never has a path, but proxies and hand-written clients do
   send a trailing slash. Compare like with like. */
const normalise = (origin) => String(origin || '').trim().replace(/\/+$/, '');

export const isOriginAllowed = (origin) => {
  /* No Origin header at all: curl, Postman, server-to-server calls, health
     probes, and the <a download> the leads export opens in a new tab. These
     are not browser cross-origin requests, so CORS has no opinion on them. */
  if (!origin) return true;

  const clean = normalise(origin);
  if (config.cors.allowAll) return true;
  if (config.cors.allowedOrigins.includes(clean)) return true;
  if (config.cors.patterns.some((pattern) => pattern.test(clean))) return true;

  /* Outside production an unlisted origin is almost always a teammate on a
     different Vite port, not an attacker. */
  return !config.isProduction;
};

export const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cache-Control',
  ],
  /* Without this the leads export cannot read the filename the server chose
     when it is fetched with XHR rather than opened in a tab. */
  exposedHeaders: ['Content-Disposition', 'Content-Length'],
  maxAge: 86400,
  /* Safari and some corporate proxies choke on 204 for a preflight. */
  optionsSuccessStatus: 200,
};

export default corsOptions;
