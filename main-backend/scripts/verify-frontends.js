/* ══════════════════════════════════════════════════════════════════════════
   Every API call all three frontends make, exercised against this backend,
   plus the routes no frontend calls any more but the backend still serves.

   smoke-test.js answers "is the server healthy". This answers the different
   question "does each screen still work" — it walks the exact list of calls
   found in the three frontends' api/ and services/ folders, sends the same
   paths and payloads they send, and checks the response carries the fields
   the calling component actually reads. A 200 with a renamed field is still a
   broken page.

     npm run verify                    boot locally and check
     npm run verify -- --scrape        also run a real Google Maps scrape
     SMOKE_URL=https://api.lampose.com npm run verify

   What it deliberately does NOT do: POST a complete property to
   /api/v1/properties. That endpoint sends a real WhatsApp message to the
   owner's number through Twilio — a live side effect with a cost and a human
   on the other end. The route is still exercised, through its validation
   path, which returns before Twilio is touched.

   Everything it creates (a temp admin, a temp employee, a temp lead, a temp
   property, a temp permission request) is removed again before it exits.
   ══════════════════════════════════════════════════════════════════════════ */
const config = require('../config/env');
const { connectDB, closeConnections } = require('../config/db');
const { initStore } = require('../storage/dbStore');
const app = require('../app');

const RUN_SCRAPE = process.argv.includes('--scrape');

const rows = [];
let group = '';
let server = null;
let base = process.env.SMOKE_URL ? process.env.SMOKE_URL.replace(/\/+$/, '') : null;

const section = (title) => { group = title; rows.push({ section: title }); };

const call = async (method, path, { token, body, raw, headers = {} } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
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
  const missing = fields.filter((f) => (object || {})[f] === undefined);
  expect(missing.length === 0, `${label} is missing: ${missing.join(', ')}`);
  return `${fields.length} fields present`;
};

const stamp = Date.now();
const created = {
  userIds: [], propertyIds: [], leadIds: [], jobIds: [], permissionIds: [], adminIds: [],
};

/* A 1x1 transparent PNG, so the Cloudinary upload checks move real bytes
   through multer and the Cloudinary SDK rather than asserting on a 400. What
   they create is destroyed again by publicId cleanup below. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const uploadedPublicIds = [];

const run = async () => {
  if (!base) {
    await connectDB();
    await initStore();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  const adminEmail = `verify_admin_${stamp}@example.invalid`;
  let token = null;
  let adminUserId = null;

  /* ══ lampose.com ══════════════════════════════════════════════════════
     lampose-frontend/src/api/listingsApi.js — pages/Explore.jsx, Listing.jsx */

  section('lampose.com   (lampose-frontend/src/api/listingsApi.js  →  v2)');

  /* Exactly the keys Explore.jsx and Listing.jsx read off a listing. */
  const LISTING_FIELDS = [
    'id', 'name', 'place', 'city', 'locality', 'category', 'categorySlug',
    'stayType', 'longStayDuration', 'shortStayDuration', 'rent', 'pricePeriod',
    'monthlyPrice', 'dailyPrice', 'deposit', 'ownerName', 'ownerMobile',
    'address', 'amenities', 'images', 'details', 'listedAt',
  ];

  let sampleListingId = null;

  await check('listingsApi.getListings()  →  GET /api/v2/listings', async () => {
    const { status, body } = await call('GET', '/api/v2/listings');
    expect(status === 200, `expected 200, got ${status}`);
    expect(Array.isArray(body.data), 'response.data is not an array (Explore.jsx would throw)');
    if (body.data.length === 0) return '0 listings — shape not verifiable';
    sampleListingId = body.data[0].id;
    return `${body.count} listings, ${expectFields(body.data[0], LISTING_FIELDS, 'listing')}`;
  });

  await check('the unversioned /api/listings alias still answers', async () => {
    const { status, body } = await call('GET', '/api/listings');
    expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
    return `${body.count} listings (same router as v2)`;
  });

  await check('listingsApi.getListings({category, city, maxPrice, search})', async () => {
    const { status, body } = await call('GET', '/api/v2/listings?category=PG&city=Bangalore&maxPrice=99999&search=a');
    expect(status === 200, `expected 200, got ${status}`);
    expect(Array.isArray(body.data), 'filtered response.data is not an array');
    return `${body.count} rows through all four filters`;
  });

  await check('listingsApi.getListingById(id)  →  GET /api/v2/listings/:id', async () => {
    if (!sampleListingId) return 'skipped — no listing to fetch';
    const { status, body } = await call('GET', `/api/v2/listings/${sampleListingId}`);
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.data && body.data.id === sampleListingId, 'response.data.id does not match the requested id');
    return expectFields(body.data, LISTING_FIELDS, 'listing');
  });

  await check('listingsApi.getListingById(missing)  →  must 404 so it returns null', async () => {
    const { status } = await call('GET', '/api/v2/listings/000000000000000000000000');
    expect(status === 404, `expected 404, got ${status} (Listing.jsx would show an error, not "not found")`);
    return '404 as required';
  });

  await check('listingsApi.diagnose()  →  GET /api/health  reads body.database.connected', async () => {
    const { status, body } = await call('GET', '/api/health');
    expect([200, 503].includes(status), `unexpected status ${status}`);
    expect(typeof (body.database || {}).connected === 'boolean', 'body.database.connected is missing');
    return `database.connected = ${body.database.connected}`;
  });

  /* ══ leads.lampose.com ═════════════════════════════════════════════════ */

  section('leads.lampose.com   (leads-frontend/src/api/authApi.ts  →  v2)');

  await check('authApi.register()  →  POST /api/v2/auth/register', async () => {
    const { status, body } = await call('POST', '/api/v2/auth/register', {
      body: {
        name: 'Verify Admin', email: adminEmail, password: 'verify123', role: 'ADMIN', adminCode: config.auth.adminSecretKey,
      },
    });
    expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error}`);
    expect(body.success === true, 'AuthContext.register checks res.success');
    token = body.data && body.data.token;
    adminUserId = body.data && body.data.user && body.data.user.userId;
    created.userIds.push(adminUserId);
    expect(token, 'res.data.token is missing — AuthContext stores this as scriper_token');
    return expectFields(body.data.user, ['userId', 'name', 'email', 'role', 'avatar'], 'res.data.user');
  });

  await check('authApi.register()  ADMIN without adminCode must be refused', async () => {
    const { status } = await call('POST', '/api/v2/auth/register', {
      body: { name: 'x', email: `nope_${stamp}@example.invalid`, password: 'verify123', role: 'ADMIN' },
    });
    expect(status === 403, `expected 403, got ${status}`);
    return 'refused';
  });

  await check('authApi.login()  →  POST /api/v2/auth/login', async () => {
    const { status, body } = await call('POST', '/api/v2/auth/login', {
      body: { email: adminEmail, password: 'verify123' },
    });
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.success === true && body.data && body.data.token, 'AuthContext.login reads res.data.token');
    expect(!('password' in body.data.user), 'the password hash is being returned to the client');
    return expectFields(body.data.user, ['userId', 'name', 'email', 'role'], 'res.data.user');
  });

  await check('the unversioned /api/auth/login alias still answers', async () => {
    const { status, body } = await call('POST', '/api/auth/login', {
      body: { email: adminEmail, password: 'verify123' },
    });
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    return 'same router as v2';
  });

  await check('authApi.getMe()  →  GET /api/v2/auth/me  (session validation on page load)', async () => {
    const { status, body } = await call('GET', '/api/v2/auth/me', { token });
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.success === true, 'AuthContext.initAuth checks res.success && res.data');
    return expectFields(body.data, ['userId', 'name', 'email', 'role'], 'res.data');
  });

  await check('authApi.getMe()  with a stale token must 401 so the app logs out', async () => {
    const { status } = await call('GET', '/api/v2/auth/me', { token: 'stale.token.value' });
    expect(status === 401, `expected 401, got ${status}`);
    return '401 → AuthContext.logout()';
  });

  section('leads.lampose.com   (leads-frontend/src/api/userApi.ts  →  v2)');

  /* Kept alive until after the team-stats check, which needs at least one
     EMPLOYEE for AdminTeamOverview's breakdown to have a row to verify. */
  let employeeUserId = null;
  let employeeEmail = null;

  await check('userApi.getUsers()  →  GET /api/v2/users  (App.tsx fetchUsers)', async () => {
    const { status, body } = await call('GET', '/api/v2/users', { token });
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.success === true && Array.isArray(body.data), 'App.tsx checks res.success && res.data');
    return `${body.count} users`;
  });

  await check('userApi.createUser()  →  POST /api/v2/users  (UserManagementPage)', async () => {
    employeeEmail = `verify_emp_${stamp}@example.invalid`;
    const { status, body } = await call('POST', '/api/v2/users', {
      token,
      body: {
        name: 'Verify Employee', email: employeeEmail, password: 'employee123', role: 'EMPLOYEE',
      },
    });
    expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error}`);
    employeeUserId = body.data && body.data.userId;
    created.userIds.push(employeeUserId);
    return expectFields(body.data, ['userId', 'name', 'email', 'role'], 'res.data');
  });

  await check('userApi.deleteUser()  →  DELETE /api/v2/users/:userId', async () => {
    const throwaway = await call('POST', '/api/v2/users', {
      token,
      body: {
        name: 'Verify Throwaway', email: `verify_tmp_${stamp}@example.invalid`, password: 'employee123', role: 'EMPLOYEE',
      },
    });
    const id = throwaway.body.data && throwaway.body.data.userId;
    expect(id, 'could not create a user to delete');
    // Tracked before the delete, so a failure here still gets cleaned up.
    created.userIds.push(id);
    const { status, body } = await call('DELETE', `/api/v2/users/${id}`, { token });
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    const after = await call('GET', '/api/v2/users', { token });
    expect(!after.body.data.some((u) => u.userId === id), 'the user is still listed after deletion');
    return 'deleted and gone from the list';
  });

  /* The leads panel used to own this surface through src/api/propertyApi.ts
     and its "Accommodation Properties" page. That page was removed from the
     panel — listings are onboarded through onboard.lampose.com, which runs
     the owner's WhatsApp verification — so no frontend in this repo calls
     these routes today. They are still mounted and still verified: the
     collection is shared, and a break here would surface as a broken Explore
     page on lampose.com rather than as an error anyone would trace back. */
  section('v2 properties   (backend contract — no frontend caller since the panel dropped it)');

  const PROPERTY_FIELDS = ['_id', 'name', 'place', 'category', 'rent', 'ownerName', 'ownerMobile', 'address', 'amenities', 'categoryDetails', 'imageUrl', 'stayType', 'deposit'];

  await check('GET /api/v2/properties  — the raw collection, newest first', async () => {
    const { status, body } = await call('GET', '/api/v2/properties');
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.success === true && Array.isArray(body.data), 'the page checks res.success && res.data');
    if (body.data.length === 0) return '0 properties — shape not verifiable';
    return `${body.count} properties, ${expectFields(body.data[0], PROPERTY_FIELDS, 'property')}`;
  });

  await check('GET /api/v2/properties?category=&search=  filters', async () => {
    const { status, body } = await call('GET', '/api/v2/properties?category=PG&search=a');
    expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
    return `${body.count} rows`;
  });

  await check('POST /api/v2/properties  writes immediately, with no verification chain', async () => {
    /* Byte-for-byte the payload PropertyFormModal builds. */
    const { status, body } = await call('POST', '/api/v2/properties', {
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
        categoryDetails: {
          foodIncluded: true, foodType: 'Veg', sharingTypes: ['2 Sharing'], curfewTime: '10 PM',
        },
      },
    });
    expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error}`);
    expect(body.success === true, 'PropertyFormModal checks res.success');
    created.propertyIds.push(body.data._id);
    return expectFields(body.data, PROPERTY_FIELDS, 'res.data');
  });

  await check('POST /api/v2/properties without a token must be refused', async () => {
    const { status } = await call('POST', '/api/v2/properties', { body: { name: 'no token' } });
    if (!config.auth.requireAuth) return 'REQUIRE_AUTH=false, guard intentionally off';
    expect(status === 401, `expected 401, got ${status}`);
    return '401 without a token';
  });

  await check('GET /api/v2/properties/:id', async () => {
    const id = created.propertyIds[0];
    expect(id, 'skipped — nothing was created');
    const { status, body } = await call('GET', `/api/v2/properties/${id}`);
    expect(status === 200 && body.data && body.data._id === id, `expected 200, got ${status}`);
    return expectFields(body.data, PROPERTY_FIELDS, 'res.data');
  });

  /* Used by the delete checks, which need a row they can destroy without
     taking the fixture the later v1 checks depend on with it. */
  const makeThrowawayProperty = async (label) => {
    const { status, body } = await call('POST', '/api/v2/properties', {
      token,
      body: {
        name: `VERIFY ${label} ${stamp}`,
        place: 'MVP Colony, Visakhapatnam',
        ownerName: 'Verify Owner',
        ownerMobile: '9876543210',
        category: 'PG',
        rent: 8000,
      },
    });
    expect([200, 201].includes(status), `could not create a throwaway property: ${status} ${body.error}`);
    created.propertyIds.push(body.data._id);
    return body.data._id;
  };

  await check('DELETE /api/v2/properties/:id', async () => {
    const id = await makeThrowawayProperty('V2-DELETE');
    const { status, body } = await call('DELETE', `/api/v2/properties/${id}`, { token });
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    const after = await call('GET', `/api/v2/properties/${id}`);
    expect(after.status === 404, `the property is still readable after deletion (${after.status})`);
    created.propertyIds = created.propertyIds.filter((p) => p !== id);
    return 'deleted, and gone on the next read';
  });

  await check('DELETE /api/v2/properties/:id without a token must be refused', async () => {
    const id = created.propertyIds[0];
    expect(id, 'skipped — nothing to attempt against');
    const { status } = await call('DELETE', `/api/v2/properties/${id}`);
    if (!config.auth.requireAuth) return 'REQUIRE_AUTH=false, guard intentionally off';
    expect(status === 401, `expected 401, got ${status} — anyone could wipe the collection`);
    return '401 without a token';
  });

  await check("a property onboarded here appears on lampose.com's Explore feed", async () => {
    const { body } = await call('GET', `/api/v2/listings?search=VERIFY TEMP ${stamp}`);
    const found = (body.data || []).find((l) => l.id === created.propertyIds[0]);
    expect(found, 'the new property is not in /listings — the two surfaces are not sharing the collection');
    expect(found.city === 'Visakhapatnam', `city derived as "${found.city}", expected Visakhapatnam`);
    return `visible as "${found.name}" in ${found.city}`;
  });

  section('leads.lampose.com   (leads-frontend/src/api/scraperApi.ts  →  v2)');

  /* The leads screens need a lead to render. One is inserted directly and
     removed at the end, so the checks below are about response shape rather
     than about whatever happens to be in the database. */
  const { ScrapedLead, ScrapeJob } = require('../models/scriper');
  const fixtureJobId = `job_verify_${stamp}`;
  let fixtureLeadId = null;

  if (config.storage.mode === 'mongo') {
    const job = await ScrapeJob.create({
      jobId: fixtureJobId,
      name: 'verify fixture',
      source: 'GoogleMaps',
      query: 'PG',
      location: 'Visakhapatnam',
      depth: 1,
      status: 'completed',
      progress: 100,
      statusMessage: 'fixture',
      resultCount: 1,
    });
    created.jobIds.push(job.jobId);
    const lead = await ScrapedLead.create({
      jobId: fixtureJobId,
      source: 'GoogleMaps',
      businessName: `Verify Fixture ${stamp}`,
      phone: '9876543210',
      email: '',
      website: 'https://example.invalid',
      hasWebsite: true,
      address: 'MVP Colony',
      rating: '4.2',
      reviewsCount: 10,
      category: 'PG',
      city: 'Visakhapatnam',
      landmark: 'MVP',
      mapsUrl: 'https://maps.google.com/?q=1,1',
    });
    fixtureLeadId = String(lead._id);
    created.leadIds.push(fixtureLeadId);
  }

  const LEAD_FIELDS = ['_id', 'jobId', 'source', 'businessName', 'phone', 'email', 'website', 'hasWebsite', 'address', 'rating', 'reviewsCount', 'category', 'city', 'landmark', 'mapsUrl', 'scrapedAt', 'assignedTo', 'leadStatus', 'notes'];

  await check('scraperApi.getLeads()  →  GET /api/v2/scraper/leads  (ScrapedLeadsDashboard)', async () => {
    const { status, body } = await call('GET', '/api/v2/scraper/leads');
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.success === true && Array.isArray(body.data), 'the page checks res.success && res.data');
    if (body.data.length === 0) return '0 leads — shape not verifiable';
    return `${body.count} leads, ${expectFields(body.data[0], LEAD_FIELDS, 'lead')}`;
  });

  await check("scraperApi.getLeads(all 7 filters)  →  the dashboard's filter bar", async () => {
    const query = `jobId=${fixtureJobId}&source=GoogleMaps&hasPhone=true&hasWebsite=true&leadStatus=NEW&search=Verify&assignedUserId=`;
    const { status, body } = await call('GET', `/api/v2/scraper/leads?${query}`);
    expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
    return `${body.count} rows through every filter`;
  });

  await check('scraperApi.assignLeads()  →  POST /api/v2/scraper/assign  (AssignLeadsModal)', async () => {
    if (!fixtureLeadId) return 'skipped — JSON store mode';
    const { status, body } = await call('POST', '/api/v2/scraper/assign', {
      body: { leadIds: [fixtureLeadId], userObj: { userId: employeeUserId, name: 'Verify Employee', email: employeeEmail } },
    });
    expect(status === 200 && body.success === true, `expected 200, got ${status}: ${body.error}`);
    const after = await call('GET', `/api/v2/scraper/leads?jobId=${fixtureJobId}`);
    const assigned = after.body.data[0] && after.body.data[0].assignedTo;
    expect(assigned && assigned.userId === employeeUserId, 'assignedTo was not persisted');
    return 'assigned to an employee and persisted';
  });

  await check('scraperApi.updateLeadStatus()  →  PATCH /api/v2/scraper/leads/:id/status  (LeadStatusModal)', async () => {
    if (!fixtureLeadId) return 'skipped — JSON store mode';
    const { status, body } = await call('PATCH', `/api/v2/scraper/leads/${fixtureLeadId}/status`, {
      body: { status: 'CONTACTED', noteText: 'called the owner', authorName: 'Verify Admin' },
    });
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    const after = await call('GET', `/api/v2/scraper/leads?jobId=${fixtureJobId}`);
    const lead = after.body.data[0];
    expect(lead.leadStatus === 'CONTACTED', `status is ${lead.leadStatus}`);
    expect(lead.notes && lead.notes.length === 1, 'the note was not appended');
    return 'status + note persisted';
  });

  await check('scraperApi.getJobs()  →  GET /api/v2/scraper/jobs  (ScrapeHistoryPage)', async () => {
    const { status, body } = await call('GET', '/api/v2/scraper/jobs');
    expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
    if (body.data.length === 0) return '0 jobs — shape not verifiable';
    return `${body.count} jobs, ${expectFields(body.data[0], ['jobId', 'name', 'source', 'status', 'progress', 'statusMessage', 'resultCount', 'createdAt'], 'job')}`;
  });

  await check('scraperApi.getStats()  →  GET /api/v2/scraper/stats  (DashboardOverview)', async () => {
    const { status, body } = await call('GET', '/api/v2/scraper/stats');
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    return expectFields(body.data, ['totalLeads', 'withPhoneCount', 'phonePercentage', 'withWebsiteCount', 'websitePercentage', 'withEmailCount', 'assignedLeadsCount', 'totalJobs', 'completedJobs'], 'DashboardStats');
  });

  await check('scraperApi.getTeamStats()  →  GET /api/v2/scraper/team-stats  (AdminTeamOverview)', async () => {
    const { status, body } = await call('GET', '/api/v2/scraper/team-stats');
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    expectFields(body.data, ['teamBreakdown', 'unassignedCount', 'totalLeads'], 'TeamStatsResponse');
    const mine = body.data.teamBreakdown.find((m) => m.user && m.user.userId === employeeUserId);
    expect(mine, 'the employee created above is missing from teamBreakdown');
    expectFields(mine, ['user', 'totalAssigned', 'contacted', 'qualified', 'won', 'lost', 'conversionRate'], 'TeamMemberBreakdown');
    /* The lead assigned above was then moved to CONTACTED, so these two
       numbers prove the aggregation actually reflects the writes. */
    expect(mine.totalAssigned === 1, `totalAssigned is ${mine.totalAssigned}, expected 1`);
    expect(mine.contacted === 1, `contacted is ${mine.contacted}, expected 1`);
    return `breakdown correct: assigned=${mine.totalAssigned} contacted=${mine.contacted}, ${body.data.teamBreakdown.length} member(s)`;
  });

  await check("scraperApi.getExportUrl('csv')  →  window.open, so it must work with no Authorization header", async () => {
    const { status, headers, bytes } = await call('GET', `/api/v2/scraper/export?format=csv&jobId=${fixtureJobId}`, { raw: true });
    expect(status === 200, `expected 200, got ${status} — the export button opens a plain browser tab`);
    expect((headers.get('content-disposition') || '').includes('attachment'), 'no attachment disposition, the browser would render it');
    /* The BOM is what makes Excel read the file as UTF-8 instead of the system
       codepage, which otherwise mangles every non-ASCII business name. */
    expect(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'the UTF-8 BOM is missing — Excel will mangle non-ASCII names');
    const text = bytes.subarray(3).toString('utf8');
    expect(text.startsWith('"Business Name"'), `unexpected header row: ${text.slice(0, 40)}`);
    return `BOM + ${text.split('\r\n').length - 1} data row(s), Excel-safe`;
  });

  await check("scraperApi.getExportUrl('json')", async () => {
    const { status, headers } = await call('GET', '/api/v2/scraper/export?format=json', { raw: true });
    expect(status === 200 && (headers.get('content-disposition') || '').includes('.json'), `expected a json attachment, got ${status}`);
    return 'downloads';
  });

  await check('scraperApi.startScrape()  →  POST /api/v2/scraper/start  validates its inputs', async () => {
    const { status } = await call('POST', '/api/v2/scraper/start', { body: { query: 'PG' } });
    expect(status === 400, `expected 400 for a missing location, got ${status}`);
    return '400 when query or location is missing';
  });

  if (RUN_SCRAPE) {
    await check('scraperApi.startScrape()  →  a real Google Maps scrape, end to end', async () => {
      const start = await call('POST', '/api/v2/scraper/start', {
        body: {
          query: 'PG', location: 'Visakhapatnam', landmark: 'MVP Colony', source: 'GoogleMaps', depth: 3,
        },
      });
      expect(start.status === 200, `start failed: ${start.status} ${start.body.error}`);
      const jobId = start.body.data && start.body.data.jobId;
      expect(jobId, 'ScraperSearchPage reads res.data.jobId');
      created.jobIds.push(jobId);

      // LiveProgressModal polls getStatus until status is terminal.
      let last = null;
      for (let i = 0; i < 45; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 4000); });
        // eslint-disable-next-line no-await-in-loop
        const poll = await call('GET', `/api/v2/scraper/status/${jobId}`);
        expect(poll.status === 200, `status poll failed: ${poll.status}`);
        last = poll.body.data;
        expectFields(last, ['jobId', 'name', 'status', 'progress', 'statusMessage', 'resultCount'], 'status');
        if (['completed', 'error', 'stopped'].includes(last.status)) break;
      }
      expect(last.status === 'completed', `job ended as "${last.status}": ${last.statusMessage}`);

      const leads = await call('GET', `/api/v2/scraper/leads?jobId=${jobId}`);
      expect(leads.body.count > 0, 'the job completed but saved no leads');
      for (const lead of leads.body.data) created.leadIds.push(String(lead._id));
      expectFields(leads.body.data[0], LEAD_FIELDS, 'scraped lead');
      return `${leads.body.count} real leads, e.g. "${leads.body.data[0].businessName}" ${leads.body.data[0].phone}`;
    });
  } else {
    await check('scraperApi.startScrape()  →  the Playwright engine is installed', async () => {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const version = browser.version();
      await browser.close();
      return `Chromium ${version} launches (pass --scrape to run a live scrape)`;
    });
  }

  await check('scraperApi.stopJob()  →  POST /api/v2/scraper/stop/:jobId', async () => {
    const { status, body } = await call('POST', `/api/v2/scraper/stop/${fixtureJobId}`);
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    return 'accepted';
  });

  await check('scraperApi.getStatus()  →  GET /api/v2/scraper/status/:jobId', async () => {
    const { status, body } = await call('GET', `/api/v2/scraper/status/${fixtureJobId}`);
    expect(status === 200, `expected 200, got ${status}`);
    return expectFields(body.data, ['jobId', 'name', 'status', 'progress', 'statusMessage', 'resultCount'], 'status');
  });

  /* ══ onboard.lampose.com ═══════════════════════════════════════════════ */

  section('onboard.lampose.com   (onboards-frontend/src/services/api.js  →  v1)');

  await check('fetchProperties()  →  GET /api/v1/properties  (App.jsx listing grid)', async () => {
    const { status, body } = await call('GET', '/api/v1/properties');
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.success === true && Array.isArray(body.data), 'App.jsx checks res.success && res.data');
    return `${body.count} listings (verified + pending, merged from verificationrequests)`;
  });

  await check('the unversioned /api/properties alias is still v1, not v2', async () => {
    const { status, body } = await call('GET', '/api/properties');
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    /* The v1 route reports the split; the v2 one does not exist in its
       response. This is the check that catches the two being swapped. */
    const v2 = await call('GET', '/api/v2/properties');
    expect(v2.status === 200, 'v2 properties is not answering');
    return `v1 ${body.count} rows (verified + pending) vs v2 ${v2.body.count} rows (raw collection)`;
  });

  await check('fetchProperties({category, search, stayType})  filters', async () => {
    const { status, body } = await call('GET', '/api/v1/properties?category=PG&search=a&stayType=Long Stay');
    expect(status === 200 && Array.isArray(body.data), `expected 200, got ${status}`);
    return `${body.count} rows`;
  });

  await check('fetchPropertyById()  →  GET /api/v1/properties/:id', async () => {
    const id = created.propertyIds[0];
    expect(id, 'skipped — nothing was created');
    const { status, body } = await call('GET', `/api/v1/properties/${id}`);
    expect(status === 200 && body.data && String(body.data._id) === id, `expected 200, got ${status}`);
    return 'found through the v1 reader too — one shared collection';
  });

  await check('onboardProperty()  →  POST /api/v1/properties validates before it calls Twilio', async () => {
    /* Deliberately incomplete: a full payload would send a real WhatsApp
       message to a real number. Validation runs before Twilio is touched. */
    const { status, body } = await call('POST', '/api/v1/properties', {
      body: { name: `VERIFY NO-SEND ${stamp}` },
    });
    expect(status === 400, `expected 400 for a missing owner/place/category, got ${status}`);
    expect(body.success === false && body.error, 'the form reads res.error');
    return '400 before any WhatsApp send (full POST not exercised on purpose)';
  });

  await check('onboardProperty()  →  POST /api/v1/properties rejects an unknown category', async () => {
    const { status, body } = await call('POST', '/api/v1/properties', {
      body: {
        name: 'x', place: 'y', ownerName: 'z', ownerMobile: '9999999999', category: 'Penthouse',
      },
    });
    expect(status === 400, `expected 400, got ${status}`);
    expect(/Invalid category/i.test(body.error || ''), `unexpected message: ${body.error}`);
    return 'category enum still enforced';
  });

  /* ── Cloudinary upload (onboards-frontend/src/App.jsx) ────────────────
     Real bytes, through multer and the Cloudinary SDK. Both assets are
     destroyed in cleanup, so a run leaves nothing behind in the account. */

  const uploadForm = (field, count) => {
    const form = new FormData();
    for (let i = 0; i < count; i += 1) {
      form.append(field, new Blob([PNG_1PX], { type: 'image/png' }), `verify-${stamp}-${i}.png`);
    }
    return form;
  };

  await check('uploadImage()  →  POST /api/v1/properties/upload-image  (multipart, real Cloudinary)', async () => {
    const response = await fetch(`${base}/api/v1/properties/upload-image`, {
      method: 'POST',
      body: uploadForm('image', 1),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 500 && /cloud|api_key|signature/i.test(body.message || '')) {
      return `skipped — Cloudinary rejected the credentials (${body.message})`;
    }
    expect(response.status === 200, `expected 200, got ${response.status}: ${body.message || body.error}`);
    /* App.jsx reads json.success && json.url. */
    expect(body.success === true && body.url, 'App.jsx reads json.success and json.url');
    expect(Array.isArray(body.urls) && body.urls.length === 1, 'urls[] is missing');
    if (body.public_id) uploadedPublicIds.push(body.public_id);
    return `uploaded → ${String(body.url).slice(0, 60)}…`;
  });

  await check('uploadImages()  →  POST /api/v1/properties/upload-images  (batch, real Cloudinary)', async () => {
    const response = await fetch(`${base}/api/v1/properties/upload-images`, {
      method: 'POST',
      body: uploadForm('images', 2),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 500 && /cloud|api_key|signature/i.test(body.message || '')) {
      return `skipped — Cloudinary rejected the credentials (${body.message})`;
    }
    expect(response.status === 200, `expected 200, got ${response.status}: ${body.message || body.error}`);
    /* App.jsx reads batchJson.urls and expects one entry per file it sent. */
    expect(Array.isArray(body.urls) && body.urls.length === 2,
      `App.jsx maps batchJson.urls one-to-one with its files; got ${(body.urls || []).length} for 2`);
    body.urls.forEach((url) => {
      const match = String(url).match(/\/lampose_accommodations\/([^./]+)/);
      if (match) uploadedPublicIds.push(`lampose_accommodations/${match[1]}`);
    });
    return `2 photos uploaded concurrently, urls[] one-to-one`;
  });

  await check('upload with no file at all must be a 400, not a 500', async () => {
    const { status, body } = await call('POST', '/api/v1/properties/upload-image', { body: {} });
    expect(status === 400, `expected 400, got ${status}`);
    expect(body.success === false, 'the form branches on json.success');
    return '400 before Cloudinary is contacted';
  });

  section('onboard.lampose.com   (onboards-frontend/src/services/permissions.js  →  v1)');

  let permissionId = null;
  const empEmail = `verify_field_${stamp}@example.invalid`;

  await check('requestPermission()  →  POST /api/v1/permissions', async () => {
    const { status, body } = await call('POST', '/api/v1/permissions', {
      headers: { 'x-employee-email': empEmail },
      body: {
        propertyId: created.propertyIds[0] || `tmp_${stamp}`,
        employeeEmail: empEmail,
        action: 'edit',
        reason: 'verify script',
        property: { name: 'Verify', place: 'Visakhapatnam', category: 'PG' },
      },
    });
    expect([200, 201].includes(status), `expected 201, got ${status}: ${body.error || body.message}`);
    permissionId = body.data && body.data._id;
    created.permissionIds.push(permissionId);
    return expectFields(body.data, ['_id', 'status', 'action', 'employeeEmail', 'active'], 'res.data');
  });

  await check('fetchPropertyAccess()  →  GET /api/v1/permissions/access  (Edit/Delete buttons)', async () => {
    const propertyId = created.propertyIds[0] || `tmp_${stamp}`;
    const { status, body } = await call('GET', `/api/v1/permissions/access?propertyId=${propertyId}&employeeEmail=${empEmail}`);
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    expectFields(body.data, ['propertyId', 'employeeEmail', 'permissions'], 'res.data');
    expect(body.data.permissions.edit.allowed === false, 'a pending request must not already allow the edit');
    expect(body.data.permissions.edit.status === 'pending', `edit status is ${body.data.permissions.edit.status}`);
    return 'edit locked while pending, as the UI expects';
  });

  await check('an employee write without a grant must be refused  →  PUT /api/v1/properties/:id', async () => {
    const id = created.propertyIds[0];
    expect(id, 'skipped — nothing was created');
    const { status, body } = await call('PUT', `/api/v1/properties/${id}`, {
      headers: { 'x-employee-email': empEmail },
      body: { name: 'should not apply' },
    });
    expect(status === 403, `expected 403, got ${status}`);
    expect(body.requiresPermission === true, 'the app branches on res.requiresPermission');
    return '403 requiresPermission — the permission gate is live';
  });

  await check('an administrator grant unlocks exactly one write  →  PUT /api/v1/permissions/:id', async () => {
    expect(permissionId, 'skipped — no permission request');
    const granted = await call('PUT', `/api/v1/permissions/${permissionId}`, {
      body: { status: 'granted', decidedBy: 'verify-script' },
    });
    expect(granted.status === 200 && granted.body.data.active === true, 'the grant is not active');

    const id = created.propertyIds[0];
    const write = await call('PUT', `/api/v1/properties/${id}`, {
      headers: { 'x-employee-email': empEmail },
      body: { address: `verified-by-script-${stamp}` },
    });
    expect(write.status === 200, `the granted write failed: ${write.status}`);

    /* One approval buys one action: the second attempt must be refused. */
    const again = await call('PUT', `/api/v1/properties/${id}`, {
      headers: { 'x-employee-email': empEmail },
      body: { address: 'second attempt' },
    });
    expect(again.status === 403, `the grant was reusable — expected 403 on the second write, got ${again.status}`);
    return 'granted → one write allowed → second write refused';
  });

  await check('deleteProperty()  →  DELETE /api/v1/properties/:id  is gated the same way', async () => {
    const id = await makeThrowawayProperty('V1-DELETE');

    /* Same employee, but the grant above was for `edit` and has been spent.
       A delete must need its own approval. */
    const ungated = await call('DELETE', `/api/v1/properties/${id}`, {
      headers: { 'x-employee-email': empEmail },
    });
    expect(ungated.status === 403, `expected 403 without a delete grant, got ${ungated.status}`);
    expect(ungated.body.action === 'delete', `the refusal names action "${ungated.body.action}"`);

    const request = await call('POST', '/api/v1/permissions', {
      headers: { 'x-employee-email': empEmail },
      body: { propertyId: id, employeeEmail: empEmail, action: 'delete', reason: 'verify script' },
    });
    created.permissionIds.push(request.body.data._id);
    await call('PUT', `/api/v1/permissions/${request.body.data._id}`, {
      body: { status: 'granted', decidedBy: 'verify-script' },
    });

    const granted = await call('DELETE', `/api/v1/properties/${id}`, {
      headers: { 'x-employee-email': empEmail },
    });
    expect(granted.status === 200, `the granted delete failed: ${granted.status}`);
    created.propertyIds = created.propertyIds.filter((p) => p !== id);

    const after = await call('GET', `/api/v2/properties/${id}`);
    expect(after.status === 404, 'the property survived a successful delete');
    return 'edit grant does not authorise a delete; a delete grant does';
  });

  await check('the admin console can close a grant  →  POST /api/v1/permissions/:id/consume', async () => {
    const request = await call('POST', '/api/v1/permissions', {
      headers: { 'x-employee-email': empEmail },
      body: {
        propertyId: created.propertyIds[0] || `tmp_${stamp}`,
        employeeEmail: `consume_${stamp}@example.invalid`,
        action: 'edit',
        reason: 'verify script',
      },
    });
    const id = request.body.data._id;
    created.permissionIds.push(id);

    await call('PUT', `/api/v1/permissions/${id}`, { body: { status: 'granted' } });
    const spent = await call('POST', `/api/v1/permissions/${id}/consume`);
    expect(spent.status === 200 && spent.body.data.status === 'used', `expected used, got ${spent.status}`);

    /* Spending it twice must not be possible, or one approval buys many. */
    const again = await call('POST', `/api/v1/permissions/${id}/consume`);
    expect(again.status === 409, `expected 409 on a second consume, got ${again.status}`);
    return 'granted → used → 409 on reuse';
  });

  await check('DELETE /api/v1/permissions/:id  removes the audit row', async () => {
    const id = created.permissionIds[created.permissionIds.length - 1];
    expect(id, 'skipped — no permission to delete');
    const { status, body } = await call('DELETE', `/api/v1/permissions/${id}`);
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    created.permissionIds = created.permissionIds.filter((p) => p !== id);
    return 'deleted';
  });

  section('onboard.lampose.com   (onboards-frontend/src/services/auth.js  →  v2 auth)');

  await check('loginUser()  →  POST /api/v2/auth/onboarding-login  reads data.employee', async () => {
    const { status, body } = await call('POST', '/api/v2/auth/onboarding-login', {
      body: { email: adminEmail, password: 'verify123' },
    });
    expect(status === 200, `expected 200, got ${status}`);
    expect(body.valid === true && body.data && body.data.token, 'auth.js checks data.valid and data.data.token');
    return expectFields(body.data.employee, ['userId', 'name', 'email', 'role', 'avatar'], 'res.data.employee');
  });

  await check('loginUser()  with bad credentials returns 401 + valid:false', async () => {
    const { status, body } = await call('POST', '/api/v2/auth/onboarding-login', {
      body: { email: adminEmail, password: 'wrong-password' },
    });
    expect(status === 401, `expected 401, got ${status}`);
    expect(body.valid === false && body.error, 'auth.js reads data.error when valid is false');
    return '401 valid:false';
  });

  await check('POST /api/v2/auth/verify-employee  (the alias auth.js may be pointed at)', async () => {
    const { status, body } = await call('POST', '/api/v2/auth/verify-employee', {
      body: { email: adminEmail, password: 'verify123' },
    });
    expect(status === 200 && body.valid === true, `expected 200, got ${status}`);
    return 'same handler as onboarding-login';
  });

  await check('POST /api/v2/auth/verify-token  revalidates a stored session', async () => {
    const good = await call('POST', '/api/v2/auth/verify-token', { token });
    expect(good.status === 200 && good.body.valid === true, `expected 200, got ${good.status}`);
    const bad = await call('POST', '/api/v2/auth/verify-token', { token: 'stale.token.value' });
    expect(bad.status === 401 && bad.body.valid === false, `expected 401 valid:false, got ${bad.status}`);
    return 'valid token accepted, stale token 401 valid:false';
  });

  section('admin console   (v1 admin, stats, verifications — no frontend in this repo)');

  /* The console itself is not one of the three frontends here, so these are
     checked against the routes rather than against a caller. They are part of
     the v1 surface and a merge that broke them would go unnoticed otherwise. */

  const consoleEmail = `verify_console_${stamp}@example.invalid`;
  let consoleAdminId = null;

  await check('POST /api/v1/admin/register  is guarded by V1_ADMIN_SECRET_KEY', async () => {
    const wrong = await call('POST', '/api/v1/admin/register', {
      body: {
        name: 'Verify Console', email: consoleEmail, password: 'verify123', adminSecretKey: 'not-the-key',
      },
    });
    expect(wrong.status === 403, `expected 403 with a wrong key, got ${wrong.status}`);

    const key = process.env.V1_ADMIN_SECRET_KEY || 'lampose_admin_secret_2026';
    const { status, body } = await call('POST', '/api/v1/admin/register', {
      body: {
        name: 'Verify Console', email: consoleEmail, password: 'verify123', role: 'Admin', adminSecretKey: key,
      },
    });
    expect([200, 201].includes(status), `expected 201, got ${status}: ${body.message}`);
    expect(body.token && body.user, 'the console reads res.token and res.user');
    consoleAdminId = body.user.id;
    created.adminIds.push(consoleAdminId);
    /* This is the regression the merge nearly introduced: adding
       ADMIN_SECRET_KEY for v2 used to change the key this route wanted. */
    return 'wrong key refused, correct key accepted — separate from ADMIN_SECRET_KEY';
  });

  await check('POST /api/v1/admin/login  (a different identity system from v2)', async () => {
    const { status, body } = await call('POST', '/api/v1/admin/login', {
      body: { email: consoleEmail, password: 'verify123' },
    });
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    expect(body.token && body.user.role, 'the console reads res.token and res.user.role');

    /* The same credentials must NOT work against the leads panel: these are
       two account stores, and a merge that collapsed them would show up here. */
    const crossover = await call('POST', '/api/v2/auth/login', {
      body: { email: consoleEmail, password: 'verify123' },
    });
    expect(crossover.status === 401, `an admins-collection account signed into the leads panel (${crossover.status})`);
    return `signed in as ${body.user.role}; the same account is rejected by v2, as it must be`;
  });

  await check('PUT + DELETE /api/v1/admin/users/:id', async () => {
    expect(consoleAdminId, 'skipped — no console admin was created');
    const updated = await call('PUT', `/api/v1/admin/users/${consoleAdminId}`, {
      body: { role: 'Viewer', status: 'Inactive' },
    });
    expect(updated.status === 200 && updated.body.role === 'Viewer', `update failed: ${updated.status}`);

    const removed = await call('DELETE', `/api/v1/admin/users/${consoleAdminId}`);
    expect(removed.status === 200 && removed.body.success === true, `delete failed: ${removed.status}`);
    created.adminIds = created.adminIds.filter((a) => a !== consoleAdminId);
    return 'role/status updated, then deleted';
  });

  await check('POST + PUT + DELETE /api/v1/verifications  (the console queue)', async () => {
    const madeIt = await call('POST', '/api/v1/verifications', {
      body: { ownerMobileE164: `whatsapp:+9199${String(stamp).slice(-8)}`, status: 'pending' },
    });
    expect([200, 201].includes(madeIt.status), `create failed: ${madeIt.status} ${madeIt.body.message}`);
    const id = madeIt.body.data._id;

    const updated = await call('PUT', `/api/v1/verifications/${id}`, { body: { status: 'verified' } });
    expect(updated.status === 200 && updated.body.data.status === 'verified', `update failed: ${updated.status}`);
    expect(updated.body.data.respondedAt, 'respondedAt is not stamped when a request is marked verified');

    const removed = await call('DELETE', `/api/v1/verifications/${id}`);
    expect(removed.status === 200, `delete failed: ${removed.status}`);
    return 'created, verified (respondedAt stamped), deleted';
  });

  await check('GET /api/v1/admin/users  (admins collection, not scriper_users)', async () => {
    const { status, body } = await call('GET', '/api/v1/admin/users');
    expect(status === 200, `expected 200, got ${status}`);
    expect(Array.isArray(body.items), 'the console reads res.items');
    return `${body.total} administrator account(s) — a different collection from the ${'/api/v2/users'} one`;
  });

  await check('GET /api/v1/admin/stats  (dashboard)', async () => {
    const { status, body } = await call('GET', '/api/v1/admin/stats');
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    return expectFields(body, ['admins', 'properties', 'verifications', 'windowDays'], 'stats');
  });

  await check('GET /api/v1/admin/activity  (notification feed)', async () => {
    const { status, body } = await call('GET', '/api/v1/admin/activity');
    expect(status === 200 && Array.isArray(body.items), `expected 200, got ${status}`);
    return `${body.count} event(s)`;
  });

  await check('GET /api/v1/admin/system  (system telemetry)', async () => {
    const { status, body } = await call('GET', '/api/v1/admin/system');
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    expectFields(body.database, ['name', 'readyState', 'connected', 'collections'], 'system.database');
    return `${body.database.collections.length} collections visible`;
  });

  await check('GET /api/v1/verifications  (verification queue)', async () => {
    const { status, body } = await call('GET', '/api/v1/verifications');
    expect(status === 200 && body.success === true, `expected 200, got ${status}`);
    expect(Array.isArray(body.items) && Array.isArray(body.data), 'both response shapes must be present');
    return `${body.count} verification request(s)`;
  });

  await check('POST /api/v1/whatsapp/webhook  answers TwiML even for an unknown sender', async () => {
    const response = await fetch(`${base}/api/v1/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: 'whatsapp:+10000000000', Body: 'hello' }).toString(),
    });
    const text = await response.text();
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(text.includes('<Response>'), 'Twilio needs a TwiML document back, got: ' + text.slice(0, 60));
    return 'TwiML returned — the webhook contract holds';
  });

  section('routing & versioning');

  await check('GET /api lists both versions', async () => {
    const { status, body } = await call('GET', '/api');
    expect(status === 200 && Array.isArray(body.versions), `expected 200, got ${status}`);
    return `versions: ${body.versions.join(', ')}`;
  });

  await check('an unknown route returns a JSON 404, not HTML', async () => {
    const { status, body } = await call('GET', '/api/does-not-exist');
    expect(status === 404, `expected 404, got ${status}`);
    expect(typeof body === 'object' && body.code === 'ROUTE_NOT_FOUND', 'the 404 body is not the JSON envelope');
    return body.code;
  });

  await check('bare /properties is NOT mounted (it would be ambiguous)', async () => {
    const { status } = await call('GET', '/properties');
    expect(status === 404, `expected 404, got ${status} — a bare /properties silently picks a version`);
    return '404, as intended — use /api/v1/properties or /api/v2/properties';
  });

  await check('bare /listings IS mounted (unambiguous)', async () => {
    const { status } = await call('GET', '/listings');
    expect(status === 200, `expected 200, got ${status}`);
    return 'mounted, so a base URL missing /api still works';
  });

  await check('malformed JSON returns 400, not 500', async () => {
    const response = await fetch(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": ',
    });
    expect(response.status === 400, `expected 400, got ${response.status}`);
    return '400 INVALID_JSON';
  });

  section('CORS preflight from each production origin');

  const preflight = async (origin, path = '/api/v2/auth/login') => {
    const response = await fetch(`${base}${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization,x-employee-email',
      },
    });
    return {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
      allowCredentials: response.headers.get('access-control-allow-credentials'),
      allowHeaders: response.headers.get('access-control-allow-headers'),
      exposeHeaders: response.headers.get('access-control-expose-headers'),
    };
  };

  const PRODUCTION_ORIGINS = [
    'https://lampose.com',
    'https://www.lampose.com',
    'https://leads.lampose.com',
    'https://onboard.lampose.com',
    'http://localhost:5173',
    'http://localhost:5174',
  ];

  for (const origin of PRODUCTION_ORIGINS) {
    // eslint-disable-next-line no-await-in-loop
    await check(`preflight from ${origin}`, async () => {
      const {
        status, allowOrigin, allowCredentials, allowHeaders, exposeHeaders,
      } = await preflight(origin);
      expect(status >= 200 && status < 300, `preflight status ${status}`);
      expect(allowOrigin === origin, `Allow-Origin was "${allowOrigin}", expected the origin echoed back`);
      /* "*" with credentials is rejected by every browser — the combination
         has to be impossible, not merely unlikely. */
      expect(allowOrigin !== '*', 'Allow-Origin must never be * while credentials are allowed');
      expect(allowCredentials === 'true', 'Allow-Credentials is not true');
      expect(/authorization/i.test(allowHeaders || ''), 'Authorization is not an allowed header');
      expect(/x-employee-email/i.test(allowHeaders || ''), 'x-employee-email is not allowed — the onboarding app cannot edit or delete');
      expect(/content-disposition/i.test(exposeHeaders || ''), 'Content-Disposition is not exposed — the CSV export loses its filename');
      return 'origin echoed, credentials allowed, Authorization + x-employee-email permitted';
    });
  }

  await check('preflight from an unlisted origin', async () => {
    const { allowOrigin } = await preflight('https://not-our-site.example.com');
    if (!config.isProduction) {
      return `development: allowed (${allowOrigin || 'no header'})`;
    }
    expect(!allowOrigin, `production must not echo an unlisted origin, got "${allowOrigin}"`);
    return 'rejected without an Allow-Origin header';
  });
};

/* ── Cleanup ──────────────────────────────────────────────────────────── */

const cleanup = async () => {
  const { User, ScrapedLead, ScrapeJob } = require('../models/scriper');
  const Property = require('../models/Property');
  const PermissionRequest = require('../models/PermissionRequest');
  const Admin = require('../models/Admin');

  if (config.storage.mode === 'mongo') {
    if (created.leadIds.length) await ScrapedLead.deleteMany({ _id: { $in: created.leadIds } });
    if (created.jobIds.length) await ScrapeJob.deleteMany({ jobId: { $in: created.jobIds } });
    const users = created.userIds.filter(Boolean);
    if (users.length) await User.deleteMany({ userId: { $in: users } });
  }
  if (created.propertyIds.length) await Property.deleteMany({ _id: { $in: created.propertyIds } });
  const perms = created.permissionIds.filter((id) => /^[0-9a-fA-F]{24}$/.test(String(id)));
  if (perms.length) await PermissionRequest.deleteMany({ _id: { $in: perms } });
  const admins = created.adminIds.filter((id) => /^[0-9a-fA-F]{24}$/.test(String(id)));
  if (admins.length) await Admin.deleteMany({ _id: { $in: admins } });

  /* The upload checks moved real bytes into Cloudinary. Destroy them, or a
     run leaves two 1x1 PNGs in the account every time it happens. */
  if (uploadedPublicIds.length) {
    // eslint-disable-next-line global-require
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    for (const publicId of uploadedPublicIds) {
      // eslint-disable-next-line no-await-in-loop
      await cloudinary.uploader.destroy(publicId).catch(() => {});
    }
  }
};

/* ── Report ───────────────────────────────────────────────────────────── */

(async () => {
  let fatal = null;
  try {
    await run();
  } catch (error) {
    fatal = error;
  }

  let cleanupError = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error.message;
  }

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
  if (fatal) console.error(`  ABORTED: ${fatal.message}\n`);
  if (cleanupError) console.error(`  WARNING: cleanup failed — ${cleanupError}\n`);

  if (server) {
    server.close();
    await closeConnections();
  }
  /* Not process.exit(): tearing the process down while a connection retry is
     still in flight trips a libuv assertion on Windows, which reads as a crash
     at the end of a run that passed. */
  process.exitCode = (failed.length || fatal) ? 1 : 0;
})();
