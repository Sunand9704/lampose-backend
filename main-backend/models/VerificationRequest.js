const mongoose = require('mongoose');

const verificationRequestSchema = new mongoose.Schema(
  {
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: false,
    },
    ownerMobileE164: {
      type: String,
      required: [true, 'Owner mobile number is required'],
      trim: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'delivered', 'failed', 'verified', 'expired', 'rejected', 'owner_approved', 'verifier_rejected'],
      default: 'pending',
    },
    contentSid: {
      type: String,
      default: '',
    },
    outboundMessageSid: {
      type: String,
      default: '',
    },
    lastDeliveryStatus: {
      type: String,
      default: '',
    },
    lastError: {
      type: String,
      default: '',
    },
    attempts: {
      type: Number,
      default: 1,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    pendingPropertyData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    assignedVerifierMobileE164: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('VerificationRequest', verificationRequestSchema, 'verificationrequests');
