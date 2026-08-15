/* ══════════════════════════════════════════════════════════════════════════
   The leads panel's CRUD over `properties` — the v2 property surface.

   How this differs from /api/v1/properties, which is the important thing to
   understand before touching either:

     v1 (onboard.lampose.com)   POST does NOT write a property. It stores the
                                submission on a verificationrequest and sends
                                the owner a WhatsApp template through Twilio;
                                the row only reaches this collection once the
                                owner and then a verifier both reply YES.
                                PUT/DELETE are gated by an administrator's
                                grant, keyed on the x-employee-email header.

     v2 (leads.lampose.com)     POST writes the property immediately, behind a
                                bearer token. No Twilio, no approval chain.

   Both are wanted, which is exactly why they are versioned apart rather than
   reconciled into one endpoint that would have to guess.

   The response shape here is the raw document (`_id`, `categoryDetails`, …)
   rather than the Explore projection, because that is what the panel's
   Property interface expects.
   ══════════════════════════════════════════════════════════════════════════ */
const Property = require('../models/Property');
const { escapeRegex } = require('../utils/text');

const number = (value, fallback = null) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stringList = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
};

// @route   GET /api/v2/properties
// @desc    Every onboarded property, newest first
// @access  Public
const getProperties = async (req, res, next) => {
  try {
    const { category, search, place, stayType } = req.query;
    const filter = {};

    if (category && category !== 'all' && category !== 'ALL') {
      filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
    }
    if (stayType && stayType !== 'ALL') {
      filter.stayType = new RegExp(escapeRegex(stayType), 'i');
    }
    if (place) {
      filter.place = new RegExp(escapeRegex(place), 'i');
    }
    if (search) {
      const term = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: term },
        { place: term },
        { address: term },
        { ownerName: term },
        { ownerMobile: term },
        { category: term },
      ];
    }

    const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, count: properties.length, data: properties });
  } catch (error) {
    return next(error);
  }
};

// @route   GET /api/v2/properties/:id
// @access  Public
const getPropertyById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const property = /^[0-9a-fA-F]{24}$/.test(id) ? await Property.findById(id).lean() : null;

    if (!property) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'Property not found.',
        error: 'Property not found.',
      });
    }

    return res.json({ success: true, data: property });
  } catch (error) {
    return next(error);
  }
};

// @route   POST /api/v2/properties
// @desc    Onboard a property directly, with no verification chain
// @access  Authenticated (the panel is behind its own login)
const createProperty = async (req, res, next) => {
  try {
    const body = req.body || {};

    const missing = ['name', 'place', 'category', 'ownerName', 'ownerMobile']
      .filter((field) => !String(body[field] === undefined || body[field] === null ? '' : body[field]).trim());

    if (missing.length) {
      const message = `Missing required field(s): ${missing.join(', ')}.`;
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message, error: message });
    }

    /* The panel leaves `rent` blank when it quotes a monthly or nightly rate
       instead, but the Explore card always shows a headline number — so one
       is derived rather than stored as zero. */
    const monthlyPrice = number(body.monthlyPrice);
    const dailyPrice = number(body.dailyPrice);
    const rent = number(body.rent) || monthlyPrice || dailyPrice || 0;

    if (rent <= 0) {
      const message = 'Provide a rent, a monthly price or a daily price greater than zero.';
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message, error: message });
    }

    const images = stringList(body.images);
    const imageUrl = String(body.imageUrl || '').trim();

    const property = await Property.create({
      name: String(body.name).trim(),
      place: String(body.place).trim(),
      category: String(body.category).trim(),
      stayType: body.stayType || 'Long Stay',
      longStayDuration: body.longStayDuration || null,
      shortStayDuration: body.shortStayDuration || null,
      rent,
      monthlyPrice,
      dailyPrice,
      deposit: number(body.deposit),
      ownerName: String(body.ownerName).trim(),
      ownerMobile: String(body.ownerMobile).trim(),
      address: String(body.address || '').trim(),
      description: String(body.description || '').trim(),
      employeeEmail: String(body.employeeEmail || (req.user && req.user.email) || '').trim(),
      amenities: stringList(body.amenities),
      /* Older rows carry a single cover in `imageUrl` and newer ones a
         gallery; both are kept in step so either reader finds an image. */
      images: images.length ? images : (imageUrl ? [imageUrl] : []),
      imageUrl: imageUrl || images[0] || '',
      categoryDetails: (body.categoryDetails && typeof body.categoryDetails === 'object')
        ? body.categoryDetails
        : {},
      status: body.status || 'active',
      /* A property created here has bypassed the owner-confirmation chain the
         onboarding app runs, so it is marked as such rather than being
         presented as something an owner agreed to. It is still live on the
         public site — /api/v2/listings does not filter on this — which is the
         behaviour the leads panel has always had. */
      isVerified: false,
      verificationStatus: 'pending',
    });

    return res.status(201).json({
      success: true,
      message: 'Property onboarded successfully.',
      data: property.toObject(),
    });
  } catch (error) {
    return next(error);
  }
};

// @route   DELETE /api/v2/properties/:id
// @access  Authenticated
const deleteProperty = async (req, res, next) => {
  try {
    const { id } = req.params;
    const deleted = /^[0-9a-fA-F]{24}$/.test(id)
      ? await Property.findByIdAndDelete(id).lean()
      : null;

    if (!deleted) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'Property not found.',
        error: 'Property not found.',
      });
    }

    return res.json({ success: true, message: 'Property deleted successfully.' });
  } catch (error) {
    return next(error);
  }
};

module.exports = { getProperties, getPropertyById, createProperty, deleteProperty };
