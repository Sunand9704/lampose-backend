const express = require('express');
const { getUsers, createUser, deleteUser } = require('../../controllers/userController');
const { protect, protectRole } = require('../../middleware/authMiddleware');
const { requireScriperStore, requireAuthConfig } = require('../../middleware/requireDb');

const router = express.Router();

router.use(requireAuthConfig);
router.use(requireScriperStore);

/* These were open in the original backend: anyone who knew the host could
   list the team, create an account or delete one. Every caller is a page
   behind the panel's login and sends a bearer token already, so requiring one
   changes nothing for them. REQUIRE_AUTH=false restores the old behaviour. */
router.get('/', protect, getUsers);
router.post('/', protect, protectRole('ADMIN'), createUser);
router.delete('/:userId', protect, protectRole('ADMIN'), deleteUser);

module.exports = router;
