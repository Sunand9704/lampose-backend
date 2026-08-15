/* Read-only view of the onboarding `properties` collection, shaped for the
   public Explore page. Writes go through the properties controller instead. */
import Property from '../models/Property.js';
import { formatListing } from '../utils/listingFormatter.js';
import { escapeRegex } from '../utils/text.js';

// @route   GET /api/listings
// @desc    Every listing, newest first, with optional filtering
// @access  Public
export const getListings = async (req, res, next) => {
  try {
    const { category, city, maxPrice, search } = req.query;
    const filter = {};

    if (category && category !== 'all') {
      filter.category = new RegExp(escapeRegex(category), 'i');
    }

    if (maxPrice && Number.isFinite(Number(maxPrice))) {
      filter.rent = { $lte: Number(maxPrice) };
    }

    if (search) {
      const term = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: term },
        { place: term },
        { ownerName: term },
        { amenities: term },
      ];
    }

    /* No limit: the Explore page is the only consumer and it pages the render
       itself, so the response is the whole collection. */
    const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();
    let listings = properties.map(formatListing);

    /* City is derived from free-text `place` after the fact, so it cannot be
       part of the database query. */
    if (city && city !== 'All Cities') {
      listings = listings.filter((item) => item.city.toLowerCase() === String(city).toLowerCase());
    }

    return res.json({ success: true, count: listings.length, data: listings });
  } catch (error) {
    return next(error);
  }
};

// @route   GET /api/listings/:id
// @desc    A single listing
// @access  Public
export const getListingById = async (req, res, next) => {
  try {
    const { id } = req.params;

    /* findById on a non-ObjectId throws a CastError; checking the shape first
       lets a bad id be a plain 404 instead. */
    const property = /^[0-9a-fA-F]{24}$/.test(id)
      ? await Property.findById(id).lean()
      : null;

    if (!property) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'Listing not found',
        error: 'Listing not found',
      });
    }

    return res.json({ success: true, data: formatListing(property) });
  } catch (error) {
    return next(error);
  }
};

export default { getListings, getListingById };
