/* ══════════════════════════════════════════════════════════════════════════
   One line in the console for every API call this backend receives.

   Mounted as the very first middleware — before CORS — so nothing is
   invisible: a blocked origin, a preflight the browser sends on its own, and
   a 404 for a path that matches no route all get logged like anything else.
   The line itself is printed on `finish`, by which point the body parsers
   have run and `req.body` is populated, so ordering costs nothing.

   Secrets are redacted rather than trimmed to a whitelist: a body field named
   password, token or secret is replaced and everything else is shown, which
   is what makes the log useful when a payload is the thing that is wrong.
   ══════════════════════════════════════════════════════════════════════════ */
const config = require('../config/env');

const SECRET_KEY = /pass(word)?|token|secret|authorization|admincode|adminsecretkey|apikey|api_key/i;

/* A base64 data URI for a 15MB photo would otherwise fill the terminal with
   one request. Only its size is interesting. */
const DATA_URI = /^data:([\w/+.-]+);base64,/i;

const humanBytes = (bytes) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
};

const redact = (value, depth = 0) => {
  if (typeof value === 'string') {
    const match = value.match(DATA_URI);
    if (match) return `<${match[1]}, ${humanBytes(Math.round((value.length * 3) / 4))} base64>`;
    return value.length > 300 ? `${value.slice(0, 300)}…(${value.length} chars)` : value;
  }
  if (depth > 2 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 10).map((v) => redact(v, depth + 1));
    return value.length > 10 ? [...head, `…+${value.length - 10} more`] : head;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      SECRET_KEY.test(key) ? '***REDACTED***' : redact(val, depth + 1),
    ]),
  );
};

const summarise = (value) => {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return '';
  let json;
  try {
    json = JSON.stringify(redact(value));
  } catch {
    return '<unserialisable>';
  }
  const max = config.log.maxBodyChars;
  return json.length > max ? `${json.slice(0, max)}…` : json;
};

/* Which half of the API answered, so a wrong-version call is obvious in the
   log rather than something you work out from the payload. */
const apiVersionOf = (url) => {
  const path = String(url || '').split('?')[0];
  if (/^\/api\/v1(\/|$)/.test(path)) return 'v1';
  if (/^\/api\/v2(\/|$)/.test(path)) return 'v2';
  if (/^\/(api\/)?(properties|admin|verifications|whatsapp|permissions)(\/|$)/.test(path)) return 'v1*';
  if (/^\/(api\/)?(listings|auth|users|scraper)(\/|$)/.test(path)) return 'v2*';
  return '—';
};

const badgeFor = (statusCode) => {
  if (statusCode >= 500) return '🔴';
  if (statusCode >= 400) return '🟡';
  if (statusCode >= 300) return '🔵';
  return '🟢';
};

/** Who called, in the form that is actually useful: the browser origin if
 *  there is one, the client IP otherwise. */
const callerOf = (req) => {
  const origin = req.headers.origin || req.headers.referer;
  if (origin) return String(origin).replace(/\/+$/, '');
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

const requestLogger = (req, res, next) => {
  if (!config.log.enabled) return next();

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const time = new Date().toLocaleTimeString();
    const { statusCode } = res;

    const parts = [
      `🌐 [${time}] ${badgeFor(statusCode)} [${apiVersionOf(req.originalUrl)}]`,
      `${req.method} ${req.originalUrl}`,
      `→ ${statusCode}`,
      `(${ms.toFixed(0)}ms)`,
      `| from ${callerOf(req)}`,
    ];

    const query = summarise(req.query);
    if (query) parts.push(`| query: ${query}`);

    if (config.log.bodies) {
      const body = summarise(req.body);
      if (body) parts.push(`| body: ${body}`);
    }

    /* An employee-identified write is gated by an administrator's approval,
       so who sent it belongs on the same line as the verdict. */
    const employee = req.headers['x-employee-email'] || req.headers['x-user-email'];
    if (employee) parts.push(`| employee: ${employee}`);

    console.log(parts.join(' '));
  });

  return next();
};

module.exports = requestLogger;
module.exports.requestLogger = requestLogger;
