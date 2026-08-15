import mongoose from 'mongoose';

/* The onboarding panel writes these documents and the public site reads them,
   so the collection name is pinned rather than left to mongoose's pluraliser —
   the existing data lives in `properties` and must keep being found there. */
const propertySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Property name is required'], trim: true },
    place: { type: String, required: [true, 'Place is required'], trim: true },
    category: { type: String, required: [true, 'Category is required'], trim: true },
    stayType: { type: String, default: 'Long Stay' },
    longStayDuration: { type: String, default: null },
    shortStayDuration: { type: String, default: null },
    rent: { type: Number, required: [true, 'Rent is required'] },
    monthlyPrice: { type: Number, default: null },
    dailyPrice: { type: Number, default: null },
    deposit: { type: Number, default: null },
    ownerName: { type: String, required: [true, 'Owner name is required'] },
    ownerMobile: { type: String, required: [true, 'Owner mobile is required'] },
    address: { type: String, default: '' },
    /* Written by the onboard.lampose.com backend, which is a separate app on
       the same collection. Absent from the schema, mongoose's strict mode
       would drop them from anything this backend writes — a property
       onboarded through the panel would silently lose its description. */
    description: { type: String, default: '' },
    employeeEmail: { type: String, default: '' },
    amenities: { type: [String], default: [] },
    images: { type: [String], default: [] },
    imageUrl: { type: String, default: '' },
    /* Shape varies by category (sharing types for a PG, bed count for a
       dormitory), so it is stored as-is rather than modelled four ways. */
    categoryDetails: { type: Object, default: {} },
    status: { type: String, default: 'active' },
  },
  {
    timestamps: true,
    collection: 'properties',
    /* This collection has a second writer that this repo does not contain, so
       its shape can change without this file changing. Non-strict keeps any
       field it adds later instead of dropping it on the next write from here.
       Writes are still controlled: propertyController builds the document
       field by field rather than passing req.body through. */
    strict: false,
  },
);

/* The Explore grid always sorts newest first and filters by category. */
propertySchema.index({ createdAt: -1 });
propertySchema.index({ category: 1, createdAt: -1 });

const Property = mongoose.models.Property || mongoose.model('Property', propertySchema);

export default Property;
