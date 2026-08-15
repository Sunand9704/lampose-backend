const express = require('express');
const {
  register,
  login,
  getMe,
  onboardingLogin,
  verifyEmployeeToken,
} = require('../../controllers/authController');
const { authMiddleware } = require('../../middleware/authMiddleware');
const { requireScriperStore, requireAuthConfig } = require('../../middleware/requireDb');

const router = express.Router();

/* Nothing here can work without a signing key, and issuing a token signed
   with a blank secret is worse than refusing. Only ever trips when
   JWT_SECRET is missing in production. */
router.use(requireAuthConfig);

/* Every route reads or writes the user collection, so a disconnected store
   must answer 503 rather than hang on a buffered query and then return a
   timeout that names nothing. */
router.use(requireScriperStore);

router.post('/register', register);
router.post('/login', login);

/* The onboarding app posts here (onboards-frontend/src/services/auth.js).
   Same accounts as /login, different response shape. */
router.post('/onboarding-login', onboardingLogin);
router.post('/verify-employee', onboardingLogin);
router.post('/verify-token', verifyEmployeeToken);

/* Always guarded, regardless of REQUIRE_AUTH: "who am I" has no meaning
   without a token, and the panel treats a failure here as a signed-out
   session. */
router.get('/me', authMiddleware, getMe);

module.exports = router;
