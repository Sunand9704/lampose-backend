/* ══════════════════════════════════════════════════════════════════════════
   Leads-panel schemas: users, scrape jobs, scraped leads.

   These share one database with the onboarding collections, so every
   collection name is pinned with a `scriper_` prefix instead of being left to
   mongoose's pluraliser. The reason survives the merge: the onboarding side
   keeps its own accounts in `admins`, and an unprefixed `users` here would be
   one rename away from two apps with different schemas sharing one
   collection — logins would start behaving strangely for reasons nobody could
   find. A prefix makes that impossible.
   ══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['ADMIN', 'EMPLOYEE'], default: 'EMPLOYEE' },
    avatar: { type: String, default: '' },
  },
  { timestamps: true, collection: 'scriper_users' },
);

const scrapeJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: 'Untitled Scrape Mission' },
    source: { type: String, enum: ['GoogleMaps', 'JustDial', 'Web'], default: 'GoogleMaps' },
    query: String,
    location: String,
    landmark: String,
    depth: Number,
    status: {
      type: String,
      enum: ['started', 'running', 'completed', 'stopped', 'error'],
      default: 'started',
    },
    progress: { type: Number, default: 0 },
    statusMessage: { type: String, default: 'Initialized' },
    resultCount: { type: Number, default: 0 },
    error: String,
  },
  { timestamps: true, collection: 'scriper_jobs' },
);

const scrapedLeadSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, index: true },
    source: { type: String, enum: ['GoogleMaps', 'JustDial', 'Web'], required: true },
    businessName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
    website: { type: String, default: '' },
    hasWebsite: { type: Boolean, default: false },
    address: { type: String, default: '' },
    rating: { type: String, default: '' },
    reviewsCount: { type: Number, default: 0 },
    category: { type: String, default: '' },
    city: { type: String, default: '' },
    landmark: { type: String, default: '' },
    latitude: Number,
    longitude: Number,
    // Direct Google Maps deep-link for this business location
    mapsUrl: { type: String, default: '' },
    scrapedAt: { type: Date, default: Date.now },
    assignedTo: {
      userId: { type: String, default: null },
      name: { type: String, default: null },
      email: { type: String, default: null },
    },
    assignedAt: Date,
    leadStatus: {
      type: String,
      enum: ['NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'CALLBACK', 'CLOSED_WON', 'CLOSED_LOST'],
      default: 'NEW',
    },
    notes: [{
      id: String,
      text: String,
      authorName: String,
      createdAt: { type: Date, default: Date.now },
    }],
    lastActivityAt: Date,
  },
  { timestamps: true, collection: 'scriper_leads' },
);

/* The leads table is always read newest-first and filtered by owner or
   status; these are the two access paths the dashboard actually uses. */
scrapedLeadSchema.index({ scrapedAt: -1 });
scrapedLeadSchema.index({ 'assignedTo.userId': 1, leadStatus: 1 });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const ScrapeJob = mongoose.models.ScrapeJob || mongoose.model('ScrapeJob', scrapeJobSchema);
const ScrapedLead = mongoose.models.ScrapedLead
  || mongoose.model('ScrapedLead', scrapedLeadSchema);

module.exports = { User, ScrapeJob, ScrapedLead };
