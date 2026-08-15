const dotenv = require('dotenv');
dotenv.config();

const { connectDB } = require('./config/db');
const Admin = require('./models/Admin');

const seedSuperAdmin = async () => {
  try {
    await connectDB();

    const existingSuperAdmin = await Admin.findOne({ role: 'Super Admin' });
    if (existingSuperAdmin) {
      console.log(`ℹ️ [Seed] Super Admin already exists: ${existingSuperAdmin.email}`);
      process.exit(0);
    }

    const superAdmin = await Admin.create({
      name: 'Sarah Connor (Super Admin)',
      email: 'superadmin@lampose.io',
      password: 'SuperAdmin@123',
      role: 'Super Admin',
      status: 'Active',
    });

    console.log(`🎉 [Seed Success] Created Super Admin account: ${superAdmin.email}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ [Seed Error]', error);
    process.exit(1);
  }
};

seedSuperAdmin();
