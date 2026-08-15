/* ══════════════════════════════════════════════════════════════════════════
   The last two middlewares in the stack.

   The two frontends read failures differently — the Lampose client looks for
   `message`, the Scriper client (axios) looks for `error` — so every failure
   response carries both. `success: false` is included because the Scriper
   pages branch on it.

   Errors that mean something specific are translated here rather than in each
   controller: a mongoose validation failure is a 400, not the 500 that an
   untranslated throw would produce.
   ══════════════════════════════════════════════════════════════════════════ */
import config from '../config/env.js';

export const notFoundHandler = (req, res, next) => {
  const error = new Error(`Not Found - ${req.method} ${req.originalUrl}`);
  error.status = 404;
  error.code = 'ROUTE_NOT_FOUND';
  next(error);
};

const translate = (err) => {
  // Mongoose rejected the document: report which fields and why.
  if (err.name === 'ValidationError' && err.errors) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: Object.values(err.errors).map((e) => e.message).join(', '),
    };
  }

  // An id that is not an ObjectId — a bad request, not a server fault.
  if (err.name === 'CastError') {
    return {
      status: 400,
      code: 'INVALID_ID',
      message: `Invalid value for "${err.path}".`,
    };
  }

  // Unique index violation (a duplicate email, most often).
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
    return {
      status: 409,
      code: 'DUPLICATE_KEY',
      message: `That ${field} is already in use.`,
    };
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return {
      status: 401,
      code: 'INVALID_TOKEN',
      message: 'Invalid or expired authentication token.',
    };
  }

  /* body-parser's own error for malformed JSON. Left untranslated it becomes
     a 500, which reads as "the server is broken" for a client-side typo. */
  if (err.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON.' };
  }

  if (err.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' };
  }

  /* An explicit err.status wins; otherwise a status already set on the
     response (the 404 path does this) and finally 500. */
  const status = err.status || err.statusCode
    || (Number.isInteger(err.responseStatus) ? err.responseStatus : null)
    || 500;

  return {
    status,
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    message: err.message || 'Internal Server Error',
  };
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export const errorHandler = (err, req, res, next) => {
  const { status, code, message } = translate(err);

  /* Client mistakes are noise at full volume; server faults need the stack. */
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} → ${status}`, err);
  } else if (status !== 404) {
    console.warn(`[error] ${req.method} ${req.originalUrl} → ${status}: ${message}`);
  }

  /* A handler that already started streaming (the CSV export) cannot be given
     a JSON body — hand it back to Express to close the socket. */
  if (res.headersSent) return next(err);

  res.status(status).json({
    success: false,
    code,
    message,
    error: message,
    ...(config.isProduction ? {} : { stack: err.stack }),
  });
};

export default errorHandler;
