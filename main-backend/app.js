/* ══════════════════════════════════════════════════════════════════════════
   The Express application.

   Split out of server.js so the scripts under scripts/ can boot the real app
   on an ephemeral port and exercise it, rather than testing a second
   almost-identical stack.

   Middleware order here is deliberate, top to bottom:

     1. requestLogger   first, so nothing is invisible — a preflight, a
                        blocked origin and a 404 are all logged. The line is
                        printed on `finish`, by which time the body parsers
                        have run, so it still shows the payload.
     2. cors            before any handler, so a rejected origin never reaches
                        one and preflights are answered here.
     3. body parsers    25mb, because the onboarding app posts base64 images.
     4. routes          v1, v2, then the unversioned aliases.
     5. notFound/error  last, so every failure is JSON rather than Express's
                        HTML error page.
   ══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const cors = require('cors');

const config = require('./config/env');
const { createCorsOptions } = require('./config/cors');
const requestLogger = require('./middleware/requestLogger');
const { registerRoutes, routeMap } = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

/**
 * CORS ORIGIN ALLOWLIST
 *
 * The base list lives in config/env.js (DEFAULT_ORIGINS) and already covers
 * the three production frontends plus every localhost dev port. Add a new
 * deployed frontend there, or per environment through
 * ALLOWED_ORIGINS="https://a.com,https://b.com" in .env.
 */
const { corsOptions, allowedOrigins } = createCorsOptions();

/* Behind Nginx/Render/Railway the socket address is the proxy's. Without
   this, req.ip is useless in logs and req.protocol is always http. */
if (config.trustProxy) app.set('trust proxy', 1);

// Express advertises itself in a header by default; nothing needs to know.
app.disable('x-powered-by');

app.use(requestLogger);

app.use(cors(corsOptions));
/* Express 4's path parser is fine with this, and it makes the preflight
   answer explicit rather than depending on middleware ordering. */
app.options('*', cors(corsOptions));

app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));

app.get(['/', '/api'], (req, res) => {
  res.json({
    message: 'Lampose Main Backend API',
    status: 'running',
    environment: config.nodeEnv,
    versions: ['v1', 'v2'],
    routes: routeMap(),
  });
});

registerRoutes(app);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
module.exports.allowedOrigins = allowedOrigins;
