import express from 'express';
import {
  register,
  login,
  getMe,
  onboardingLogin,
  verifyEmployeeToken,
} from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { requireScriperStore } from '../middleware/requireDb.js';

const router = express.Router();

/* Every route here reads or writes the user collection, so a disconnected
   store must answer 503 rather than hang on a buffered query and then return
   a timeout that names nothing. */
router.use(requireScriperStore);

router.post('/register', register);
router.post('/login', login);
router.post('/onboarding-login', onboardingLogin);
// Same handler under the name the onboarding panel calls it by.
router.post('/verify-employee', onboardingLogin);
router.post('/verify-token', verifyEmployeeToken);

/* Always guarded, regardless of REQUIRE_AUTH: "who am I" has no meaning
   without a token, and the panel treats a failure here as a signed-out
   session. */
router.get('/me', authMiddleware, getMe);

export default router;
