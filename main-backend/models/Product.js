const mongoose = require('mongoose');

/* Carried over from the leads backend. Nothing routes to it; it is kept so the
   merge loses no schema, and it costs nothing until a model method is
   actually called. */
const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a product name'],
      trim: true,
    },
    description: {
      type: String,
      required: false,
    },
    price: {
      type: Number,
      required: [true, 'Please add a price'],
      default: 0,
    },
    inStock: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
