/* ══════════════════════════════════════════════════════════════════════════
   Exports the `properties` collection into the shape lampose.com's Explore
   page reads, and writes it to the frontend as a build-time snapshot.

     npm run export:listings              every property
     npm run export:listings:clean        skips obvious test rows

   The city and price-period rules are required from utils/listingFormatter.js
   rather than copied, so this snapshot and the live /api/v2/listings response
   can never disagree about which city a `place` belongs to.

   Re-run whenever the panel's data changes; it is a snapshot, not a live
   feed. Point LISTINGS_OUT elsewhere if the frontend has moved.
   ══════════════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const config = require('../config/env');
const { cityOf, localityOf, slugify, isDaily } = require('../utils/listingFormatter');

const OUT = process.env.LISTINGS_OUT
  ? path.resolve(process.env.LISTINGS_OUT)
  : path.resolve(__dirname, '../../lampose-frontend/src/data/listings.js');
const CLEAN = process.argv.includes('--clean');

if (!config.db.uri) {
  console.error('MONGO_URI is missing from main-backend/.env');
  process.exit(1);
}

if (!fs.existsSync(path.dirname(OUT))) {
  console.error(`Output directory does not exist: ${path.dirname(OUT)}`);
  console.error("Set LISTINGS_OUT to the frontend's src/data/listings.js path.");
  process.exit(1);
}

/* ── Quality screen ──────────────────────────────────────────────────────
   Three independent signals, each reported so a drop can be argued with.
   None of them guesses at intent: a row is only suspect on hard evidence. */
const digitsOf = (s) => String(s || '').replace(/\D/g, '');
const badMobile = (s) => {
  const d = digitsOf(s);
  const n = d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
  return !(n.length === 10 && /^[6-9]/.test(n));
};
const TEST_WORDS = /\b(test|testing|sample|demo|dummy|verify)\b/i;

const suspicions = (doc) => {
  const why = [];
  if (TEST_WORDS.test(doc.name) || TEST_WORDS.test(doc.place)) why.push('test/sample in name');
  if (badMobile(doc.ownerMobile)) why.push(`unusable mobile "${doc.ownerMobile}"`);
  if (doc.rent > 60000) why.push(`rent ${doc.rent} out of band`);
  if (doc.rent < 200) why.push(`rent ${doc.rent} out of band`);
  return why;
};

/* Anything the panel adds later falls back to the room glyph rather than
   breaking the tab row. */
const CATEGORY_ICONS = {
  PG: 'stay',
  Hostel: 'users',
  Dormitory: 'grid',
  'Bachelor Room': 'stay',
};

/* Tab order, chosen rather than alphabetical: the filter row should lead with
   what people search for most, not with whatever starts with a B. A category
   the panel adds later is not in this list, so it sorts to the end by name
   instead of silently jumping to the front. */
const CATEGORY_ORDER = ['Hostel', 'PG', 'Bachelor Room', 'Dormitory'];

const byCategoryOrder = (a, b) => {
  const ia = CATEGORY_ORDER.indexOf(a);
  const ib = CATEGORY_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
};

/* Absolute URLs only. Some rows hold a path like "/lampose-logo-splash.png",
   which resolves against the onboarding panel's own origin — on the public
   site it would be a 404, so it is dropped and the card falls back to its
   gradient. */
const imageDrops = [];
const imagesOf = (doc) => {
  const all = [doc.imageUrl, ...(doc.images || [])].filter(Boolean);
  const usable = all.filter((u) => /^https?:\/\//i.test(u));
  all.filter((u) => !usable.includes(u)).forEach((u) => imageDrops.push(`${doc.name}: ${u}`));
  return [...new Set(usable)];
};

const map = (doc) => {
  const city = cityOf(doc.place);
  return {
    id: String(doc._id),
    name: doc.name,
    category: doc.category,
    categorySlug: slugify(doc.category),
    place: doc.place,
    city,
    locality: localityOf(doc.place, city),
    address: doc.address || null,
    rent: doc.rent,
    pricePeriod: isDaily(doc) ? '/day' : '/mo',
    deposit: doc.deposit === undefined ? null : doc.deposit,
    monthlyPrice: doc.monthlyPrice || null,
    dailyPrice: doc.dailyPrice || null,
    stayType: doc.stayType || null,
    longStayDuration: doc.longStayDuration || null,
    shortStayDuration: doc.shortStayDuration || null,
    ownerName: doc.ownerName,
    ownerMobile: doc.ownerMobile,
    amenities: doc.amenities || [],
    images: imagesOf(doc),
    details: doc.categoryDetails || null,
    listedAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
};

/* ── Run ─────────────────────────────────────────────────────────────── */
(async () => {
  await mongoose.connect(config.db.uri, { dbName: config.db.dbName });
  const docs = await mongoose.connection.db
    .collection('properties').find({}).sort({ createdAt: -1 })
    .toArray();
  await mongoose.disconnect();

  const flagged = docs.map((doc) => ({ doc, why: suspicions(doc) }));
  const suspect = flagged.filter((f) => f.why.length);

  if (suspect.length) {
    console.log(`\n${suspect.length} of ${docs.length} rows look like test data:`);
    for (const { doc, why } of suspect) {
      console.log(`  ${CLEAN ? 'DROP' : 'keep'}  ${String(doc.name).padEnd(24)} ${why.join('; ')}`);
    }
    console.log(CLEAN
      ? '\n  Dropped, because --clean was passed.'
      : '\n  All kept. Pass --clean to leave these out of the site.');
  }

  const kept = (CLEAN ? flagged.filter((f) => !f.why.length) : flagged).map((f) => map(f.doc));

  if (kept.length === 0) {
    console.error('\nNo listings to export — refusing to overwrite the frontend with an empty file.');
    process.exit(1);
  }

  if (imageDrops.length) {
    console.log(`\n${imageDrops.length} image path(s) skipped — not absolute URLs:`);
    imageDrops.forEach((d) => console.log(`  ${d}`));
  }

  const withImages = kept.filter((l) => l.images.length).length;
  console.log(`\n${kept.length} listings exported — ${withImages} with at least one image,`
    + ` ${kept.filter((l) => l.images.length > 1).length} with a gallery,`
    + ` ${kept.length - withImages} falling back to the category gradient.`);

  /* Derived lists, so a filter can never offer a city or category that would
     land the visitor on an empty grid. */
  const uniq = (xs) => [...new Set(xs)];
  const cities = uniq(kept.map((l) => l.city)).sort();
  const categories = uniq(kept.map((l) => l.category)).sort(byCategoryOrder);
  const priceMax = Math.ceil(Math.max(...kept.map((l) => l.rent)) / 500) * 500;

  const file = `/* ══════════════════════════════════════════════════════════════════════════
   GENERATED FILE — do not edit by hand.

   Written by main-backend/scripts/export-listings.js from the \`properties\`
   collection. To refresh:

     cd main-backend && npm run export:listings${CLEAN ? ':clean' : ''}

   Every field below exists in the collection. The page deliberately shows no
   rating, review count or verification badge, because the panel does not
   collect them.
   ══════════════════════════════════════════════════════════════════════════ */

export const LISTINGS = ${JSON.stringify(kept, null, 2)};

/* Derived from the listings above, never hand-maintained. */
export const CITIES_LIST = ['All Cities', ${cities.map((c) => JSON.stringify(c)).join(', ')}];

export const PRICE_MAX = ${priceMax};

/* Icon names must exist in components/Icon.jsx; an unknown name falls back to
   the grid glyph. The slug is what the stylesheet keys its accent off. */
export const CATEGORIES_LIST = [
  { id: 'all', label: 'All listings', icon: 'grid' },
${categories.map((c) => `  { id: ${JSON.stringify(c)}, slug: ${JSON.stringify(slugify(c))}, label: ${JSON.stringify(c)}, icon: ${JSON.stringify(CATEGORY_ICONS[c] || 'stay')} },`).join('\n')}
];

export const SORT_OPTIONS = [
  { id: 'recent', label: 'Recently listed' },
  { id: 'price-asc', label: 'Rent: low to high' },
  { id: 'price-desc', label: 'Rent: high to low' },
];
`;

  fs.writeFileSync(OUT, file);
  console.log(`Wrote ${OUT}`);
})();
