/* ══════════════════════════════════════════════════════════════════════════
   Every route group, and the version it belongs to.

   Two API surfaces live in this process, because the two backends that were
   merged disagreed about what some of the same paths mean. Versioning them is
   what makes the disagreement harmless instead of a silent bug:

     v1   what the onboarding backend always served.
          onboard.lampose.com and the admin console.
          POST /properties starts a Twilio WhatsApp verification; the listing
          only becomes real once the owner and a verifier both reply YES.
          PUT/DELETE need an administrator's grant.

     v2   what the leads backend served.
          lampose.com (read-only listings) and leads.lampose.com.
          POST /properties writes immediately behind a bearer token.

   ── Unversioned paths ───────────────────────────────────────────────────
   Every frontend in the repo was written against unversioned paths, so those
   keep working, each resolving to the version that already answered it:

     /api/properties     → v1   (onboards-frontend calls this today)
     /api/permissions    → v1
     /api/verifications  → v1
     /api/whatsapp       → v1   (the Twilio webhook URL — do not move it)
     /api/admin          → v1
     /api/listings       → v2   (lampose-frontend)
     /api/auth           → v2
     /api/users          → v2
     /api/scraper        → v2
     /api/health         → shared

   `/properties` with no /api prefix is deliberately NOT mounted. It is the
   one path where the two versions mean different things, and a deployment
   whose base URL lost its /api would otherwise get the wrong semantics
   silently rather than a 404 that says so. The unambiguous groups keep their
   bare aliases, which is what the leads backend did and what stops a
   copy-pasted env var from becoming an outage.
   ══════════════════════════════════════════════════════════════════════════ */
const healthRoutes = require('./healthRoutes');

const v1PropertyRoutes = require('./v1/propertyRoutes');
const v1AdminRoutes = require('./v1/adminRoutes');
const v1StatsRoutes = require('./v1/statsRoutes');
const v1VerificationRoutes = require('./v1/verificationRoutes');
const v1PermissionRoutes = require('./v1/permissionRoutes');

const v2ListingRoutes = require('./v2/listingRoutes');
const v2PropertyRoutes = require('./v2/propertyRoutes');
const v2AuthRoutes = require('./v2/authRoutes');
const v2UserRoutes = require('./v2/userRoutes');
const v2ScraperRoutes = require('./v2/scraperRoutes');

/* [mount path, router, one-line description]. The description is what the
   banner and GET /api print, so it is worth keeping accurate. */
const V1_GROUPS = [
  ['/health', healthRoutes, 'process + database status'],
  ['/properties', v1PropertyRoutes, 'onboarding CRUD, Cloudinary upload, WhatsApp verification'],
  ['/admin', v1AdminRoutes, 'admin console accounts (admins collection)'],
  ['/admin', v1StatsRoutes, 'dashboard stats, activity feed, system telemetry'],
  ['/verifications', v1VerificationRoutes, 'owner/verifier verification requests'],
  ['/whatsapp', v1VerificationRoutes, 'Twilio inbound webhook'],
  ['/permissions', v1PermissionRoutes, 'employee edit/delete permission requests'],
];

const V2_GROUPS = [
  ['/health', healthRoutes, 'process + database status'],
  ['/listings', v2ListingRoutes, 'public Explore feed for lampose.com'],
  ['/properties', v2PropertyRoutes, 'direct property CRUD for the leads panel'],
  ['/auth', v2AuthRoutes, 'leads panel + onboarding employee login'],
  ['/users', v2UserRoutes, 'leads panel team management'],
  ['/scraper', v2ScraperRoutes, 'Google Maps lead scraping, leads, exports'],
];

/* Which version answers each unversioned path, and whether it also answers
   without the /api prefix. */
const LEGACY_ALIASES = [
  // path, router, bare (no /api) alias too?
  ['/health', healthRoutes, true],
  ['/properties', v1PropertyRoutes, false],
  ['/admin', v1AdminRoutes, false],
  ['/admin', v1StatsRoutes, false],
  ['/verifications', v1VerificationRoutes, false],
  ['/whatsapp', v1VerificationRoutes, false],
  ['/permissions', v1PermissionRoutes, false],
  ['/listings', v2ListingRoutes, true],
  ['/auth', v2AuthRoutes, true],
  ['/users', v2UserRoutes, true],
  ['/scraper', v2ScraperRoutes, true],
];

const registerRoutes = (app) => {
  for (const [path, router] of V1_GROUPS) app.use(`/api/v1${path}`, router);
  for (const [path, router] of V2_GROUPS) app.use(`/api/v2${path}`, router);

  for (const [path, router, bare] of LEGACY_ALIASES) {
    app.use(`/api${path}`, router);
    if (bare) app.use(path, router);
  }
};

/** Human-readable route map, used by the boot banner and GET /api. */
const routeMap = () => ({
  v1: V1_GROUPS.map(([path, , description]) => ({ path: `/api/v1${path}`, description })),
  v2: V2_GROUPS.map(([path, , description]) => ({ path: `/api/v2${path}`, description })),
  legacy: LEGACY_ALIASES.map(([path, router]) => {
    const inV1 = V1_GROUPS.some(([, r]) => r === router);
    const inV2 = V2_GROUPS.some(([, r]) => r === router);
    return {
      path: `/api${path}`,
      servedBy: inV1 && inV2 ? 'shared' : (inV1 ? 'v1' : 'v2'),
    };
  }),
});

module.exports = { registerRoutes, routeMap, V1_GROUPS, V2_GROUPS, LEGACY_ALIASES };
