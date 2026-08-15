/* ══════════════════════════════════════════════════════════════════════════
   JWT authentication.

   The original module threw at import time when JWT_SECRET was missing. In a
   merged backend that would take the public Lampose listings down along with
   the panel, so the check moved to config/env.js, which refuses to boot in
   production and falls back to a fixed development secret otherwise.
   ══════════════════════════════════════════════════════════════════════════ */
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import dbStore from '../storage/dbStore.js';

export const JWT_SECRET = config.auth.jwtSecret;

export const signToken = (user) => jwt.sign(
  { userId: user.userId, email: user.email, role: user.role },
  JWT_SECRET,
  { expiresIn: config.auth.jwtExpiresIn },
);

export const readToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.body?.token || null;
};

const deny = (res, message) => res.status(401).json({
  success: false,
  code: 'UNAUTHORIZED',
  message,
  error: message,
});

export async function authMiddleware(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return deny(res, 'Access denied. Authorization token required.');

    const decoded = jwt.verify(token, JWT_SECRET);

    /* The token alone is not enough: a deleted employee would keep full
       access for the remaining week of their token's life. */
    const user = await dbStore.findUserById(decoded.userId);
    if (!user) return deny(res, 'This account no longer exists.');

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') return deny(res, 'Your session has expired. Please sign in again.');
    if (error.name === 'JsonWebTokenError') return deny(res, 'Invalid authentication token.');
    return next(error);
  }
}

/* Attaches req.user when a valid token is present and does nothing when it is
   not — for routes that are public but behave differently for a signed-in
   caller. */
export async function optionalAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await dbStore.findUserById(decoded.userId);
  } catch {
    req.user = null;
  }
  return next();
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return deny(res, 'Access denied. Authorization token required.');
  if (!roles.includes(req.user.role)) {
    const message = `This action requires the ${roles.join(' or ')} role.`;
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message, error: message });
  }
  return next();
};

/* Lets REQUIRE_AUTH=false turn the guards off without rewriting the route
   files — an escape hatch for a client that cannot send the header. */
const passThrough = (req, res, next) => next();

export const protect = config.auth.requireAuth ? authMiddleware : passThrough;
export const protectRole = (...roles) => (
  config.auth.requireAuth ? requireRole(...roles) : passThrough
);

export default authMiddleware;
