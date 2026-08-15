const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Admin = require('../../models/Admin');

// Helper to generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'lampose_jwt_secret_key_9982', {
    expiresIn: '30d',
  });
};

/**
 * @route   POST /api/admin/register
 * @desc    Register a new Admin with Mandatory Backend Secret Key
 * @access  Public (Secret Protected)
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, adminSecretKey } = req.body;

    if (!name || !email || !password || !adminSecretKey) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, password, and mandatory Admin Secret Key are required.',
      });
    }

    /* MANDATORY SECRET KEY CHECK AGAINST BACKEND .ENV
       V1_ADMIN_SECRET_KEY, not ADMIN_SECRET_KEY. The latter now guards ADMIN
       registration on the *other* identity system (/api/v2/auth/register,
       scriper_users), and this route used to fall through to the literal
       below because nothing set it. Reading the shared name here would mean
       that adding the v2 key silently changed the key the admin console
       needs — a lockout with no error message that names the cause. */
    const envSecretKey = process.env.V1_ADMIN_SECRET_KEY || 'lampose_admin_secret_2026';
    if (adminSecretKey.trim() !== envSecretKey.trim()) {
      console.warn(`⚠️ [Admin Register] Secret key mismatch attempt for email: ${email}`);
      return res.status(403).json({
        success: false,
        message: 'Invalid Mandatory Admin Secret Key. Please provide a valid admin secret key.',
      });
    }

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ email: email.toLowerCase() });
    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: 'An administrator account with this email address already exists.',
      });
    }

    // Create new Admin account in MongoDB Atlas
    const newAdmin = await Admin.create({
      name,
      email: email.toLowerCase(),
      password,
      role: role || 'Admin',
      status: 'Active',
      lastLogin: new Date().toLocaleTimeString() + ' ' + new Date().toLocaleDateString(),
    });

    const token = generateToken(newAdmin._id);

    console.log(`✅ [Admin Registered] Created ${newAdmin.role}: ${newAdmin.email}`);

    return res.status(201).json({
      success: true,
      message: 'Admin registered successfully.',
      token,
      user: {
        id: newAdmin._id.toString(),
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
        status: newAdmin.status,
        avatar: newAdmin.avatar,
        createdAt: newAdmin.createdAt,
        lastLogin: newAdmin.lastLogin,
      },
    });
  } catch (error) {
    console.error('❌ [Admin Register Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error during registration.',
    });
  }
});

/**
 * @route   POST /api/admin/login
 * @desc    Authenticate Admin & Get JWT Token
 * @access  Public
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password.',
      });
    }

    // Find admin in MongoDB database
    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password credentials.',
      });
    }

    // Verify password match
    const isMatch = await admin.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password credentials.',
      });
    }

    // Update last login
    admin.lastLogin = 'Just now';
    await admin.save();

    const token = generateToken(admin._id);

    console.log(`🔑 [Admin Login Success] ${admin.role}: ${admin.email}`);

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: admin._id.toString(),
        name: admin.name,
        email: admin.email,
        role: admin.role,
        status: admin.status,
        avatar: admin.avatar,
        createdAt: admin.createdAt,
        lastLogin: admin.lastLogin,
      },
    });
  } catch (error) {
    console.error('❌ [Admin Login Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error during login.',
    });
  }
});

/**
 * @route   GET /api/admin/users
 * @desc    Fetch real admin users from MongoDB database
 * @access  Public / Admin
 */
router.get('/users', async (req, res) => {
  try {
    const { search, status, role } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    if (status && status !== 'All') {
      query.status = status;
    }

    if (role && role !== 'All') {
      query.role = role;
    }

    const admins = await Admin.find(query).select('-password').sort({ createdAt: -1 });

    const formattedAdmins = admins.map((a) => ({
      id: a._id.toString(),
      name: a.name,
      email: a.email,
      role: a.role,
      status: a.status,
      avatar: a.avatar,
      createdAt: a.createdAt ? a.createdAt.toISOString() : null,
      lastLogin: a.lastLogin,
    }));

    return res.json({
      items: formattedAdmins,
      total: formattedAdmins.length,
      page: 1,
      pageSize: 50,
      totalPages: 1,
    });
  } catch (error) {
    console.error('❌ [Admin Fetch Users Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error fetching admins from database.',
    });
  }
});

/**
 * @route   POST /api/admin/users
 * @desc    Super Admin creates a new admin user directly in MongoDB
 * @access  Public / Admin
 */
router.post('/users', async (req, res) => {
  try {
    const { name, email, password, role, status } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: 'Name and email are required.',
      });
    }

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An administrator with this email already exists.',
      });
    }

    const newAdmin = await Admin.create({
      name,
      email: email.toLowerCase(),
      password: password || 'LamposePass@123',
      role: role || 'Admin',
      status: status || 'Active',
    });

    return res.status(201).json({
      id: newAdmin._id.toString(),
      name: newAdmin.name,
      email: newAdmin.email,
      role: newAdmin.role,
      status: newAdmin.status,
      avatar: newAdmin.avatar,
      createdAt: newAdmin.createdAt.toISOString(),
      lastLogin: newAdmin.lastLogin,
    });
  } catch (error) {
    console.error('❌ [Create Admin User Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error creating user in database.',
    });
  }
});

/**
 * @route   PUT /api/admin/users/:id
 * @desc    Update an administrator's role or status in MongoDB
 * @access  Public / Admin
 */
router.put('/users/:id', async (req, res) => {
  try {
    const { name, role, status } = req.body;

    const updated = await Admin.findByIdAndUpdate(
      req.params.id,
      {
        ...(name && { name }),
        ...(role && { role }),
        ...(status && { status }),
      },
      { new: true, runValidators: true }
    ).select('-password');

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Administrator not found.' });
    }

    console.log(`✏️ [Admin Updated] ${updated.email} → ${updated.role} / ${updated.status}`);

    return res.json({
      id: updated._id.toString(),
      name: updated.name,
      email: updated.email,
      role: updated.role,
      status: updated.status,
      avatar: updated.avatar,
      createdAt: updated.createdAt ? updated.createdAt.toISOString() : null,
      lastLogin: updated.lastLogin,
    });
  } catch (error) {
    console.error('❌ [Update Admin User Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error updating administrator.',
    });
  }
});

/**
 * @route   DELETE /api/admin/users/:id
 * @desc    Super Admin deletes an admin user from MongoDB
 * @access  Public / Admin
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Admin.findByIdAndDelete(id);
    console.log(`🗑️ [Admin Deleted] ID: ${id}`);
    return res.json({ success: true, message: 'Administrator deleted successfully.' });
  } catch (error) {
    console.error('❌ [Delete Admin User Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error deleting admin from database.',
    });
  }
});

module.exports = router;
