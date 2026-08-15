const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const twilio = require('twilio');
const VerificationRequest = require('../../models/VerificationRequest');
const Property = require('../../models/Property');
const { getIsInMemory, getMemoryStore } = require('../../config/db');

/**
 * @route   GET /api/verifications
 * @desc    Fetch all verification requests from MongoDB Atlas
 * @access  Public / Admin
 */
router.get('/', async (req, res) => {
  try {
    const { search, status } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { ownerMobileE164: { $regex: search, $options: 'i' } },
        { token: { $regex: search, $options: 'i' } },
        { lastError: { $regex: search, $options: 'i' } },
      ];
    }

    if (status && status !== 'All') {
      query.status = status;
    }

    const items = await VerificationRequest.find(query)
      .sort({ createdAt: -1 })
      .populate('property', 'name category place ownerName');

    return res.json({
      success: true,
      count: items.length,
      data: items,
      items: items, // Dual format for frontend compatibility
    });
  } catch (error) {
    console.error('❌ [GET /api/verifications Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error fetching verification requests.',
    });
  }
});

/**
 * @route   POST /api/verifications
 * @desc    Create a new verification request in MongoDB Atlas
 * @access  Public / Admin
 */
router.post('/', async (req, res) => {
  try {
    const { ownerMobileE164, status, lastError, attempts } = req.body;

    if (!ownerMobileE164) {
      return res.status(400).json({
        success: false,
        message: 'Owner mobile number is required.',
      });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const newRequest = await VerificationRequest.create({
      ownerMobileE164,
      token,
      status: status || 'pending',
      lastError: lastError || '',
      attempts: attempts || 1,
      expiresAt,
    });

    console.log(`✅ [Verification Created] ID: ${newRequest._id} | Mobile: ${ownerMobileE164}`);

    return res.status(201).json({
      success: true,
      data: newRequest,
    });
  } catch (error) {
    console.error('❌ [POST /api/verifications Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error creating verification request.',
    });
  }
});

/**
 * @route   PUT /api/verifications/:id
 * @desc    Update a verification request in MongoDB Atlas
 * @access  Public / Admin
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, attempts, lastError, ownerMobileE164 } = req.body;

    const updated = await VerificationRequest.findByIdAndUpdate(
      id,
      {
        ...(status && { status }),
        ...(attempts !== undefined && { attempts }),
        ...(lastError !== undefined && { lastError }),
        ...(ownerMobileE164 && { ownerMobileE164 }),
        ...(status === 'verified' && { respondedAt: new Date() }),
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Verification request not found.' });
    }

    console.log(`✏️ [Verification Updated] ID: ${id} | Status: ${updated.status}`);

    return res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    console.error('❌ [PUT /api/verifications/:id Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error updating verification request.',
    });
  }
});

/**
 * @route   DELETE /api/verifications/:id
 * @desc    Delete a verification request from MongoDB Atlas
 * @access  Public / Admin
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await VerificationRequest.findByIdAndDelete(id);
    console.log(`🗑️ [Verification Deleted] ID: ${id}`);
    return res.json({
      success: true,
      message: 'Verification request deleted successfully.',
    });
  } catch (error) {
    console.error('❌ [DELETE /api/verifications/:id Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error deleting verification request.',
    });
  }
});

/**
 * @route   POST /api/whatsapp/webhook
 * @route   POST /api/verifications/webhook
 * @desc    Incoming Twilio WhatsApp Webhook for 2-stage verification
 */
router.post('/webhook', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  const { From, Body } = req.body;

  console.log(`\n💬 [Twilio Webhook] Received message from ${From}: "${Body}"`);

  // Initialize Twilio MessagingResponse
  const twiml = new twilio.twiml.MessagingResponse();

  if (!From || !Body) {
    console.warn('⚠️ Webhook received request with missing From or Body payload.');
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    const senderMobile = From.trim(); // contains "whatsapp:+91..."
    const textBody = Body.trim().toLowerCase();

    // Load and parse Verification Team Numbers
    const verifierNumbersStr = process.env.VERIFICATION_TEAM_NUMBERS || '';
    const verifierNumbers = verifierNumbersStr
      .split(',')
      .map(num => num.trim())
      .filter(Boolean);

    const isSenderVerifier = verifierNumbers.includes(senderMobile);

    // ==================== IN-MEMORY MODE ====================
    if (getIsInMemory()) {
      console.log('   ℹ️ [In-Memory Mode] Processing webhook response in-memory...');
      const inMemoryStore = getMemoryStore();
      global.pendingInMemoryProperties = global.pendingInMemoryProperties || [];
      const { formatWhatsAppNumber } = require('../../config/twilio');

      // Check if there is an active owner-approved request assigned to this verifier
      let verifierPendingIdx = -1;
      if (isSenderVerifier) {
        verifierPendingIdx = global.pendingInMemoryProperties.findIndex(p => {
          return p.assignedVerifierMobileE164 === senderMobile && p.verificationStatus === 'owner_approved';
        });
      }

      // Case A: Sender is a Verifier and has a request assigned
      if (isSenderVerifier && verifierPendingIdx !== -1) {
        const prop = global.pendingInMemoryProperties[verifierPendingIdx];

        if (textBody === 'yes' || textBody === 'y') {
          prop.isVerified = true;
          prop.verificationStatus = 'verified';
          inMemoryStore.unshift(prop);
          global.pendingInMemoryProperties.splice(verifierPendingIdx, 1);
          console.log(`   ✅ [In-Memory Team Approved] Property "${prop.name}" verified and live.`);
          twiml.message(`Thank you! Property "${prop.name}" is now listed live on Lampose.`);
        } else if (textBody === 'no' || textBody === 'n') {
          prop.isVerified = false;
          prop.verificationStatus = 'verifier_rejected';

          // Clean Cloudinary images
          const cloudinary = require('cloudinary').v2;
          cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'ozbu2jhp',
            api_key: process.env.CLOUDINARY_API_KEY || '785979326795591',
            api_secret: process.env.CLOUDINARY_API_SECRET || '1EDPPk-MX49n0nZogTk4bgrJfCI'
          });
          const getPublicIdFromUrl = (url) => {
            if (!url || !url.includes('cloudinary.com')) return null;
            try {
              const parts = url.split(/\/image\/upload\/v\d+\/|\/image\/upload\//);
              if (parts.length > 1) {
                const relativePath = parts[1];
                const dotIdx = relativePath.lastIndexOf('.');
                return dotIdx !== -1 ? relativePath.substring(0, dotIdx) : relativePath;
              }
              return null;
            } catch (err) {
              return null;
            }
          };
          const imageUrls = prop.images || (prop.imageUrl ? [prop.imageUrl] : []);
          for (const imgUrl of imageUrls) {
            const pubId = getPublicIdFromUrl(imgUrl);
            if (pubId) {
              try { await cloudinary.uploader.destroy(pubId); } catch (e) {}
            }
          }

          global.pendingInMemoryProperties.splice(verifierPendingIdx, 1);
          console.log(`   ❌ [In-Memory Team Rejected] Property "${prop.name}" onboarding request rejected.`);
          twiml.message(`Understood. Onboarding request for "${prop.name}" rejected.`);
        } else {
          twiml.message(`Hello! Please reply YES to approve "${prop.name}" or NO to reject.`);
        }

        res.type('text/xml');
        return res.send(twiml.toString());
      } else {
        // Case B: Sender is the Owner
        const pendingIdx = global.pendingInMemoryProperties.findIndex(p => {
          return formatWhatsAppNumber(p.ownerMobile) === senderMobile && p.verificationStatus === 'pending';
        });

        if (pendingIdx === -1) {
          twiml.message("Hello from Lampose! We couldn't find any pending onboarding request for this number.");
          res.type('text/xml');
          return res.send(twiml.toString());
        }

        const prop = global.pendingInMemoryProperties[pendingIdx];

        if (textBody === 'yes' || textBody === 'y') {
          prop.verificationStatus = 'owner_approved';
          
          if (verifierNumbers.length > 0) {
            const randomVerifier = verifierNumbers[Math.floor(Math.random() * verifierNumbers.length)];
            prop.assignedVerifierMobileE164 = randomVerifier;
            console.log(`   ✅ [In-Memory Owner Approved] Forwarding details to verifier: ${randomVerifier}`);
            twiml.message("Thanks for the Confirmation, Our Verification team will process Your Request and send you the confirmation after its verify.");
          } else {
            prop.isVerified = true;
            prop.verificationStatus = 'verified';
            inMemoryStore.unshift(prop);
            global.pendingInMemoryProperties.splice(pendingIdx, 1);
            console.warn("   ⚠️ No verifiers set. Auto-verifying in-memory property.");
            twiml.message(`Thanks for choosing Lampose! Your property "${prop.name}" is verified and listed successfully.`);
          }
        } else if (textBody === 'no' || textBody === 'n') {
          prop.isVerified = false;
          prop.verificationStatus = 'rejected';
          global.pendingInMemoryProperties.splice(pendingIdx, 1);
          twiml.message(`Understood. The onboarding request for your property "${prop.name}" has been cancelled. Thank you.`);
        } else {
          twiml.message(`Hello! Please reply with YES to approve the onboarding of "${prop.name}" on Lampose, or NO to reject it.`);
        }

        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

    // ==================== MONGODB DATABASE MODE ====================
    let verification = null;
    if (isSenderVerifier) {
      verification = await VerificationRequest.findOne({
        assignedVerifierMobileE164: senderMobile,
        status: 'owner_approved'
      }).sort({ createdAt: -1 });
    }

    // Case A: Sender is a Verifier and has a request assigned
    if (isSenderVerifier && verification) {
      const pendingProperty = verification.pendingPropertyData;
      const propertyName = pendingProperty ? pendingProperty.name : 'your property';

      if (textBody === 'yes' || textBody === 'y') {
        console.log(`✅ [Verification Approved] Verifier ${senderMobile} approved property: "${propertyName}"`);

        verification.status = 'verified';
        verification.respondedAt = new Date();

        if (pendingProperty) {
          const activePropertyPayload = {
            ...pendingProperty,
            isVerified: true,
            verificationStatus: 'verified'
          };
          const prop = await Property.create(activePropertyPayload);
          console.log(`   ✅ Property "${prop.name}" (ID: ${prop._id}) successfully created in MongoDB.`);

          try {
            const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const websiteUrl = process.env.PRODUCTION_WEBSITE_URL || 'https://lampose.com';
            await twilioClient.messages.create({
              body: `Your property "${prop.name}" has been successfully verified! You can check it live on our website: ${websiteUrl}`,
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: verification.ownerMobileE164
            });
            console.log(`   📤 Verification success SMS sent to owner: ${verification.ownerMobileE164}`);
          } catch (smsErr) {
            console.error('   ❌ Error sending verification success SMS to owner:', smsErr.message);
          }
        }

        await verification.save();
        twiml.message(`Thank you! Property "${propertyName}" has been verified and listed live successfully.`);
      } else if (textBody === 'no' || textBody === 'n') {
        console.log(`❌ [Verification Rejected] Verifier ${senderMobile} rejected property: "${propertyName}"`);

        verification.status = 'verifier_rejected';
        verification.respondedAt = new Date();

        if (pendingProperty) {
          const cloudinary = require('cloudinary').v2;
          cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'ozbu2jhp',
            api_key: process.env.CLOUDINARY_API_KEY || '785979326795591',
            api_secret: process.env.CLOUDINARY_API_SECRET || '1EDPPk-MX49n0nZogTk4bgrJfCI'
          });
          const getPublicIdFromUrl = (url) => {
            if (!url || !url.includes('cloudinary.com')) return null;
            try {
              const parts = url.split(/\/image\/upload\/v\d+\/|\/image\/upload\//);
              if (parts.length > 1) {
                const relativePath = parts[1];
                const dotIdx = relativePath.lastIndexOf('.');
                return dotIdx !== -1 ? relativePath.substring(0, dotIdx) : relativePath;
              }
              return null;
            } catch (err) {
              return null;
            }
          };
          const imageUrls = pendingProperty.images || (pendingProperty.imageUrl ? [pendingProperty.imageUrl] : []);
          for (const imgUrl of imageUrls) {
            const pubId = getPublicIdFromUrl(imgUrl);
            if (pubId) {
              try { await cloudinary.uploader.destroy(pubId); } catch (e) {}
            }
          }

          try {
            const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            await twilioClient.messages.create({
              body: `We regret to inform you that your onboarding request for "${pendingProperty.name}" has been rejected by our verification team.`,
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: verification.ownerMobileE164
            });
          } catch (smsErr) {
            console.error('   ❌ Error sending rejection SMS to owner:', smsErr.message);
          }
        }

        await verification.save();
        twiml.message(`Understood. Onboarding request for "${propertyName}" has been rejected and cancelled.`);
      } else {
        twiml.message(`Hello! Please reply with YES to approve "${propertyName}" or NO to reject.`);
      }

      res.type('text/xml');
      return res.send(twiml.toString());
    } else {
      // Case B: Sender is the Property Owner
      verification = await VerificationRequest.findOne({
        ownerMobileE164: senderMobile,
        status: { $in: ['pending', 'sent', 'failed'] }
      }).sort({ createdAt: -1 });

      if (!verification) {
        console.warn(`⚠️ No active pending verification request found for owner: ${senderMobile}`);
        twiml.message("Hello from Lampose! We couldn't find any pending onboarding request for this number.");
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      const pendingProperty = verification.pendingPropertyData;
      const propertyName = pendingProperty ? pendingProperty.name : 'your property';

      if (textBody === 'yes' || textBody === 'y') {
        console.log(`✅ [Owner Approved] Owner approved onboarding of property: "${propertyName}"`);

        verification.status = 'owner_approved';
        
        if (verifierNumbers.length > 0) {
          const randomVerifier = verifierNumbers[Math.floor(Math.random() * verifierNumbers.length)];
          verification.assignedVerifierMobileE164 = randomVerifier;

          const { sendTeamVerificationMessage } = require('../../config/twilio');
          console.log(`   ⏳ Forwarding verification to team member: ${randomVerifier}...`);
          await sendTeamVerificationMessage(
            randomVerifier,
            pendingProperty.ownerName,
            pendingProperty.ownerMobile,
            pendingProperty.name
          );
          
          twiml.message("Thanks for the Confirmation, Our Verification team will process Your Request and send you the confirmation after its verify.");
        } else {
          console.warn('   ⚠️ No verification team numbers found. Auto-verifying property...');
          verification.status = 'verified';
          verification.respondedAt = new Date();

          if (pendingProperty) {
            const activePropertyPayload = {
              ...pendingProperty,
              isVerified: true,
              verificationStatus: 'verified'
            };
            const prop = await Property.create(activePropertyPayload);
            console.log(`   ✅ Property "${prop.name}" (ID: ${prop._id}) successfully created in MongoDB.`);
          }

          twiml.message(`Thanks for choosing Lampose! Your property "${propertyName}" is verified and listed successfully.`);
        }

        await verification.save();
      } else if (textBody === 'no' || textBody === 'n') {
        console.log(`❌ [Owner Rejected] Owner rejected onboarding of property: "${propertyName}"`);

        if (pendingProperty) {
          const cloudinary = require('cloudinary').v2;
          cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'ozbu2jhp',
            api_key: process.env.CLOUDINARY_API_KEY || '785979326795591',
            api_secret: process.env.CLOUDINARY_API_SECRET || '1EDPPk-MX49n0nZogTk4bgrJfCI'
          });
          const getPublicIdFromUrl = (url) => {
            if (!url || !url.includes('cloudinary.com')) return null;
            try {
              const parts = url.split(/\/image\/upload\/v\d+\/|\/image\/upload\//);
              if (parts.length > 1) {
                const relativePath = parts[1];
                const dotIdx = relativePath.lastIndexOf('.');
                return dotIdx !== -1 ? relativePath.substring(0, dotIdx) : relativePath;
              }
              return null;
            } catch (err) {
              return null;
            }
          };
          const imageUrls = pendingProperty.images || (pendingProperty.imageUrl ? [pendingProperty.imageUrl] : []);
          for (const imgUrl of imageUrls) {
            const pubId = getPublicIdFromUrl(imgUrl);
            if (pubId) {
              try { await cloudinary.uploader.destroy(pubId); } catch (e) {}
            }
          }
        }

        verification.status = 'rejected';
        verification.respondedAt = new Date();
        await verification.save();

        twiml.message(`Understood. The onboarding request for your property "${propertyName}" has been cancelled. Thank you.`);
      } else {
        console.log(`ℹ️ [Unrecognized Reply] Owner replied with: "${Body}"`);
        twiml.message(`Hello! Please reply with YES to approve the onboarding of "${propertyName}" on Lampose, or NO to reject it.`);
      }

      res.type('text/xml');
      return res.send(twiml.toString());
    }
  } catch (error) {
    console.error('❌ [Twilio Webhook Exception Error]:', error.message || error);
    res.type('text/xml');
    return res.send(twiml.toString());
  }
});

module.exports = router;
