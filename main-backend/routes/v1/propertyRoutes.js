const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Property = require('../../models/Property');
const VerificationRequest = require('../../models/VerificationRequest');
const crypto = require('crypto');
const { sendVerificationMessage } = require('../../config/twilio');
const { getIsInMemory, getMemoryStore } = require('../../config/db');
const permissionStore = require('../../services/permissionStore');

const multer = require('multer');
const cloudinary = require('cloudinary').v2;

// The in-memory store is a failover for a database outage only. It is NOT
// pre-seeded with sample listings — an empty database must read as empty
// rather than as fabricated inventory.
let inMemoryStore = getMemoryStore();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

/**
 * Gate a destructive write behind an administrator's approval.
 *
 * The onboarding app identifies itself with `x-employee-email` on every edit
 * and delete; such a call is refused unless an administrator has granted that
 * exact employee permission for that exact listing. Requests without the header
 * come from the admin console, which is already behind an administrator login,
 * so they pass through. The grant is returned so the caller can close it once
 * the write actually lands.
 */
const authorizeEmployeeWrite = async (req, action, propertyId) => {
  const employeeEmail = permissionStore.normalizeEmail(req.headers['x-employee-email']);
  if (!employeeEmail) return { allowed: true, grant: null, employeeEmail: '' };

  const grant = await permissionStore.findActiveGrant(String(propertyId), employeeEmail, action);
  if (!grant) {
    console.warn(`   🚫 [Permission Denied] "${employeeEmail}" has no active ${action} grant for ${propertyId}`);
    return {
      allowed: false,
      employeeEmail,
      message: `You do not have permission to ${action} this listing. Use "Ask Permission" and wait for an administrator to approve the request.`,
    };
  }

  console.log(`   🔓 [Permission Verified] Grant ${grant._id} authorises "${employeeEmail}" to ${action} ${propertyId}`);
  return { allowed: true, grant, employeeEmail };
};

// @route   POST /api/properties/upload-image
// @desc    Upload single image to Cloudinary and return secure URL
router.post('/upload-image', upload.single('image'), async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n☁️  [${timestamp}] [Cloudinary Upload] Single image upload initiated...`);

  try {
    let dataUri;
    let originalName = 'uploaded_image';
    let sizeBytes = 0;

    if (req.file) {
      const mime = req.file.mimetype || 'image/jpeg';
      sizeBytes = req.file.size || req.file.buffer.length;
      originalName = req.file.originalname || originalName;
      dataUri = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
      console.log(`   📄 File: "${originalName}" | Type: ${mime} | Size: ${(sizeBytes / 1024).toFixed(1)} KB`);
    } else if (req.body && req.body.image) {
      dataUri = req.body.image.startsWith('data:')
        ? req.body.image
        : `data:image/jpeg;base64,${req.body.image}`;
      console.log(`   📄 Payload: Base64 Data URI string received`);
    } else {
      console.warn(`   ⚠️ [Upload Rejected] No file or image payload found in request body.`);
      return res.status(400).json({ success: false, error: 'No image file provided' });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'ozbu2jhp';
    const apiKey = process.env.CLOUDINARY_API_KEY || '785979326795591';
    const apiSecret = process.env.CLOUDINARY_API_SECRET || '1EDPPk-MX49n0nZogTk4bgrJfCI';

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret
    });

    console.log(`   ⏳ Uploading to Cloudinary account: "${cloudName}" (Folder: "lampose_accommodations")...`);
    const uploadStart = Date.now();

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'lampose_accommodations',
      resource_type: 'auto'
    });

    const duration = Date.now() - uploadStart;
    console.log(`   ✅ [Cloudinary Success] Stored in ${duration}ms!`);
    console.log(`   🔗 Secure URL: ${result.secure_url}`);
    console.log(`   🆔 Public ID:  ${result.public_id}\n`);

    res.json({
      success: true,
      message: 'Image uploaded to Cloudinary successfully!',
      url: result.secure_url,
      urls: [result.secure_url],
      public_id: result.public_id
    });
  } catch (err) {
    console.error(`   ❌ [Cloudinary Upload Error]:`, err.message || err);
    res.status(500).json({ success: false, error: 'Cloudinary Upload Failed', message: err.message });
  }
});

// @route   POST /api/properties/upload-images
// @desc    Batch upload multiple images (up to 10) to Cloudinary and return array of secure URLs
router.post('/upload-images', upload.array('images', 10), async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n☁️  [${timestamp}] [Cloudinary Batch Upload] Starting batch image processing...`);

  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'ozbu2jhp';
    const apiKey = process.env.CLOUDINARY_API_KEY || '785979326795591';
    const apiSecret = process.env.CLOUDINARY_API_SECRET || '1EDPPk-MX49n0nZogTk4bgrJfCI';

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret
    });

    let dataUris = [];

    if (req.files && req.files.length > 0) {
      console.log(`   📦 Received ${req.files.length} multipart file(s) for upload:`);
      dataUris = req.files.map((file, idx) => {
        const mime = file.mimetype || 'image/jpeg';
        const kb = ((file.size || file.buffer.length) / 1024).toFixed(1);
        console.log(`      [#${idx + 1}] "${file.originalname}" (${mime}, ${kb} KB)`);
        return `data:${mime};base64,${file.buffer.toString('base64')}`;
      });
    } else if (req.body && Array.isArray(req.body.images)) {
      console.log(`   📦 Received ${req.body.images.length} Base64 image strings in JSON body.`);
      dataUris = req.body.images.map(img => {
        return img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`;
      });
    } else if (req.body && req.body.image) {
      console.log(`   📦 Received single image string in JSON body.`);
      const img = req.body.image;
      dataUris = [img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`];
    } else {
      console.warn(`   ⚠️ [Batch Upload Rejected] No files provided in "images" field.`);
      return res.status(400).json({ success: false, error: 'No image files provided for upload' });
    }

    console.log(`   ⏳ Sending ${dataUris.length} photos concurrently to Cloudinary folder "lampose_accommodations"...`);
    const batchStart = Date.now();

    const uploadPromises = dataUris.map(dataUri =>
      cloudinary.uploader.upload(dataUri, {
        folder: 'lampose_accommodations',
        resource_type: 'auto'
      })
    );

    const results = await Promise.all(uploadPromises);
    const urls = results.map(r => r.secure_url);
    const duration = Date.now() - batchStart;

    console.log(`   ✅ [Batch Cloudinary Success] ${urls.length} photos stored in ${duration}ms!`);
    urls.forEach((u, i) => console.log(`      [#${i + 1}] ${u}`));
    console.log('');

    res.json({
      success: true,
      message: `${urls.length} image(s) uploaded to Cloudinary successfully!`,
      urls,
      url: urls[0] || ''
    });
  } catch (err) {
    console.error(`   ❌ [Batch Cloudinary Upload Error]:`, err.message || err);
    res.status(500).json({ success: false, error: 'Cloudinary Batch Upload Failed', message: err.message });
  }
});

// @route   GET /api/properties
// @desc    Get all properties (with optional filter by category, search, place, stayType)
router.get('/', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  try {
    const { category, search, place, stayType, includeUnverified } = req.query;
    console.log(`\n📋 [${timestamp}] [API GET /properties] Query filters -> category: "${category || 'All'}", search: "${search || 'None'}"`);

    if (getIsInMemory()) {
      let filtered = [...inMemoryStore];
      global.pendingInMemoryProperties = global.pendingInMemoryProperties || [];
      
      // Combine active and pending properties
      let combined = [];
      if (includeUnverified !== 'true') {
        combined = [...global.pendingInMemoryProperties, ...filtered];
      } else {
        combined = [...filtered];
      }

      if (category && category !== 'All') {
        combined = combined.filter(p => p.category.toLowerCase() === category.toLowerCase());
      }
      if (stayType && stayType !== 'All') {
        combined = combined.filter(p => p.stayType && p.stayType.toLowerCase().includes(stayType.toLowerCase()));
      }
      if (search) {
        const q = search.toLowerCase();
        combined = combined.filter(
          p =>
            p.name.toLowerCase().includes(q) ||
            p.place.toLowerCase().includes(q) ||
            p.ownerName.toLowerCase().includes(q)
        );
      }

      console.log(`   📊 [In-Memory Mode] Returning ${combined.length} property listing(s)`);
      return res.json({
        success: true,
        count: combined.length,
        data: combined
      });
    }

    // MongoDB Mode
    // 1. Fetch verified properties
    const verifiedQuery = { verificationStatus: 'verified' };
    if (category && category !== 'All') {
      verifiedQuery.category = category;
    }
    if (stayType && stayType !== 'All') {
      verifiedQuery.stayType = { $regex: stayType, $options: 'i' };
    }
    if (place) {
      verifiedQuery.place = { $regex: place, $options: 'i' };
    }
    if (search) {
      verifiedQuery.$or = [
        { name: { $regex: search, $options: 'i' } },
        { place: { $regex: search, $options: 'i' } },
        { ownerName: { $regex: search, $options: 'i' } }
      ];
    }
    const verifiedProps = await Property.find(verifiedQuery).sort({ createdAt: -1 });

    // 2. Fetch pending properties from VerificationRequests
    let pendingProps = [];
    if (includeUnverified !== 'true') {
      const pendingQuery = { status: { $in: ['sent', 'pending', 'failed'] } };
      const pendingRequests = await VerificationRequest.find(pendingQuery).sort({ createdAt: -1 });
      
      pendingProps = pendingRequests
        .filter(r => r.pendingPropertyData)
        .map(r => ({
          ...r.pendingPropertyData,
          verificationStatus: 'pending',
          isVerified: false
        }));

      // Apply query filters to pending properties
      if (category && category !== 'All') {
        pendingProps = pendingProps.filter(p => p.category === category);
      }
      if (stayType && stayType !== 'All') {
        pendingProps = pendingProps.filter(p => p.stayType && p.stayType.toLowerCase().includes(stayType.toLowerCase()));
      }
      if (place) {
        pendingProps = pendingProps.filter(p => p.place && p.place.toLowerCase().includes(place.toLowerCase()));
      }
      if (search) {
        const q = search.toLowerCase();
        pendingProps = pendingProps.filter(
          p =>
            p.name.toLowerCase().includes(q) ||
            p.place.toLowerCase().includes(q) ||
            p.ownerName.toLowerCase().includes(q)
        );
      }
    }

    // Combine both arrays (pending properties first)
    const combined = [...pendingProps, ...verifiedProps];
    console.log(`   📊 [MongoDB Mode] Returning ${combined.length} property listing(s) (${verifiedProps.length} verified, ${pendingProps.length} pending)`);

    res.json({
      success: true,
      count: combined.length,
      data: combined
    });
  } catch (err) {
    console.error(`   ❌ [GET /properties Error]:`, err.message);
    res.status(500).json({ success: false, error: 'Server Error fetching properties', message: err.message });
  }
});

// @route   GET /api/properties/:id
// @desc    Get single property details
router.get('/:id', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  const { id } = req.params;
  console.log(`\n🔍 [${timestamp}] [API GET /properties/${id}] Fetching property details...`);

  try {
    if (getIsInMemory()) {
      const property = inMemoryStore.find(p => p._id === id);
      if (!property) {
        console.warn(`   ⚠️ Property with ID "${id}" not found in memory store`);
        return res.status(404).json({ success: false, error: 'Property not found' });
      }
      return res.json({ success: true, data: property });
    }

    const property = await Property.findById(id);
    if (!property) {
      console.warn(`   ⚠️ Property with ID "${id}" not found in MongoDB`);
      return res.status(404).json({ success: false, error: 'Property not found' });
    }

    console.log(`   ✅ Loaded details for: "${property.name}" (${property.category})`);
    res.json({ success: true, data: property });
  } catch (err) {
    console.error(`   ❌ [GET /properties/${id} Error]:`, err.message);
    res.status(500).json({ success: false, error: 'Server Error', message: err.message });
  }
});

// @route   POST /api/properties
// @desc    Create a new property onboarding entry
router.post('/', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n📝 [${timestamp}] [API POST /properties] Onboarding new accommodation...`);

  try {
    const {
      name,
      place,
      ownerName,
      ownerMobile,
      category,
      stayType,
      shortStayDuration,
      dailyPrice,
      longStayDuration,
      monthlyPrice,
      rent,
      deposit,
      address,
      imageUrl,
      images,
      employeeEmail,
      amenities,
      categoryDetails
    } = req.body;

    const assignedEmpEmail = employeeEmail || req.headers['x-user-email'] || 'N/A';

    console.log(`\n========================================================================`);
    console.log(`📝 [NEW ONBOARDING SUBMISSION] ${timestamp}`);
    console.log(`🏠 Property Name:    "${name}"`);
    console.log(`📍 Place / Location: "${place}"`);
    console.log(`🏷️  Category:         ${category} (${stayType || 'Long Stay'})`);
    console.log(`👤 Owner Name:       "${ownerName}"`);
    console.log(`📞 Owner Mobile:     "${ownerMobile}"`);
    console.log(`👨‍💼 Onboarded By:     "${assignedEmpEmail}"`);
    console.log(`💰 Pricing:          Monthly: ₹${monthlyPrice || rent || 0} | Daily: ₹${dailyPrice || 0} | Deposit: ₹${deposit || 0}`);
    console.log(`✨ Amenities:        ${Array.isArray(amenities) && amenities.length > 0 ? amenities.join(', ') : 'None'}`);
    console.log(`========================================================================`);

    // Validation
    if (!name || !place || !ownerName || !ownerMobile || !category) {
      console.warn(`   ⚠️ [Validation Failed] Missing mandatory fields.`);
      return res.status(400).json({
        success: false,
        error: 'Missing mandatory fields: Name, Place, Owner Name, Owner Mobile No, and Category are required.'
      });
    }

    const validCategories = ['PG', 'Hostel', 'Dormitory', 'Bachelor Room'];
    if (!validCategories.includes(category)) {
      console.warn(`   ⚠️ [Validation Failed] Invalid category: "${category}".`);
      return res.status(400).json({
        success: false,
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}`
      });
    }

    const determinedRent = rent !== undefined ? Number(rent) : (monthlyPrice || dailyPrice || 0);

    const determinedImages = Array.isArray(images) && images.length > 0
      ? images
      : (imageUrl ? [imageUrl] : ['/lampose-logo-splash.png']);

    console.log(`   📸 Image Gallery: Storing ${determinedImages.length} photo(s)`);
    determinedImages.forEach((img, i) => console.log(`      [#${i + 1}] ${img}`));

    const newPropertyData = {
      name,
      place,
      ownerName,
      ownerMobile,
      category,
      employeeEmail: assignedEmpEmail !== 'N/A' ? assignedEmpEmail : '',
      stayType: stayType || 'Long Stay',
      shortStayDuration: shortStayDuration || '1-7 Days',
      dailyPrice: Number(dailyPrice || 0),
      longStayDuration: longStayDuration || '1 Month+',
      monthlyPrice: Number(monthlyPrice || 0),
      rent: determinedRent,
      deposit: Number(deposit || 0),
      address: address || '',
      imageUrl: determinedImages[0] || imageUrl || '/lampose-logo-splash.png',
      images: determinedImages,
      amenities: Array.isArray(amenities) ? amenities : [],
      categoryDetails: categoryDetails || {},
      isVerified: false,
      verificationStatus: 'pending'
    };

    let propertyId;
    let property;

    if (getIsInMemory()) {
      propertyId = 'prop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      property = {
        _id: propertyId,
        ...newPropertyData,
        createdAt: new Date().toISOString()
      };
      console.log(`   ✅ [In-Memory Pending] Property prepared with ID: ${propertyId}`);
    } else {
      propertyId = new mongoose.Types.ObjectId();
      property = {
        _id: propertyId,
        ...newPropertyData
      };
      console.log(`   ✅ [MongoDB Pending] Property prepared with virtual ID: ${propertyId}`);
    }

    // Trigger Twilio WhatsApp Verification
    console.log(`   💬 [Twilio Verification] Sending verification WhatsApp to owner mobile: ${ownerMobile}...`);
    const twilioResult = await sendVerificationMessage(ownerMobile, ownerName, name);

    // Create Verification Request
    const { formatWhatsAppNumber } = require('../../config/twilio');
    const ownerMobileE164 = formatWhatsAppNumber(ownerMobile) || ownerMobile;
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    const verificationPayload = {
      property: getIsInMemory() ? undefined : propertyId,
      ownerMobileE164,
      token,
      status: twilioResult.success ? 'sent' : 'failed',
      lastError: twilioResult.success ? '' : (twilioResult.error || 'Twilio send failed'),
      attempts: 1,
      sentAt: twilioResult.success ? new Date() : null,
      expiresAt,
      pendingPropertyData: property
    };

    if (!getIsInMemory()) {
      try {
        await VerificationRequest.create(verificationPayload);
        console.log(`   ✅ [Verification Created] Document saved in DB with pendingPropertyData.`);
      } catch (dbErr) {
        console.error(`   ❌ [Verification DB Error]: Failed to save verification request:`, dbErr.message);
      }
    } else {
      global.pendingInMemoryProperties = global.pendingInMemoryProperties || [];
      global.pendingInMemoryProperties.push(property);
      console.log(`   ℹ️ [In-Memory Mode] Verification request simulation:`, verificationPayload);
    }

    console.log(`========================================================================\n`);

    res.status(201).json({
      success: true,
      message: 'Property onboarding submitted! A verification request has been sent to the owner.',
      data: property
    });
  } catch (err) {
    console.error(`   ❌ [POST /properties Error]:`, err.message);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(val => val.message);
      return res.status(400).json({ success: false, error: messages.join(', ') });
    }
    res.status(500).json({ success: false, error: 'Server Error onboarding property', message: err.message });
  }
});

// @route   PUT /api/properties/:id
// @desc    Update an existing property
router.put('/:id', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  const { id } = req.params;
  console.log(`\n✏️  [${timestamp}] [API PUT /properties/${id}] Updating property...`);

  try {
    const gate = await authorizeEmployeeWrite(req, 'edit', id);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, error: gate.message, requiresPermission: true, action: 'edit' });
    }

    if (getIsInMemory()) {
      const index = inMemoryStore.findIndex(p => p._id === id);
      if (index === -1) {
        return res.status(404).json({ success: false, error: 'Property not found' });
      }
      inMemoryStore[index] = { ...inMemoryStore[index], ...req.body, updatedAt: new Date().toISOString() };
      console.log(`   ✅ [In-Memory Updated] Property ID: ${id}`);
      if (gate.grant) await permissionStore.markUsed(gate.grant._id);
      return res.json({ success: true, message: 'Property updated successfully', data: inMemoryStore[index] });
    }

    const property = await Property.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
    if (!property) {
      return res.status(404).json({ success: false, error: 'Property not found' });
    }
    console.log(`   ✅ [MongoDB Updated] Property ID: ${id}`);
    if (gate.grant) await permissionStore.markUsed(gate.grant._id);
    res.json({ success: true, message: 'Property updated successfully', data: property });
  } catch (err) {
    console.error(`   ❌ [PUT /properties/${id} Error]:`, err.message);
    res.status(500).json({ success: false, error: 'Server Error updating property', message: err.message });
  }
});

// @route   DELETE /api/properties/:id
// @desc    Delete a property
router.delete('/:id', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  const { id } = req.params;
  console.log(`\n🗑️  [${timestamp}] [API DELETE /properties/${id}] Deleting property...`);

  try {
    const gate = await authorizeEmployeeWrite(req, 'delete', id);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, error: gate.message, requiresPermission: true, action: 'delete' });
    }

    if (getIsInMemory()) {
      const index = inMemoryStore.findIndex(p => p._id === id);
      if (index === -1) {
        return res.status(404).json({ success: false, error: 'Property not found' });
      }
      const deleted = inMemoryStore.splice(index, 1);
      console.log(`   ✅ [In-Memory Deleted] Property ID: ${id} ("${deleted[0].name}")`);
      if (gate.grant) await permissionStore.markUsed(gate.grant._id);
      return res.json({ success: true, message: 'Property deleted successfully', data: deleted[0] });
    }

    const property = await Property.findByIdAndDelete(id);
    if (!property) {
      return res.status(404).json({ success: false, error: 'Property not found' });
    }
    console.log(`   ✅ [MongoDB Deleted] Property ID: ${id} ("${property.name}")`);
    if (gate.grant) await permissionStore.markUsed(gate.grant._id);
    res.json({ success: true, message: 'Property deleted successfully', data: property });
  } catch (err) {
    console.error(`   ❌ [DELETE /properties/${id} Error]:`, err.message);
    res.status(500).json({ success: false, error: 'Server Error deleting property', message: err.message });
  }
});

module.exports = router;
