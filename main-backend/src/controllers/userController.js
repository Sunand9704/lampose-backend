import dbStore from '../storage/dbStore.js';

const fail = (res, status, message) => res.status(status).json({
  success: false,
  message,
  error: message,
});

// @route GET /api/users
export const getUsers = async (req, res, next) => {
  try {
    const users = await dbStore.getUsers();
    return res.json({ success: true, count: users.length, data: users });
  } catch (error) {
    return next(error);
  }
};

// @route POST /api/users
export const createUser = async (req, res, next) => {
  try {
    const { name, email, password = 'employee123', role = 'EMPLOYEE', avatar } = req.body || {};

    if (!name || !email) {
      return fail(res, 400, 'Both "name" and "email" are required.');
    }
    if (String(password).length < 6) {
      return fail(res, 400, 'Password must be at least 6 characters long.');
    }

    const user = await dbStore.createUser({ name, email, password, role, avatar });
    return res.status(201).json({ success: true, message: 'User created successfully', data: user });
  } catch (error) {
    if (/already exists/i.test(error.message)) return fail(res, 409, error.message);
    return next(error);
  }
};

// @route DELETE /api/users/:userId
export const deleteUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!userId) return fail(res, 400, 'User ID is required.');

    /* Deleting the account you are signed in as leaves a valid token pointing
       at nothing, and the next request logs you out with a confusing
       "account no longer exists". */
    if (req.user && req.user.userId === userId) {
      return fail(res, 400, 'You cannot delete the account you are signed in with.');
    }

    const deleted = await dbStore.deleteUser(userId);
    if (!deleted) return fail(res, 404, 'User account not found.');

    return res.json({ success: true, message: 'User account deleted successfully.' });
  } catch (error) {
    return next(error);
  }
};

export default { getUsers, createUser, deleteUser };
