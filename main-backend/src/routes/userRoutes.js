import express from 'express';
import { getUsers, createUser, deleteUser } from '../controllers/userController.js';
import { protect, protectRole } from '../middleware/authMiddleware.js';
import { requireScriperStore } from '../middleware/requireDb.js';

const router = express.Router();

router.use(requireScriperStore);

/* These were open in the original backend: anyone who knew the host could
   list the team, create an account or delete one. Every caller is a page
   behind the panel's login and sends a bearer token already, so requiring one
   changes nothing for them. REQUIRE_AUTH=false restores the old behaviour. */
router.get('/', protect, getUsers);
router.post('/', protect, protectRole('ADMIN'), createUser);
router.delete('/:userId', protect, protectRole('ADMIN'), deleteUser);

export default router;
