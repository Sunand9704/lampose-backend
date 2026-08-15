/* ══════════════════════════════════════════════════════════════════════════
   Every API call both frontends make, exercised against this backend.

   smoke-test.mjs answers "is the server healthy". This answers the different
   question "does each screen still work" — it walks the exact list of calls
   found in the two frontends' api/ folders, sends the same paths and payloads
   they send, and checks the response carries the fields the calling component
   actually reads. A 200 with a renamed field is still a broken page.

     npm run verify                    boot locally and check
     npm run verify -- --scrape        also run a real Google Maps scrape
     SMOKE_URL=https://api.lampose.com npm run verify

   Everything it creates (a temp admin, a temp lead, a temp property) is
   removed again before it exits.
   ══════════════════════════════════════════════════════════════════════════ */
import config from '../src/config/env.js';
import { connectDB, closeConnections } from '../src/config/db.js';
import { initStore } from '../src/storage/dbStore.js';
import app from '../src/app.js';

const RUN_SCRAPE = process.argv.includes('--scrape');

let server = null;
let base = process.env.SMOKE_URL?.replace(/\/+$/, '') || null;

if (!base) {
  await connectDB();
  await initStore();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

/* ── Harness ──────────────────────────────────────────────────────────── */

const rows = [];
let group = '';

const section = (title) => { group = title; rows.push({ section: title }); };

const call = async (method, path, { token, body, raw } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  /* Bytes, not text: fetch's UTF-8 decode strips a leading BOM, so
     response.text() cannot tell you whether the CSV actually carries one. */
  if (raw) {
    return {
      status: response.status,
      headers: response.headers,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, headers: response.headers, body: parsed };
};

const check = async (frontendCall, run) => {
  try {
    const detail = await run();
    rows.push({ ok: true, group, frontendCall, detail: detail || 'ok' });
  } catch (error) {
    rows.push({ ok: false, group, frontendCall, detail: error.message });
  }
};

const expect = (condition, message) => { if (!condition) throw new Error(message); };

/* The point of the whole script: a field the calling component reads must be
   present, or the screen breaks even though the request "succeeded". */
const expectFields = (object, fields, label) => {
  const missing = fields.filter((f) => object?.[f] === undefined);
  expect(missing.length === 0, `${label} is missing: ${missing.join(', ')}`);
  return `${fields.length} fields present`;
};

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const stamp = Date.now();
const adminEmail = `verify_admin_${stamp}@example.invalid`;
const created = { userIds: [], propertyIds: [], leadIds: [], jobIds: [] };
let token = null;
let adminUserId = null;

/* ══ Lampose frontend ══════════════════════════════════════════════════
   src/api/listingsApi.js — consumed by pages/Explore.jsx and Listing.jsx */

section('lampose.com  (lampose-frontend/src/api/listingsApi.js)');

/* Exactly the keys Explore.jsx and Listing.jsx read off a listing. */
const LISTING_FIELDS = [
  'id', 'name', 'place', 'city', 'locality', 'category', 'categorySlug',
  'stayType', 'longStayDuration', 'shortStayDuration', 'rent', 'pricePeriod',
  'monthlyPrice', 'dailyPrice', 'deposit', 'ownerName', 'ownerMobile',
  'address', 'amenities', 'images', 'details', 'listedAt',
];

let sampleListingId = null;

await check("listingsApi.getListings()  →  GET /listings", async () => {
  const { status, body } = await call('GET', '/api/listings');
  expect(status === 200, `expected 200, got ${status}`);
  expect(Array.isArray(body.data), 'response.data is not an array (Explore.jsx would throw)');
  if (body.data.length === 0) return '0 listings — shape not verifiable';
  sampleListingId = body.data[0].id;
  return `${body.count} listings, ${expectFields(body.data[0], LISTING_FIELDS, 'listing')}`;
});

await check("listingsApi.getListings({category, city, maxPrice, search})", async () => {
  const { status, body } = await call('GET', '/api/listings?category=PG&city=Bangalore&maxPrice=99999&search=a');
  expect(status === 200, `expected 200, got ${status}`);
  expect(Array.isArray(body.data), 'filtered response.data is not an array');
  return `${body.count} rows through all four filters`;
});

await check("listingsApi.getListingById(id)  →  GET /listings/:id", async () => {
  if (!sampleListingId) return 'skipped — no listing to fetch';
  const { status, body } = await call('GET', `/api/listings/${sampleListingId}`);
  expect(status === 200, `expected 200, got ${status}`);
  expect(body.data?.id === sampleListingId, 'response.data.id does not match the requested id');
  return expectFields(body.data, LISTING_FIELDS, 'listing');
});

await check("listingsApi.getListingById(missing)  →  must 404 so it returns null", async () => {
  const { status } = await call('GET', '/api/listings/000000000000000000000000');
  expect(status === 404, `expected 404, got ${status} (Listing.jsx would show an error, not "not found")`);
  return '404 as required';
});

await check("listingsApi.diagnose()  →  GET /health  reads body.database.connected", async () => {
  const { status, body } = await call('GET', '/api/health');
  expect([200, 503].includes(status), `unexpected status ${status}`);
  expect(typeof body.database?.connected === 'boolean', 'body.database.connected is missing');
  return `database.connected = ${body.database.connected}`;
});

/* ══ Leads panel ═══════════════════════════════════════════════════════ */

section('leads.lampose.com  (scriper-frontend/src/api/authApi.ts)');

await check("authApi.register()  →  POST /auth/register", async () => {
  const { status, body } = await call('POST', '/api/auth/register', {
    body: { name: 'Verify Admin', email: adminEmail, password: 'verify123', role: 'ADMIN', adminCode: config.auth.adminSecretKey },
  });
  expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error}`);
  expect(body.success === true, 'AuthContext.register checks res.success');
  token = body.data?.token;
  adminUserId = body.data?.user?.userId;
  created.userIds.push(adminUserId);
  expect(token, 'res.data.token is missing — AuthContext stores this as scriper_token');
  return expectFields(body.data.user, ['userId', 'name', 'email', 'role', 'avatar'], 'res.data.user');
});

await check("authApi.register()  ADMIN without adminCode must be refused", async () => {
  const { status } = await call('POST', '/api/auth/register', {
    body: { name: 'x', email: `nope_${stamp}@example.invalid`, password: 'verify123', role: 'ADMIN' },
  });
  expect(status === 403, `expected 403, got ${status}`);
  return 'refused';
});

await check("authApi.login()  →  POST /auth/login", async () => {
  const { status, body } = await call('POST', '/api/auth/login', {
    body: { email: adminEmail, password: 'verify123' },
  });
  expect(status === 200, `expected 200, got ${status}`);
  expect(body.success === true && body.data?.token, 'AuthContext.login reads res.data.token');
  expect(!('password' in body.data.user), 'the password hash is being returned to the client');
  return expectFields(body.data.user, ['userId', 'name', 'email', 'role'], 'res.data.user');
});

await check("authApi.getMe()  →  GET /auth/me  (session validation on page load)", async () => {
  const { status, body } = await call('GET', '/api/auth/me', { token });
  expect(status === 200, `expected 200, got ${status}`);
  expect(body.success === true, 'AuthContext.initAuth checks res.success && res.data');
  return expectFields(body.data, ['userId', 'name', 'email', 'role'], 'res.data');
});

await check("authApi.getMe()  with a stale token must 401 so the app logs out", async () => {
  const { status } = await call('GET', '/api/auth/me', { token: 'stale.token.value' });
  expect(status === 401, `expected 401, got ${status}`);
  return '401 → AuthContext.logout()';
});

section('leads.lampose.com  (scriper-frontend/src/api/userApi.ts)');

/* Kept alive until after the team-stats check, which needs at least one
   EMPLOYEE for AdminTeamOverview's breakdown to have a row to verify. */
let employeeUserId = null;
let employeeEmail = null;

await check("userApi.getUsers()  →  GET /users  (App.tsx fetchUsers)", async () => {
  const { status, body } = await call('GET', '/api/users', { token });
  expect(status === 200, `expected 200, got ${status}`);
  expect(body.success === true && Array.isArray(body.data), 'App.tsx checks res.success && res.data');
  return `${body.count} users`;
});

await check("userApi.createUser()  →  POST /users  (UserManagementPage)", async () => {
  employeeEmail = `verify_emp_${stamp}@example.invalid`;
  const { status, body } = await call('POST', '/api/users', {
    token,
    body: { name: 'Verify Employee', email: employeeEmail, password: 'employee123', role: 'EMPLOYEE' },
  });
  expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error}`);
  employeeUserId = body.data?.userId;
  created.userIds.push(employeeUserId);
  return expectFields(body.data, ['userId', 'name', 'email', 'role'], 'res.data');
});

await check("userApi.deleteUser()  →  DELETE /users/:userId", async () => {
  const throwaway = await call('POST', '/api/users', {
    token,
    body: { name: 'Verify Throwaway', email: `verify_tmp_${stamp}@example.invalid`, password: 'employee123', role: 'EMPLOYEE' },
  });
  const id = throwaway.body.data?.userId;
  expect(id, 'could not create a user to delete');
  // Tracked before the delete, so a failure here still gets cleaned up.
  created.userIds.push(id);
  const { status, body } = await call('DELETE', `/api/users/${id}`, { token });
  expect(status === 200 && body.success === true, `expected 200, got ${status}`);
  const after = await call('GET', '/api/users', { token });
  expect(!after.body.data.some((u) => u.userId === id), 'the user is still listed after deletion');
  return 'deleted and gone from the list';
});

section('leads.lampose.com  (scriper-frontend/src/api/propertyApi.ts)');

const PROPERTY_FIELDS = ['_id', 'name', 'place', 'category', 'rent', 'ownerName', 'ownerMobile', 'address', 'amenities', 'categoryDetails', 'imageUrl', 'stayType', 'deposit'];

await check("propertyApi.getProperties()  →  GET /properties  (AccommodationPropertiesPage)", async () => {
  const { status, body } = await call('GET', '/api/properties');
  expect(status === 200, `expected 200, got ${status}`);
  expect(body.success === true && Array.isArray(body.data), 'the page checks res.success && res.data');
  if (body.data.length === 0) return '0 properties — shape not verifiable';
  return `${body.count} properties, ${expectFields(body.data[0], PROPERTY_FIELDS, 'property')}`;
});

await check("propertyApi.getProperties({category, search})  filters", async () => {
  const { status, body } = await call('GET', '/api/properties?category=PG&search=a');
  expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
  return `${body.count} rows`;
});

await check("propertyApi.createProperty()  →  POST /properties  (PropertyFormModal)", async () => {
  /* Byte-for-byte the payload PropertyFormModal builds. */
  const { status, body } = await call('POST', '/api/properties', {
    token,
    body: {
      name: `VERIFY TEMP ${stamp}`,
      place: 'MVP Colony, Visakhapatnam',
      ownerName: 'Verify Owner',
      ownerMobile: '9876543210',
      category: 'PG',
      stayType: 'Long Stay',
      dailyPrice: 0,
      monthlyPrice: 8000,
      rent: 8000,
      deposit: 16000,
      address: 'Plot 1',
      imageUrl: 'https://images.unsplash.com/photo-1555854877-bab0e564b8d5',
      amenities: ['WiFi'],
      categoryDetails: { foodIncluded: true, foodType: 'Veg', sharingTypes: ['2 Sharing'], curfewTime: '10 PM' },
    },
  });
  expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error}`);
  expect(body.success === true, 'PropertyFormModal checks res.success');
  created.propertyIds.push(body.data._id);
  return expectFields(body.data, PROPERTY_FIELDS, 'res.data');
});

await check("propertyApi.getPropertyById()  →  GET /properties/:id  (PropertyDetailModal)", async () => {
  const id = created.propertyIds[0];
  const { status, body } = await call('GET', `/api/properties/${id}`);
  expect(status === 200 && body.data?._id === id, `expected 200, got ${status}`);
  return expectFields(body.data, PROPERTY_FIELDS, 'res.data');
});

await check("a property onboarded here appears on lampose.com's Explore feed", async () => {
  const { body } = await call('GET', `/api/listings?search=VERIFY TEMP ${stamp}`);
  const found = body.data?.find((l) => l.id === created.propertyIds[0]);
  expect(found, 'the new property is not in /listings — the two apps are not sharing the collection');
  expect(found.city === 'Visakhapatnam', `city derived as "${found.city}", expected Visakhapatnam`);
  return `visible as "${found.name}" in ${found.city}`;
});

await check("propertyApi.deleteProperty()  →  DELETE /properties/:id", async () => {
  const id = created.propertyIds[0];
  const { status, body } = await call('DELETE', `/api/properties/${id}`, { token });
  expect(status === 200 && body.success === true, `expected 200, got ${status}`);
  created.propertyIds = [];
  return 'deleted';
});

section('leads.lampose.com  (scriper-frontend/src/api/scraperApi.ts)');

/* The leads screens need a lead to render. One is inserted directly and
   removed at the end, so the checks below are about response shape rather
   than about whatever happens to be in the database. */
const { ScrapedLead, ScrapeJob } = await import('../src/models/scriper.js');
const fixtureJobId = `job_verify_${stamp}`;
let fixtureLeadId = null;

if (config.storage.mode === 'mongo') {
  const job = await ScrapeJob.create({
    jobId: fixtureJobId, name: 'verify fixture', source: 'GoogleMaps',
    query: 'PG', location: 'Visakhapatnam', depth: 1, status: 'completed',
    progress: 100, statusMessage: 'fixture', resultCount: 1,
  });
  created.jobIds.push(job.jobId);
  const lead = await ScrapedLead.create({
    jobId: fixtureJobId, source: 'GoogleMaps', businessName: `Verify Fixture ${stamp}`,
    phone: '9876543210', email: '', website: 'https://example.invalid', hasWebsite: true,
    address: 'MVP Colony', rating: '4.2', reviewsCount: 10, category: 'PG',
    city: 'Visakhapatnam', landmark: 'MVP', mapsUrl: 'https://maps.google.com/?q=1,1',
  });
  fixtureLeadId = String(lead._id);
  created.leadIds.push(fixtureLeadId);
}

const LEAD_FIELDS = ['_id', 'jobId', 'source', 'businessName', 'phone', 'email', 'website', 'hasWebsite', 'address', 'rating', 'reviewsCount', 'category', 'city', 'landmark', 'mapsUrl', 'scrapedAt', 'assignedTo', 'leadStatus', 'notes'];

await check("scraperApi.getLeads()  →  GET /scraper/leads  (ScrapedLeadsDashboard)", async () => {
  const { status, body } = await call('GET', '/api/scraper/leads');
  expect(status === 200, `expected 200, got ${status}`);
  expect(body.success === true && Array.isArray(body.data), 'the page checks res.success && res.data');
  if (body.data.length === 0) return '0 leads — shape not verifiable';
  return `${body.count} leads, ${expectFields(body.data[0], LEAD_FIELDS, 'lead')}`;
});

await check("scraperApi.getLeads(all 7 filters)  →  the dashboard's filter bar", async () => {
  const query = `jobId=${fixtureJobId}&source=GoogleMaps&hasPhone=true&hasWebsite=true&leadStatus=NEW&search=Verify&assignedUserId=`;
  const { status, body } = await call('GET', `/api/scraper/leads?${query}`);
  expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
  return `${body.count} rows through every filter`;
});

await check("scraperApi.assignLeads()  →  POST /scraper/assign  (AssignLeadsModal)", async () => {
  if (!fixtureLeadId) return 'skipped — JSON store mode';
  const { status, body } = await call('POST', '/api/scraper/assign', {
    body: { leadIds: [fixtureLeadId], userObj: { userId: employeeUserId, name: 'Verify Employee', email: employeeEmail } },
  });
  expect(status === 200 && body.success === true, `expected 200, got ${status}: ${body.error}`);
  const after = await call('GET', `/api/scraper/leads?jobId=${fixtureJobId}`);
  expect(after.body.data[0]?.assignedTo?.userId === employeeUserId, 'assignedTo was not persisted');
  return 'assigned to an employee and persisted';
});

await check("scraperApi.updateLeadStatus()  →  PATCH /scraper/leads/:id/status  (LeadStatusModal)", async () => {
  if (!fixtureLeadId) return 'skipped — JSON store mode';
  const { status, body } = await call('PATCH', `/api/scraper/leads/${fixtureLeadId}/status`, {
    body: { status: 'CONTACTED', noteText: 'called the owner', authorName: 'Verify Admin' },
  });
  expect(status === 200 && body.success === true, `expected 200, got ${status}`);
  const after = await call('GET', `/api/scraper/leads?jobId=${fixtureJobId}`);
  const lead = after.body.data[0];
  expect(lead.leadStatus === 'CONTACTED', `status is ${lead.leadStatus}`);
  expect(lead.notes?.length === 1, 'the note was not appended');
  return 'status + note persisted';
});

await check("scraperApi.getJobs()  →  GET /scraper/jobs  (ScrapeHistoryPage)", async () => {
  const { status, body } = await call('GET', '/api/scraper/jobs');
  expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
  if (body.data.length === 0) return '0 jobs — shape not verifiable';
  return `${body.count} jobs, ${expectFields(body.data[0], ['jobId', 'name', 'source', 'status', 'progress', 'statusMessage', 'resultCount', 'createdAt'], 'job')}`;
});

await check("scraperApi.getStats()  →  GET /scraper/stats  (DashboardOverview)", async () => {
  const { status, body } = await call('GET', '/api/scraper/stats');
  expect(status === 200 && body.success === true, `expected 200, got ${status}`);
  return expectFields(body.data, ['totalLeads', 'withPhoneCount', 'phonePercentage', 'withWebsiteCount', 'websitePercentage', 'withEmailCount', 'assignedLeadsCount', 'totalJobs', 'completedJobs'], 'DashboardStats');
});

await check("scraperApi.getTeamStats()  →  GET /scraper/team-stats  (AdminTeamOverview)", async () => {
  const { status, body } = await call('GET', '/api/scraper/team-stats');
  expect(status === 200 && body.success === true, `expected 200, got ${status}`);
  expectFields(body.data, ['teamBreakdown', 'unassignedCount', 'totalLeads'], 'TeamStatsResponse');
  const mine = body.data.teamBreakdown.find((m) => m.user?.userId === employeeUserId);
  expect(mine, 'the employee created above is missing from teamBreakdown');
  expectFields(mine, ['user', 'totalAssigned', 'contacted', 'qualified', 'won', 'lost', 'conversionRate'], 'TeamMemberBreakdown');
  /* The lead assigned above was then moved to CONTACTED, so these two
     numbers prove the aggregation actually reflects the writes. */
  expect(mine.totalAssigned === 1, `totalAssigned is ${mine.totalAssigned}, expected 1`);
  expect(mine.contacted === 1, `contacted is ${mine.contacted}, expected 1`);
  return `breakdown correct: assigned=${mine.totalAssigned} contacted=${mine.contacted}, ${body.data.teamBreakdown.length} member(s)`;
});

await check("scraperApi.getExportUrl('csv')  →  window.open, so it must work with no Authorization header", async () => {
  const { status, headers, bytes } = await call('GET', `/api/scraper/export?format=csv&jobId=${fixtureJobId}`, { raw: true });
  expect(status === 200, `expected 200, got ${status} — the export button opens a plain browser tab`);
  expect(headers.get('content-disposition')?.includes('attachment'), 'no attachment disposition, the browser would render it');
  /* The BOM is what makes Excel read the file as UTF-8 instead of the system
     codepage, which otherwise mangles every non-ASCII business name. */
  expect(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'the UTF-8 BOM is missing — Excel will mangle non-ASCII names');
  const text = bytes.subarray(3).toString('utf8');
  expect(text.startsWith('"Business Name"'), `unexpected header row: ${text.slice(0, 40)}`);
  return `BOM + ${text.split('\r\n').length - 1} data row(s), Excel-safe`;
});

await check("scraperApi.getExportUrl('json')", async () => {
  const { status, headers } = await call('GET', '/api/scraper/export?format=json', { raw: true });
  expect(status === 200 && headers.get('content-disposition')?.includes('.json'), `expected a json attachment, got ${status}`);
  return 'downloads';
});

await check("scraperApi.startScrape()  →  POST /scraper/start  validates its inputs", async () => {
  const { status } = await call('POST', '/api/scraper/start', { body: { query: 'PG' } });
  expect(status === 400, `expected 400 for a missing location, got ${status}`);
  return '400 when query or location is missing';
});

if (RUN_SCRAPE) {
  await check("scraperApi.startScrape()  →  a real Google Maps scrape, end to end", async () => {
    const start = await call('POST', '/api/scraper/start', {
      body: { query: 'PG', location: 'Visakhapatnam', landmark: 'MVP Colony', source: 'GoogleMaps', depth: 3 },
    });
    expect(start.status === 200, `start failed: ${start.status} ${start.body.error}`);
    const jobId = start.body.data?.jobId;
    expect(jobId, 'ScraperSearchPage reads res.data.jobId');
    created.jobIds.push(jobId);

    // LiveProgressModal polls getStatus until status is terminal.
    let last = null;
    for (let i = 0; i < 45; i += 1) {
      await new Promise((r) => { setTimeout(r, 4000); });
      const poll = await call('GET', `/api/scraper/status/${jobId}`);
      expect(poll.status === 200, `status poll failed: ${poll.status}`);
      last = poll.body.data;
      expectFields(last, ['jobId', 'name', 'status', 'progress', 'statusMessage', 'resultCount'], 'status');
      if (['completed', 'error', 'stopped'].includes(last.status)) break;
    }
    expect(last.status === 'completed', `job ended as "${last.status}": ${last.statusMessage}`);

    const leads = await call('GET', `/api/scraper/leads?jobId=${jobId}`);
    expect(leads.body.count > 0, 'the job completed but saved no leads');
    for (const lead of leads.body.data) created.leadIds.push(String(lead._id));
    expectFields(leads.body.data[0], LEAD_FIELDS, 'scraped lead');
    return `${leads.body.count} real leads, e.g. "${leads.body.data[0].businessName}" ${leads.body.data[0].phone}`;
  });
} else {
  await check("scraperApi.startScrape()  →  the Playwright engine is installed", async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const version = browser.version();
    await browser.close();
    return `Chromium ${version} launches (pass --scrape to run a live scrape)`;
  });
}

await check("scraperApi.stopJob()  →  POST /scraper/stop/:jobId", async () => {
  const { status, body } = await call('POST', `/api/scraper/stop/${fixtureJobId}`);
  expect(status === 200 && body.success === true, `expected 200, got ${status}`);
  return 'accepted';
});

await check("scraperApi.getStatus()  →  GET /scraper/status/:jobId", async () => {
  const { status, body } = await call('GET', `/api/scraper/status/${fixtureJobId}`);
  expect(status === 200, `expected 200, got ${status}`);
  return expectFields(body.data, ['jobId', 'name', 'status', 'progress', 'statusMessage', 'resultCount'], 'status');
});

/* ── Cleanup ──────────────────────────────────────────────────────────── */

let cleanupError = null;
try {
  const { User } = await import('../src/models/scriper.js');
  const Property = (await import('../src/models/Property.js')).default;
  if (config.storage.mode === 'mongo') {
    if (created.leadIds.length) await ScrapedLead.deleteMany({ _id: { $in: created.leadIds } });
    if (created.jobIds.length) await ScrapeJob.deleteMany({ jobId: { $in: created.jobIds } });
    if (created.userIds.filter(Boolean).length) await User.deleteMany({ userId: { $in: created.userIds.filter(Boolean) } });
  }
  if (created.propertyIds.length) await Property.deleteMany({ _id: { $in: created.propertyIds } });
} catch (error) {
  cleanupError = error.message;
}

/* ── Report ───────────────────────────────────────────────────────────── */

console.log();
for (const row of rows) {
  if (row.section) { console.log(`\n  ${row.section}\n  ${'─'.repeat(row.section.length)}`); continue; }
  console.log(`   ${row.ok ? '✓' : '✗'} ${row.frontendCall}`);
  console.log(`       ${row.detail}`);
}

const checks = rows.filter((r) => !r.section);
const failed = checks.filter((r) => !r.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} frontend calls verified`
  + `${RUN_SCRAPE ? '' : '  (run with --scrape to include a live scrape)'}\n`);
if (cleanupError) console.error(`  WARNING: cleanup failed — ${cleanupError}\n`);

if (server) {
  server.close();
  await closeConnections();
}
process.exitCode = failed.length ? 1 : 0;
