/* ══════════════════════════════════════════════════════════════════════════
   The `properties` collection — one schema, three readers.

   Mongoose registers a model name once per process, so the two merged
   backends cannot each keep their own Property. This is the union of both:

     · Every field, validator and enum the onboarding backend had is kept
       exactly as it was. A document that was valid before is still valid.
     · `description` and `status` are added from the leads backend. Without
       them a property onboarded through the leads panel would silently lose
       its description on write.
     · The collection name is pinned rather than left to mongoose's pluraliser,
       so the existing data keeps being found where it already lives.

   The leads backend kept this schema non-strict, on the reasoning that a
   second app it could not see also wrote to the collection. After the merge
   this process *is* both writers, and every field either of them writes is
   declared below — so strict mode goes back on. That matters because
   PUT /api/v1/properties/:id hands `req.body` to findByIdAndUpdate whole:
   non-strict would let any caller add arbitrary fields to a listing.

   Read paths that use it:
     /api/v1/properties   the onboarding app  — verified rows + pending ones
                          reconstructed from verificationrequests
     /api/v2/properties   the leads panel     — raw documents
     /api/v2/listings     lampose.com         — projected through
                          utils/listingFormatter
   ══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Property name is required'],
      trim: true
    },
    place: {
      type: String,
      required: [true, 'Place/Location is required'],
      trim: true
    },
    ownerName: {
      type: String,
      required: [true, 'Owner name is required'],
      trim: true
    },
    ownerMobile: {
      type: String,
      required: [true, 'Owner mobile number is required'],
      trim: true
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: ['PG', 'Hostel', 'Dormitory', 'Bachelor Room']
    },
    // Employee / Agent email who onboarded this property
    employeeEmail: {
      type: String,
      default: '',
      trim: true
    },
    // Stay Type & Pricing Structure
    stayType: {
      type: String,
      default: 'Long Stay',
      enum: ['Short Stay', 'Long Stay', 'Both Short & Long Stay']
    },
    shortStayDuration: {
      type: String,
      default: '1-7 Days'
    },
    dailyPrice: {
      type: Number,
      default: 0
    },
    longStayDuration: {
      type: String,
      default: '1 Month+'
    },
    monthlyPrice: {
      type: Number,
      default: 0
    },
    rent: {
      type: Number,
      required: [true, 'Rent amount is required'],
      min: [0, 'Rent must be positive']
    },
    deposit: {
      type: Number,
      default: 0
    },
    address: {
      type: String,
      default: ''
    },
    // Written by the leads panel's property form; absent from the original
    // onboarding schema, where strict mode would have dropped it.
    description: {
      type: String,
      default: ''
    },
    imageUrl: {
      type: String,
      default: ''
    },
    images: {
      type: [String],
      default: []
    },
    amenities: {
      type: [String],
      default: []
    },
    categoryDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    isVerified: {
      type: Boolean,
      default: false
    },
    verificationStatus: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending'
    },
    // The leads panel's own lifecycle flag, independent of the WhatsApp
    // verification the onboarding app runs.
    status: {
      type: String,
      default: 'active'
    }
  },
  {
    timestamps: true,
    collection: 'properties',
    /* See the header: on, because the v1 update route passes req.body
       through unfiltered. Every field either frontend writes is declared
       above, so nothing is lost by it. */
    strict: true
  }
);

propertySchema.index({ name: 'text', place: 'text', ownerName: 'text', employeeEmail: 'text' });
/* The Explore grid always sorts newest first and filters by category. */
propertySchema.index({ createdAt: -1 });
propertySchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.models.Property || mongoose.model('Property', propertySchema);
