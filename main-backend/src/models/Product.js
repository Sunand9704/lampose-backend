import mongoose from 'mongoose';

/* Carried over from the Lampose backend. Nothing routes to it yet; it is kept
   so the merge loses no schema, and it costs nothing until a model method is
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

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

export default Product;
