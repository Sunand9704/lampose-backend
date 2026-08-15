/* One line per request, printed when the response finishes so it can carry
   the status and the duration.

   Secrets are redacted rather than trimmed to a whitelist: a body field named
   password, token or secret is replaced, and everything else is shown, which
   is what makes the log useful for debugging a failing payload. */
import config from '../config/env.js';

const SECRET_KEY = /pass(word)?|token|secret|authorization|adminCode/i;
const MAX_BODY_CHARS = 500;

const redact = (value, depth = 0) => {
  if (depth > 2 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      SECRET_KEY.test(key) ? '***REDACTED***' : redact(val, depth + 1),
    ]),
  );
};

const summarise = (value) => {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return '';
  const json = JSON.stringify(redact(value));
  return json.length > MAX_BODY_CHARS ? `${json.slice(0, MAX_BODY_CHARS)}…` : json;
};

export const requestLogger = (req, res, next) => {
  if (!config.requestLogging) return next();

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const { statusCode } = res;

    let badge = '🟢';
    if (statusCode >= 300 && statusCode < 400) badge = '🔵';
    if (statusCode >= 400 && statusCode < 500) badge = '🟡';
    if (statusCode >= 500) badge = '🔴';

    const query = summarise(req.query);
    const body = summarise(req.body);

    console.log(
      `[API] ${badge} ${req.method} ${req.originalUrl} → ${statusCode} (${ms.toFixed(0)}ms)`
      + (query ? ` | query: ${query}` : '')
      + (body ? ` | body: ${body}` : ''),
    );
  });

  return next();
};

export default requestLogger;
