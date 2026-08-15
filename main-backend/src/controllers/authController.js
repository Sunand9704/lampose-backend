import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import dbStore from '../storage/dbStore.js';
import { JWT_SECRET, signToken, readToken } from '../middleware/authMiddleware.js';

const fail = (res, status, message, extra = {}) => res.status(status).json({
  success: false,
  message,
  error: message,
  ...extra,
});

// @route POST /api/auth/register
export const register = async (req, res, next) => {
  try {
    const { name, email, password, role = 'EMPLOYEE', adminCode } = req.body || {};

    if (!name || !email || !password) {
      return fail(res, 400, 'Name, email, and password are required.');
    }
    if (String(password).length < 6) {
      return fail(res, 400, 'Password must be at least 6 characters long.');
    }

    /* An ADMIN account is created straight from the public form, so the only
       thing standing between a stranger and full access is this key. */
    if (role === 'ADMIN') {
      const expected = config.auth.adminSecretKey;
      if (!expected || String(adminCode || '').trim() !== expected) {
        return fail(res, 403, 'Invalid Admin Security Key. You cannot register as an Admin without a valid security key.');
      }
    }

    const user = await dbStore.registerUser({ name, email, password, role });

    return res.status(201).json({
      success: true,
      message: 'Account registered successfully!',
      data: { token: signToken(user), user },
    });
  } catch (error) {
    /* "already exists" is the user's mistake, not a server fault. */
    if (/already exists/i.test(error.message)) return fail(res, 409, error.message);
    return next(error);
  }
};

// @route POST /api/auth/login
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return fail(res, 400, 'Please provide both email and password.');
    }

    const user = await dbStore.authenticateUser(email, password);

    return res.json({
      success: true,
      message: 'Logged in successfully!',
      data: { token: signToken(user), user },
    });
  } catch (error) {
    if (/invalid email or password/i.test(error.message)) return fail(res, 401, error.message);
    return next(error);
  }
};

// @route GET /api/auth/me
export const getMe = async (req, res) => res.json({ success: true, data: req.user });

/* The onboarding panel signs in against the same accounts but reads a
   different response shape (`valid`, `employee`), so both are served rather
   than making the client branch. */
// @route POST /api/auth/onboarding-login  |  POST /api/auth/verify-employee
export const onboardingLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return fail(res, 400, 'Please provide both email and password for employee verification.', { valid: false });
    }

    const user = await dbStore.authenticateUser(email, password);

    return res.json({
      success: true,
      valid: true,
      message: 'Employee authentication verified successfully.',
      data: {
        token: signToken(user),
        employee: {
          userId: user.userId,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
        },
      },
    });
  } catch (error) {
    if (/invalid email or password/i.test(error.message)) {
      return fail(res, 401, 'Employee verification failed. Invalid credentials.', { valid: false });
    }
    return next(error);
  }
};

// @route POST /api/auth/verify-token
export const verifyEmployeeToken = async (req, res, next) => {
  try {
    const token = readToken(req);
    if (!token) return fail(res, 400, 'Authorization token is required.', { valid: false });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await dbStore.findUserById(decoded.userId);
    if (!user) return fail(res, 404, 'Employee account not found.', { valid: false });

    return res.json({
      success: true,
      valid: true,
      message: 'Employee token is valid.',
      data: { employee: user },
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return fail(res, 401, 'Invalid or expired authentication token.', { valid: false });
    }
    return next(error);
  }
};

export default { register, login, getMe, onboardingLogin, verifyEmployeeToken };
