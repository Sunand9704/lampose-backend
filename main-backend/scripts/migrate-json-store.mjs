/* ══════════════════════════════════════════════════════════════════════════
   One-way import of the old Scriper JSON store into MongoDB.

   The previous backend kept users, jobs and leads in flat files under
   scriper-backend/data/. This backend uses MongoDB, so run this once to carry
   that history across:

     npm run migrate:json
     npm run migrate:json -- --from ../scriper_vol_3/scriper-backend/data
     npm run migrate:json -- --dry-run

   Idempotent: users are matched on email, jobs on jobId, and leads on
   jobId + business name + phone, so running it twice imports nothing the
   second time.
   ══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';
import config from '../src/config/env.js';
import { connectDB, isDbUp } from '../src/config/db.js';
import { User, ScrapeJob, ScrapedLead } from '../src/models/scriper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const SOURCE = path.resolve(argOf('--from', path.resolve(HERE, '../../scriper_vol_3/scriper-backend/data')));
const DRY_RUN = process.argv.includes('--dry-run');

if (config.storage.mode !== 'mongo') {
  console.error('SCRIPER_STORAGE resolves to the JSON store, so there is nothing to migrate into.');
  console.error('Set MONGO_URI and try again.');
  process.exit(1);
}

const read = (name) => {
  const file = path.join(SOURCE, name);
  if (!fs.existsSync(file)) {
    console.warn(`  ${name} not found in ${SOURCE} — skipping.`);
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`  ${name} is not valid JSON (${error.message}) — skipping.`);
    return [];
  }
};

console.log(`\nSource: ${SOURCE}`);
console.log(`Target: ${config.db.dbName || 'database named in the URI'}`
  + ` → scriper_users / scriper_jobs / scriper_leads${DRY_RUN ? '  (dry run)' : ''}\n`);

await connectDB();

/* connectDB retries in the background rather than throwing, so wait for the
   connection to actually land before counting anything. */
if (!isDbUp()) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to MongoDB.')), 20000);
    mongoose.connection.once('connected', () => { clearTimeout(timer); resolve(); });
  });
}

const summary = [];

/* ── Users ── */
{
  const users = read('users.json');
  let imported = 0;
  for (const user of users) {
    if (!user?.email) continue;
    const email = String(user.email).toLowerCase().trim();
    if (await User.exists({ email })) continue;
    if (!DRY_RUN) {
      await User.create({
        userId: user.userId || `user_${Math.random().toString(36).slice(2, 11)}`,
        name: user.name || email,
        email,
        /* Already a bcrypt hash in the old store — copied verbatim so the
           existing passwords keep working. */
        password: user.password,
        role: user.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
        avatar: user.avatar || '',
      });
    }
    imported += 1;
  }
  summary.push(['users', users.length, imported]);
}

/* ── Jobs ── */
{
  const jobs = read('jobs.json');
  let imported = 0;
  for (const job of jobs) {
    if (!job?.jobId) continue;
    if (await ScrapeJob.exists({ jobId: job.jobId })) continue;
    if (!DRY_RUN) {
      const { _id, __v, ...rest } = job;
      await ScrapeJob.create(rest);
    }
    imported += 1;
  }
  summary.push(['jobs', jobs.length, imported]);
}

/* ── Leads ── */
{
  const leads = read('leads.json');
  let imported = 0;
  for (const lead of leads) {
    if (!lead?.businessName) continue;
    const duplicate = await ScrapedLead.exists({
      jobId: lead.jobId,
      businessName: lead.businessName,
      phone: lead.phone || '',
    });
    if (duplicate) continue;
    if (!DRY_RUN) {
      /* The old _id is a "lead_xxxx" string, not an ObjectId — dropped so
         MongoDB assigns a real one. Anything referencing the old id (nothing
         does today) would break, which is why this is called out. */
      const { _id, __v, ...rest } = lead;
      await ScrapedLead.create(rest);
    }
    imported += 1;
  }
  summary.push(['leads', leads.length, imported]);
}

console.log('\n  collection   in file   imported');
for (const [name, found, imported] of summary) {
  console.log(`  ${name.padEnd(12)} ${String(found).padStart(7)}   ${String(imported).padStart(8)}`);
}
console.log(DRY_RUN ? '\nDry run — nothing was written.\n' : '\nDone.\n');

await mongoose.connection.close();
