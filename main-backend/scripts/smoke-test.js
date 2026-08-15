/* ══════════════════════════════════════════════════════════════════════════
   Pre-deploy smoke test.

   Boots the real app on an ephemeral port, connects the real database, and
   exercises both API versions — including the CORS preflight from each
   production origin, which is the failure that only shows up in a browser and
   never in curl.

     npm run smoke                                        locally booted app
     SMOKE_URL=https://api.lampose.com npm run smoke      against a deployment

   Exits non-zero if anything fails, so it can gate a deploy.
   verify-frontends.js is the deeper check — this one is "is it healthy",
   that one is "does each screen still work".
   ══════════════════════════════════════════════════════════════════════════ */
const config = require('../config/env');
const { connectDB, closeConnections } = require('../config/db');
const { initStore } = require('../storage/dbStore');
const app = require('../app');

const results = [];
let server = null;
let base = process.env.SMOKE_URL ? process.env.SMOKE_URL.replace(/\/+$/, '') : null;

const check = async (name, run) => {
  try {
    const detail = await run();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (error) {
    results.push({ ok: false, name, detail: error.message });
  }
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const get = async (path, init) => {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
};

const run = async () => {
  if (!base) {
    await connectDB();
    await initStore();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`\nBooted the app on ${base}\n`);
  } else {
    console.log(`\nTesting ${base}\n`);
  }

  /* ── Routing ─────────────────────────────────────────────────────────── */

  await check('GET / responds', async () => {
    const { response, body } = await get('/');
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(body.message, 'no message in the root payload');
    return `${body.message} — versions ${(body.versions || []).join(', ')}`;
  });

  await check('GET /api/health reports both data domains', async () => {
    const { response, body } = await get('/api/health');
    expect([200, 503].includes(response.status), `unexpected status ${response.status}`);
    expect(body.databases && body.databases.lampose, 'health payload is missing databases.lampose');
    expect(body.databases && body.databases.scriper, 'health payload is missing databases.scriper');
    /* The Lampose client keys its "database is down" message off this exact
       path, so a rename here silently degrades its error reporting. */
    expect(typeof (body.database || {}).connected === 'boolean', 'health payload is missing database.connected');
    /* The v1 probe read this one. */
    expect(typeof body.uptimeSeconds === 'number', 'health payload is missing uptimeSeconds (the v1 shape)');
    return `status=${body.status} lampose=${body.databases.lampose.state} leads=${body.databases.scriper.state}`;
  });

  for (const path of ['/health', '/api/v1/health', '/api/v2/health']) {
    // eslint-disable-next-line no-await-in-loop
    await check(`GET ${path} is mounted too`, async () => {
      const { response } = await get(path);
      expect([200, 503].includes(response.status), `unexpected status ${response.status}`);
      return 'routed';
    });
  }

  await check('GET /api/health/live is always 200', async () => {
    const { response } = await get('/api/health/live');
    expect(response.status === 200, `expected 200, got ${response.status}`);
    return 'liveness probe safe for the platform health check';
  });

  /* ── v2 ──────────────────────────────────────────────────────────────── */

  await check('GET /api/v2/listings', async () => {
    const { response, body } = await get('/api/v2/listings');
    if (response.status === 503) {
      expect(body.code === 'DB_DISCONNECTED', 'a 503 must carry code DB_DISCONNECTED');
      return '503 DB_DISCONNECTED (database unreachable, reported correctly)';
    }
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(Array.isArray(body.data), 'listings payload is not an array');
    return `${body.count} listings`;
  });

  await check('GET /api/v2/properties', async () => {
    const { response, body } = await get('/api/v2/properties');
    if (response.status === 503) return '503 DB_DISCONNECTED';
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(Array.isArray(body.data), 'properties payload is not an array');
    return `${body.count} properties (raw collection)`;
  });

  await check('POST /api/v2/properties is guarded', async () => {
    const { response } = await get('/api/v2/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'smoke-test' }),
    });
    if (!config.auth.requireAuth) return 'REQUIRE_AUTH=false, guard intentionally off';
    if (response.status === 503) return '503 DB_DISCONNECTED';
    expect(response.status === 401, `expected 401 without a token, got ${response.status}`);
    return '401 without a token';
  });

  await check('GET /api/v2/scraper/stats', async () => {
    const { response, body } = await get('/api/v2/scraper/stats');
    if (response.status === 503) return '503 DB_DISCONNECTED';
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(typeof (body.data || {}).totalLeads === 'number', 'stats payload has no totalLeads');
    return `${body.data.totalLeads} leads, ${body.data.totalJobs} jobs`;
  });

  await check('GET /api/v2/users requires a token', async () => {
    const { response } = await get('/api/v2/users');
    if (!config.auth.requireAuth) return 'REQUIRE_AUTH=false, guard intentionally off';
    expect([401, 503].includes(response.status), `expected 401, got ${response.status}`);
    return '401 without a token';
  });

  await check('POST /api/v2/auth/login rejects bad credentials with 401', async () => {
    const { response, body } = await get('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
    });
    if (response.status === 503) return `503 ${body.code}`;
    expect(response.status === 401, `expected 401, got ${response.status}`);
    /* The three clients read a failure differently — one looks at `message`,
       one at `error`, one at `success` — so every error body carries all. */
    expect(body.message && body.error, 'error body must carry both message and error');
    return 'rejected, and the body carries message + error';
  });

  /* ── v1 ──────────────────────────────────────────────────────────────── */

  await check('GET /api/v1/properties (onboarding view)', async () => {
    const { response, body } = await get('/api/v1/properties');
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(Array.isArray(body.data), 'properties payload is not an array');
    return `${body.count} listings (verified + pending)`;
  });

  await check('GET /api/properties resolves to v1, not v2', async () => {
    const legacy = await get('/api/properties');
    const v1 = await get('/api/v1/properties');
    expect(legacy.response.status === 200, `expected 200, got ${legacy.response.status}`);
    expect(legacy.body.count === v1.body.count,
      `the unversioned alias returned ${legacy.body.count} rows and v1 returned ${v1.body.count} — they are not the same router`);
    return `both ${v1.body.count} rows`;
  });

  await check('GET /api/v1/permissions', async () => {
    const { response, body } = await get('/api/v1/permissions');
    expect(response.status === 200 && body.success === true, `expected 200, got ${response.status}`);
    return `${body.count} permission request(s)`;
  });

  await check('GET /api/v1/verifications', async () => {
    const { response, body } = await get('/api/v1/verifications');
    expect(response.status === 200 && body.success === true, `expected 200, got ${response.status}`);
    return `${body.count} verification request(s)`;
  });

  await check('GET /api/v1/admin/stats', async () => {
    const { response, body } = await get('/api/v1/admin/stats');
    expect(response.status === 200 && body.success === true, `expected 200, got ${response.status}`);
    return `${body.properties.total} properties, ${body.admins.total} admins`;
  });

  /* ── Failure shapes ──────────────────────────────────────────────────── */

  await check('unknown route returns a JSON 404, not HTML', async () => {
    const { response, body } = await get('/api/does-not-exist');
    expect(response.status === 404, `expected 404, got ${response.status}`);
    expect(typeof body === 'object', 'the 404 body is not JSON');
    return body.code;
  });

  await check('malformed JSON returns 400, not 500', async () => {
    const { response } = await get('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": ',
    });
    expect(response.status === 400, `expected 400, got ${response.status}`);
    return '400 INVALID_JSON';
  });

  /* ── CORS ────────────────────────────────────────────────────────────────
     The preflight is what actually breaks in production, and it never shows up
     in a curl test that omits the Origin header. */

  const preflight = async (origin, method = 'POST') => {
    const response = await fetch(`${base}/api/v2/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'content-type,authorization,x-employee-email',
      },
    });
    return {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
      allowCredentials: response.headers.get('access-control-allow-credentials'),
      allowHeaders: response.headers.get('access-control-allow-headers'),
    };
  };

  const PRODUCTION_ORIGINS = [
    'https://lampose.com',
    'https://www.lampose.com',
    'https://leads.lampose.com',
    'https://onboard.lampose.com',
    'http://localhost:5173',
  ];

  for (const origin of PRODUCTION_ORIGINS) {
    // eslint-disable-next-line no-await-in-loop
    await check(`CORS preflight from ${origin}`, async () => {
      const { status, allowOrigin, allowCredentials, allowHeaders } = await preflight(origin);
      expect(status >= 200 && status < 300, `preflight status ${status}`);
      expect(allowOrigin === origin, `Allow-Origin was "${allowOrigin}", expected the origin echoed back`);
      /* "*" with credentials is rejected by every browser — the combination
         has to be impossible, not merely unlikely. */
      expect(allowOrigin !== '*', 'Allow-Origin must never be * while credentials are allowed');
      expect(allowCredentials === 'true', 'Allow-Credentials is not true');
      expect(/authorization/i.test(allowHeaders || ''), 'Authorization is not an allowed header');
      expect(/x-employee-email/i.test(allowHeaders || ''), 'x-employee-email is not an allowed header');
      return 'origin echoed, credentials allowed, both auth headers permitted';
    });
  }

  await check('CORS preflight from an unlisted origin', async () => {
    const { allowOrigin } = await preflight('https://not-our-site.example.com');
    if (!config.isProduction) {
      return `development: allowed (${allowOrigin || 'no header'})`;
    }
    expect(!allowOrigin, `production must not echo an unlisted origin, got "${allowOrigin}"`);
    return 'rejected without an Allow-Origin header';
  });
};

/* ── Report ──────────────────────────────────────────────────────────── */

(async () => {
  let fatal = null;
  try {
    await run();
  } catch (error) {
    fatal = error;
  }

  console.log();
  for (const { ok, name, detail } of results) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (fatal) console.error(`  ABORTED: ${fatal.message}\n`);

  if (server) {
    server.close();
    await closeConnections();
  }

  /* Not process.exit(): tearing the process down while a connection retry is
     still in flight trips a libuv assertion on Windows, which reads as a crash
     at the end of a run that passed. Setting the code and letting the loop
     drain exits just as reliably — the retry timers are unref'd. */
  process.exitCode = (failed.length || fatal) ? 1 : 0;
})();
