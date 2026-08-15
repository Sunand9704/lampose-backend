/* ══════════════════════════════════════════════════════════════════════════
   Turns an onboarding `properties` document into the shape the Explore page
   reads.

   Kept in step with scripts/export-listings.mjs — the live API and the
   build-time snapshot must derive the same city from the same `place`, or the
   two disagree about what the city filter should contain.
   ══════════════════════════════════════════════════════════════════════════ */

/* Cities we can name with confidence. `place` is free text from the panel and
   often has no comma, so a known name anywhere in the string beats splitting
   on punctuation and hoping. */
export const KNOWN_CITIES = [
  'Visakhapatnam', 'Vizag', 'Vijayawada', 'Amaravati', 'Guntur', 'Tirupati',
  'Kakinada', 'Nellore', 'Kurnool', 'Hyderabad', 'Bangalore', 'Bengaluru',
  'Chennai', 'Mumbai', 'Pune', 'Delhi',
];

export const CITY_ALIAS = { Vizag: 'Visakhapatnam', Bengaluru: 'Bangalore' };

/* A recognised name anywhere in the string wins; otherwise the tail after the
   last comma, or the whole string. It must never fall back to a fixed city —
   doing so filed every unrecognised place under Visakhapatnam, a city those
   listings had nothing to do with. */
export const cityOf = (place) => {
  const text = String(place || '');
  const hit = KNOWN_CITIES.find((city) => new RegExp(`\\b${city}\\b`, 'i').test(text));
  if (hit) return CITY_ALIAS[hit] || hit;

  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : text.trim();
};

export const localityOf = (place, city) => {
  const text = String(place || '');
  if (!city) return text.trim();
  const stripped = text
    .replace(new RegExp(`,?\\s*\\b${city}\\b`, 'i'), '')
    .replace(/,\s*$/, '')
    .trim();
  return stripped || text.trim();
};

// Dormitories and pods are quoted nightly, and the panel says so two ways.
export const isDaily = (doc) => doc.categoryDetails?.rateType === 'Daily Rate'
  || (doc.dailyPrice > 0 && !(doc.monthlyPrice > 0));

export const slugify = (value) => String(value || 'stay')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

export const formatListing = (input) => {
  const doc = input?.toObject ? input.toObject() : input;

  /* `images` is the gallery and `imageUrl` the single cover the older panel
     wrote; one card renders from whichever exists. */
  let images = Array.isArray(doc.images) ? doc.images.filter(Boolean) : [];
  if (images.length === 0 && doc.imageUrl) images = [doc.imageUrl];

  const place = String(doc.place || '');
  const city = cityOf(place);

  return {
    id: doc._id ? String(doc._id) : String(doc.id ?? ''),
    name: doc.name,
    place: doc.place,
    city,
    locality: localityOf(place, city),
    category: doc.category || 'PG',
    categorySlug: slugify(doc.category),
    stayType: doc.stayType || 'Long Stay',
    longStayDuration: doc.longStayDuration || null,
    shortStayDuration: doc.shortStayDuration || null,
    rent: doc.rent || 0,
    pricePeriod: isDaily(doc) ? '/day' : '/mo',
    monthlyPrice: doc.monthlyPrice || null,
    dailyPrice: doc.dailyPrice || null,
    deposit: doc.deposit || null,
    ownerName: doc.ownerName || 'Property Owner',
    ownerMobile: doc.ownerMobile || '',
    address: doc.address || '',
    amenities: Array.isArray(doc.amenities) ? doc.amenities : [],
    images,
    details: doc.categoryDetails || null,
    listedAt: doc.createdAt || doc.updatedAt || new Date().toISOString(),
  };
};

export default formatListing;
