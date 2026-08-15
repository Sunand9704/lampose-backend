const mongoose = require('mongoose');

const ACTIONS = ['edit', 'delete'];
const STATUSES = ['pending', 'granted', 'denied', 'revoked', 'used'];

/**
 * An employee's request for permission to edit or delete a listing.
 *
 * Employees never hold standing edit/delete rights: every attempt is recorded
 * here first, an administrator decides on it, and a grant is time-boxed and
 * single-use. The document doubles as the audit trail — who asked, for what,
 * who decided, and when it was spent.
 */
const permissionRequestSchema = new mongoose.Schema(
  {
    // String form of the listing id, stored alongside the ref because a listing
    // can still be awaiting owner verification and therefore not yet exist as a
    // document in the properties collection.
    propertyRef: {
      type: String,
      required: [true, 'Property reference is required'],
      trim: true,
    },
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: false,
    },
    // Copied at request time so the console can still name the listing after a
    // granted delete has removed it.
    propertySnapshot: {
      name: { type: String, default: '' },
      place: { type: String, default: '' },
      category: { type: String, default: '' },
      ownerName: { type: String, default: '' },
      ownerMobile: { type: String, default: '' },
    },
    employeeEmail: {
      type: String,
      required: [true, 'Requesting employee email is required'],
      trim: true,
      lowercase: true,
    },
    action: {
      type: String,
      enum: ACTIONS,
      required: [true, 'Requested action is required'],
    },
    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
    },
    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
    },
    decidedBy: {
      type: String,
      default: '',
      trim: true,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    // Stamped when the employee actually performs the granted action, which
    // also closes the grant.
    usedAt: {
      type: Date,
      default: null,
    },
    // A grant is a window, not a permanent privilege.
    expiresAt: {
      type: Date,
      default: null,
    },
    requestedIp: {
      type: String,
      default: '',
    },
    userAgent: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

permissionRequestSchema.index({ propertyRef: 1, employeeEmail: 1, action: 1, status: 1 });
permissionRequestSchema.index({ status: 1, createdAt: -1 });

/** True while a grant is still spendable — approved, unused and unexpired. */
permissionRequestSchema.statics.isActiveGrant = function (doc) {
  if (!doc || doc.status !== 'granted') return false;
  if (!doc.expiresAt) return true;
  return new Date(doc.expiresAt).getTime() > Date.now();
};

permissionRequestSchema.statics.ACTIONS = ACTIONS;
permissionRequestSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('PermissionRequest', permissionRequestSchema, 'permissionrequests');
module.exports.ACTIONS = ACTIONS;
module.exports.STATUSES = STATUSES;
