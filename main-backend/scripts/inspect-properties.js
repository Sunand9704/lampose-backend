/* Second pass: everything the Explore mapper needs to decide on.
     npm run inspect:properties */
const mongoose = require('mongoose');
const config = require('../config/env');

if (!config.db.uri) {
  console.error('MONGO_URI is missing from main-backend/.env');
  process.exit(1);
}

(async () => {
  await mongoose.connect(config.db.uri, { dbName: config.db.dbName });
  const col = mongoose.connection.db.collection('properties');
  const docs = await col.find({}).toArray();

  const tally = (key) => {
    const m = new Map();
    for (const d of docs) {
      const v = d[key];
      (Array.isArray(v) ? v : [v]).forEach((x) => m.set(x, (m.get(x) || 0) + 1));
    }
    return [...m].sort((a, b) => b[1] - a[1]);
  };

  console.log('── category ──'); console.table(tally('category'));
  console.log('── stayType ──'); console.table(tally('stayType'));
  console.log('── verificationStatus ──'); console.table(tally('verificationStatus'));
  console.log('── amenities ──'); console.table(tally('amenities'));

  console.log('\n── places / rent / images ──');
  for (const d of docs) {
    console.log(
      `${String(d.name).slice(0, 38).padEnd(40)} | ${String(d.place).slice(0, 34).padEnd(36)}`
      + ` | ${String(d.category === undefined || d.category === null ? '' : d.category).padEnd(12)} | rent ${String(d.rent).padStart(6)}`
      + ` | monthly ${String(d.monthlyPrice === undefined || d.monthlyPrice === null ? '-' : d.monthlyPrice).padStart(6)}`
      + ` | daily ${String(d.dailyPrice === undefined || d.dailyPrice === null ? '-' : d.dailyPrice).padStart(5)}`
      + ` | imgs ${(d.images || []).length} | url ${d.imageUrl ? 'y' : 'n'}`,
    );
  }

  console.log('\n── image url samples ──');
  for (const d of docs.slice(0, 4)) {
    console.log(`  imageUrl: ${d.imageUrl}`);
    if ((d.images || []).length) {
      d.images.forEach((i, n) => console.log(`  images[${n}]: ${typeof i === 'string' ? i : JSON.stringify(i).slice(0, 160)}`));
    }
  }

  console.log('\n── categoryDetails by category ──');
  const seen = new Set();
  for (const d of docs) {
    if (!d.categoryDetails || seen.has(d.category)) continue;
    seen.add(d.category);
    console.log(`\n  ${d.category}:`, JSON.stringify(d.categoryDetails, null, 4).replace(/\n/g, '\n  '));
  }

  console.log('\n── a whole document ──');
  const sample = docs.find((d) => (d.images || []).length) || docs[0];
  console.log(JSON.stringify(sample, null, 2).slice(0, 2600));

  await mongoose.disconnect();
})();
