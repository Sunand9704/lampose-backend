/* ══════════════════════════════════════════════════════════════════════════
   Leads-panel data access: users, scrape jobs, scraped leads.

   Two backends, chosen once at boot and never switched afterwards:

     mongo — the normal path.
     json  — flat files under data/, for running without a cluster.

   The original code fell back from mongo to json the moment the first connect
   attempt failed. That is worse than it looks: a cluster that is briefly
   unreachable at boot sends every subsequent write to a file nobody reads
   again, so the data silently splits in two. Here the mode is fixed by
   configuration, mongo keeps retrying in the background (config/db.js), and
   callers get a clean 503 while it is down.

   Note that this is a different failover from the v1 onboarding routes' one.
   They share a process but not a policy, and deliberately so: the onboarding
   app is a field tool that has to keep accepting input on a bad connection,
   while a lead written to a file the dashboard never reads is just lost work.
   ══════════════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const config = require('../config/env');
const { isScriperUp, isDbUp } = require('../config/db');
const { User, ScrapeJob, ScrapedLead } = require('../models/scriper');
const { escapeRegex } = require('../utils/text');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

const mode = config.storage.mode;
const useMongo = mode === 'mongo';

let localUsers = [];
let localJobs = [];
let localLeads = [];
let localLoaded = false;

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

/* A mongoose Document is not a plain object: spreading one yields its
   internals ($__, _doc, $isNew) rather than its fields, which is how a
   register response ended up shipping nothing useful to the client. Every
   read path below returns lean objects, and creates are converted here. */
const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

const withoutPassword = (user) => {
  if (!user) return null;
  const { password, __v, ...rest } = plain(user);
  return rest;
};

/* ── Local JSON store ─────────────────────────────────────────────────── */

const DEFAULT_USER_SEEDS = [
  {
    userId: 'user_admin_01',
    name: 'Admin Manager',
    email: 'admin@scriper.com',
    plainPassword: 'admin123',
    role: 'ADMIN',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
  },
  {
    userId: 'user_emp_01',
    name: 'John Doe',
    email: 'john@scriper.com',
    plainPassword: 'employee123',
    role: 'EMPLOYEE',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80',
  },
  {
    userId: 'user_emp_02',
    name: 'Sarah Connor',
    email: 'sarah@scriper.com',
    plainPassword: 'employee123',
    role: 'EMPLOYEE',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop&q=80',
  },
];

/* Hashing three passwords costs about a fifth of a second. Deferred so a
   production boot — which never seeds — does not pay for it. */
const buildDefaultUsers = () => DEFAULT_USER_SEEDS.map(({ plainPassword, ...user }) => ({
  ...user,
  password: bcrypt.hashSync(plainPassword, 10),
}));

const readJson = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    console.warn(`[store:json] ${path.basename(file)} is unreadable (${error.message}) — starting empty.`);
    return fallback;
  }
};

function saveLocalData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(localUsers, null, 2), 'utf8');
    fs.writeFileSync(JOBS_FILE, JSON.stringify(localJobs, null, 2), 'utf8');
    fs.writeFileSync(LEADS_FILE, JSON.stringify(localLeads, null, 2), 'utf8');
  } catch (error) {
    console.error(`[store:json] failed to persist: ${error.message}`);
  }
}

const loadLocalData = () => {
  if (localLoaded) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  localUsers = readJson(USERS_FILE, []);
  localJobs = readJson(JOBS_FILE, []);
  localLeads = readJson(LEADS_FILE, []);

  if (localUsers.length === 0 && config.auth.seedDefaultUsers) {
    localUsers = buildDefaultUsers();
  }

  localLoaded = true;
  saveLocalData();
};

/* ── Seeding ──────────────────────────────────────────────────────────── */

let seeded = false;

const seedMongoUsers = async () => {
  if (seeded || !config.auth.seedDefaultUsers) return;
  try {
    if (await User.estimatedDocumentCount() === 0) {
      await User.insertMany(buildDefaultUsers());
      console.log('[store:mongo] seeded the default demo accounts.');
    }
    seeded = true;
  } catch (error) {
    console.warn(`[store:mongo] could not seed default users: ${error.message}`);
  }
};

/* Reports whether an account exists, so server.js can tell an operator
   staring at an empty production database how to create the first one. */
const countUsers = async () => {
  if (!useMongo) {
    loadLocalData();
    return localUsers.length;
  }
  if (!isDbUp()) return null;
  return User.estimatedDocumentCount();
};

const initStore = async () => {
  if (!useMongo) {
    loadLocalData();
    console.log(`[store] leads data → local JSON files (${DATA_DIR})`);
    return;
  }

  console.log('[store] leads data → MongoDB (scriper_* collections)');
  if (isDbUp()) {
    await seedMongoUsers();
  } else {
    /* The connection retries in the background; seed whenever it lands. */
    mongoose.connection.once('connected', () => { seedMongoUsers().catch(() => {}); });
  }
};

/* ── API ──────────────────────────────────────────────────────────────── */

const dbStore = {
  isMongo: () => useMongo,
  isReady: () => isScriperUp(),
  mode: () => mode,

  /* ── Users ── */

  async registerUser({ name, email, password, role = 'EMPLOYEE', avatar }) {
    const cleanEmail = String(email).toLowerCase().trim();
    if (await this.findUserByEmail(cleanEmail)) {
      throw new Error('An account with this email address already exists.');
    }

    const record = {
      userId: newId('user'),
      name: String(name).trim(),
      email: cleanEmail,
      password: bcrypt.hashSync(password, 10),
      role: role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
      avatar: avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}`,
    };

    if (useMongo) {
      return withoutPassword(await User.create(record));
    }

    loadLocalData();
    localUsers.push(record);
    saveLocalData();
    return withoutPassword(record);
  },

  async authenticateUser(email, plainPassword) {
    const user = await this.findUserByEmail(email);
    /* One message for "no such account" and "wrong password" on purpose:
       distinguishing them tells an attacker which addresses are registered. */
    const invalid = new Error('Invalid email or password.');
    if (!user || !user.password) throw invalid;
    if (!bcrypt.compareSync(String(plainPassword), user.password)) throw invalid;
    return withoutPassword(user);
  },

  async findUserByEmail(email) {
    const cleanEmail = String(email || '').toLowerCase().trim();
    if (!cleanEmail) return null;

    if (useMongo) return User.findOne({ email: cleanEmail }).lean();

    loadLocalData();
    return localUsers.find((u) => String(u.email).toLowerCase() === cleanEmail) || null;
  },

  async findUserById(userId) {
    if (!userId) return null;
    if (useMongo) return withoutPassword(await User.findOne({ userId }).lean());

    loadLocalData();
    return withoutPassword(localUsers.find((u) => u.userId === userId));
  },

  async getUsers() {
    if (useMongo) return User.find({}, '-password').sort({ createdAt: 1 }).lean();

    loadLocalData();
    return localUsers.map(withoutPassword);
  },

  async createUser(userData) {
    return this.registerUser(userData);
  },

  async deleteUser(userId) {
    if (useMongo) {
      const result = await User.deleteOne({ userId });
      return result.deletedCount > 0;
    }

    loadLocalData();
    const before = localUsers.length;
    localUsers = localUsers.filter((u) => u.userId !== userId);
    saveLocalData();
    return localUsers.length < before;
  },

  /* ── Scrape jobs ── */

  async createJob(jobData) {
    const now = new Date().toISOString();
    const job = {
      jobId: jobData.jobId,
      name: jobData.name || 'Scrape Mission',
      source: jobData.source || 'GoogleMaps',
      query: jobData.query || '',
      location: jobData.location || '',
      landmark: jobData.landmark || '',
      depth: jobData.depth || 10,
      status: jobData.status || 'started',
      progress: jobData.progress || 0,
      statusMessage: jobData.statusMessage || 'Job started',
      resultCount: jobData.resultCount || 0,
      createdAt: now,
      updatedAt: now,
    };

    if (useMongo) return plain(await ScrapeJob.create(job));

    loadLocalData();
    localJobs.unshift(job);
    saveLocalData();
    return job;
  },

  async updateJob(jobId, updates) {
    if (useMongo) {
      /* Progress updates fire every couple of seconds from the scraper and
         are never awaited by a request, so a write that fails because the
         cluster blipped must not become an unhandled rejection. */
      try {
        return await ScrapeJob.findOneAndUpdate({ jobId }, updates, { returnDocument: 'after' }).lean();
      } catch (error) {
        console.warn(`[store] job ${jobId} update failed: ${error.message}`);
        return null;
      }
    }

    loadLocalData();
    const index = localJobs.findIndex((j) => j.jobId === jobId);
    if (index === -1) return null;
    localJobs[index] = { ...localJobs[index], ...updates, updatedAt: new Date().toISOString() };
    saveLocalData();
    return localJobs[index];
  },

  async getJob(jobId) {
    if (useMongo) return ScrapeJob.findOne({ jobId }).lean();

    loadLocalData();
    return localJobs.find((j) => j.jobId === jobId) || null;
  },

  async getJobs() {
    if (useMongo) return ScrapeJob.find().sort({ createdAt: -1 }).lean();

    loadLocalData();
    return [...localJobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  /* ── Leads ── */

  async saveLeads(leads) {
    if (!Array.isArray(leads) || leads.length === 0) return [];

    if (useMongo) return (await ScrapedLead.insertMany(leads)).map(plain);

    loadLocalData();
    const formatted = leads.map((lead) => ({
      ...lead,
      _id: lead._id || newId('lead'),
      assignedTo: lead.assignedTo || { userId: null, name: null, email: null },
      leadStatus: lead.leadStatus || 'NEW',
      notes: lead.notes || [],
      scrapedAt: lead.scrapedAt || new Date().toISOString(),
    }));
    localLeads.unshift(...formatted);
    saveLocalData();
    return formatted;
  },

  async getLeads(filters = {}) {
    if (useMongo) {
      const query = {};
      if (filters.jobId) query.jobId = filters.jobId;
      if (filters.source && filters.source !== 'ALL') query.source = filters.source;
      if (filters.hasPhone === 'true') query.phone = { $nin: ['', null] };
      if (filters.hasWebsite === 'true') query.hasWebsite = true;
      if (filters.assignedUserId) query['assignedTo.userId'] = filters.assignedUserId;
      if (filters.leadStatus && filters.leadStatus !== 'ALL') query.leadStatus = filters.leadStatus;
      if (filters.search) {
        /* User input goes into a RegExp, so regex metacharacters have to be
           neutralised — an unescaped "(" is a syntax error that would surface
           as a 500 on an ordinary search. */
        const regex = new RegExp(escapeRegex(filters.search), 'i');
        query.$or = [
          { businessName: regex },
          { city: regex },
          { category: regex },
          { phone: regex },
          { email: regex },
          { address: regex },
          { landmark: regex },
        ];
      }
      return ScrapedLead.find(query).sort({ scrapedAt: -1 }).lean();
    }

    loadLocalData();
    let results = [...localLeads];
    if (filters.jobId) results = results.filter((l) => l.jobId === filters.jobId);
    if (filters.source && filters.source !== 'ALL') results = results.filter((l) => l.source === filters.source);
    if (filters.hasPhone === 'true') results = results.filter((l) => l.phone && l.phone.trim());
    if (filters.hasWebsite === 'true') results = results.filter((l) => l.hasWebsite || (l.website && l.website.length > 0));
    if (filters.assignedUserId) results = results.filter((l) => l.assignedTo && l.assignedTo.userId === filters.assignedUserId);
    if (filters.leadStatus && filters.leadStatus !== 'ALL') results = results.filter((l) => l.leadStatus === filters.leadStatus);
    if (filters.search) {
      const needle = String(filters.search).toLowerCase();
      const has = (value) => String(value || '').toLowerCase().includes(needle);
      results = results.filter((l) => has(l.businessName) || has(l.city) || has(l.category)
        || has(l.phone) || has(l.email) || has(l.address) || has(l.landmark));
    }
    return results;
  },

  async assignLeads(leadIds, userObj) {
    const now = new Date().toISOString();
    const assignedTo = { userId: userObj.userId, name: userObj.name, email: userObj.email };

    if (useMongo) {
      /* A malformed id in the list would otherwise abort the whole update
         with a CastError, losing the assignments that were perfectly valid. */
      const valid = leadIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
      if (valid.length === 0) return 0;
      const result = await ScrapedLead.updateMany(
        { _id: { $in: valid } },
        { $set: { assignedTo, assignedAt: now } },
      );
      return result.modifiedCount === undefined ? valid.length : result.modifiedCount;
    }

    loadLocalData();
    let count = 0;
    localLeads.forEach((lead) => {
      if (leadIds.includes(lead._id)) {
        lead.assignedTo = assignedTo;
        lead.assignedAt = now;
        count += 1;
      }
    });
    saveLocalData();
    return count;
  },

  async updateLeadStatus(leadId, status, noteText = '', authorName = 'User') {
    const now = new Date().toISOString();
    const note = noteText
      ? { id: newId('note'), text: noteText, authorName, createdAt: now }
      : null;

    if (useMongo) {
      if (!mongoose.Types.ObjectId.isValid(leadId)) return false;
      const update = { $set: { leadStatus: status, lastActivityAt: now } };
      if (note) update.$push = { notes: note };
      const result = await ScrapedLead.findByIdAndUpdate(leadId, update, { returnDocument: 'after' }).lean();
      return Boolean(result);
    }

    loadLocalData();
    const lead = localLeads.find((l) => l._id === leadId);
    if (!lead) return false;
    lead.leadStatus = status;
    lead.lastActivityAt = now;
    if (!Array.isArray(lead.notes)) lead.notes = [];
    if (note) lead.notes.unshift(note);
    saveLocalData();
    return true;
  },

  /* ── Aggregates ── */

  async getStats() {
    let leads;
    let jobs;
    if (useMongo) {
      [leads, jobs] = await Promise.all([ScrapedLead.find().lean(), ScrapeJob.find().lean()]);
    } else {
      loadLocalData();
      [leads, jobs] = [localLeads, localJobs];
    }

    const totalLeads = leads.length;
    const filled = (value) => Boolean(value && String(value).trim());
    const withPhoneCount = leads.filter((l) => filled(l.phone)).length;
    const withWebsiteCount = leads.filter((l) => l.hasWebsite || filled(l.website)).length;
    const percent = (n) => (totalLeads > 0 ? Math.round((n / totalLeads) * 100) : 0);

    return {
      totalLeads,
      withPhoneCount,
      phonePercentage: percent(withPhoneCount),
      withWebsiteCount,
      websitePercentage: percent(withWebsiteCount),
      withEmailCount: leads.filter((l) => filled(l.email)).length,
      assignedLeadsCount: leads.filter((l) => l.assignedTo && l.assignedTo.userId).length,
      totalJobs: jobs.length,
      completedJobs: jobs.filter((j) => j.status === 'completed').length,
    };
  },

  async getTeamStats() {
    let users;
    let leads;
    if (useMongo) {
      [users, leads] = await Promise.all([
        User.find({ role: 'EMPLOYEE' }, '-password').lean(),
        ScrapedLead.find().lean(),
      ]);
    } else {
      loadLocalData();
      users = localUsers.filter((u) => u.role === 'EMPLOYEE').map(withoutPassword);
      leads = localLeads;
    }

    const teamBreakdown = users.map((user) => {
      const owned = leads.filter((l) => l.assignedTo && l.assignedTo.userId === user.userId);
      const countOf = (status) => owned.filter((l) => l.leadStatus === status).length;
      const won = countOf('CLOSED_WON');

      return {
        user,
        totalAssigned: owned.length,
        contacted: countOf('CONTACTED'),
        qualified: countOf('QUALIFIED'),
        won,
        lost: countOf('CLOSED_LOST'),
        conversionRate: owned.length > 0 ? Math.round((won / owned.length) * 100) : 0,
      };
    });

    return {
      teamBreakdown,
      unassignedCount: leads.filter((l) => !(l.assignedTo && l.assignedTo.userId)).length,
      totalLeads: leads.length,
    };
  },
};

/* The store itself is the default export; the two boot-time helpers ride
   along on it so `require('../storage/dbStore')` is the only path anything
   needs. */
module.exports = dbStore;
module.exports.initStore = initStore;
module.exports.countUsers = countUsers;
