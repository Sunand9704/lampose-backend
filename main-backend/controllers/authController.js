/* Authentication for the leads panel's accounts (`scriper_users`).

   Separate from /api/v1/admin/login, which authenticates the onboarding
   admin console against the `admins` collection. Two identity systems, one
   process, on purpose — see middleware/authMiddleware.js. */
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const dbStore = require('../storage/dbStore');
const { JWT_SECRET, signToken, readToken } = require('../middleware/authMiddleware');

const fail = (res, status, message, extra = {}) => res.status(status).json({
  success: false,
  message,
  error: message,
  ...extra,
});

// @route POST /api/v2/auth/register
const register = async (req, res, next) => {
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

// @route POST /api/v2/auth/login
const login = async (req, res, next) => {
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

// @route GET /api/v2/auth/me
const getMe = async (req, res) => res.json({ success: true, data: req.user });

/* The onboarding app signs in against these same accounts but reads a
   different response shape (`valid`, `employee`), so both are served rather
   than making the client branch. This is the endpoint
   onboards-frontend/src/services/auth.js posts to. */
// @route POST /api/v2/auth/onboarding-login  |  POST /api/v2/auth/verify-employee
const onboardingLogin = async (req, res, next) => {
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

// @route POST /api/v2/auth/verify-token
const verifyEmployeeToken = async (req, res, next) => {
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

module.exports = { register, login, getMe, onboardingLogin, verifyEmployeeToken };
