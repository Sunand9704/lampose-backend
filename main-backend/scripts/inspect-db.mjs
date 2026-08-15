/* Reconnaissance against the database.
   Prints collection names, document counts and the key shape of a sample
   document per collection — never the connection string.

     npm run inspect:db
*/
import mongoose from 'mongoose';
import config from '../src/config/env.js';

const { uri, dbName } = config.db;

if (!uri) {
  console.error('MONGO_URI is missing from main-backend/.env');
  process.exit(1);
}

const shapeOf = (v, depth = 0) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${shapeOf(v[0], depth + 1)}] x${v.length}` : '[]';
  if (v instanceof Date) return 'Date';
  if (v && typeof v === 'object') {
    if (v._bsontype) return v._bsontype;
    if (depth > 1) return '{…}';
    const keys = Object.keys(v).slice(0, 14);
    return `{ ${keys.map((k) => `${k}: ${shapeOf(v[k], depth + 1)}`).join(', ')} }`;
  }
  if (typeof v === 'string') return v.length > 60 ? `string(${v.length})` : `"${v}"`;
  return typeof v;
};

await mongoose.connect(uri, { dbName });
const db = mongoose.connection.db;
console.log(`database: ${db.databaseName}\n`);

const collections = await db.listCollections().toArray();
for (const c of collections) {
  const col = db.collection(c.name);
  const count = await col.countDocuments();
  console.log(`\n══ ${c.name} — ${count} docs ═══════════════════════════════`);
  if (!count) continue;

  const doc = await col.findOne({});
  for (const [k, v] of Object.entries(doc)) {
    console.log(`  ${k.padEnd(22)} ${shapeOf(v)}`);
  }

  /* Field coverage across the collection: a key present on one document is
     not a schema, and the mapper needs to know what it can rely on. */
  const keys = new Map();
  for await (const d of col.find({}, { limit: 200 })) {
    for (const k of Object.keys(d)) keys.set(k, (keys.get(k) || 0) + 1);
  }
  const sampled = Math.min(count, 200);
  const partial = [...keys].filter(([, n]) => n < sampled);
  if (partial.length) {
    console.log(`  -- present on some but not all of ${sampled} sampled:`);
    for (const [k, n] of partial) console.log(`     ${k.padEnd(20)} ${n}/${sampled}`);
  }
}

await mongoose.disconnect();
