# Lampose Main Backend

One Node process serving all three Lampose frontends, on one MongoDB database.

| Frontend | Domain | Calls |
| --- | --- | --- |
| `lampose-frontend` | lampose.com | `/api/v2/listings`, `/api/health` |
| `leads-frontend` | leads.lampose.com | `/api/v2/{auth,users,scraper}` |
| `onboards-frontend` | onboard.lampose.com | `/api/v1/{properties,permissions}` + `/api/v2/auth` |

Property onboarding lives in **one** place: onboard.lampose.com, through the v1
surface and its owner-verification chain. The leads panel used to have an
"Accommodation Properties" page that wrote listings directly through
`/api/v2/properties`; that page has been removed from the panel. The routes
remain mounted (nothing else changed), they just have no caller in this repo.

```bash
npm install
npm run browsers      # Playwright's Chromium, only needed for the lead scraper
npm run dev           # node --watch server.js
npm run verify        # exercises every call all three frontends make
```

---

## Why there are two versions

This backend is the merge of two that had grown apart, and they disagreed
about what `/api/properties` means. Versioning is what makes that
disagreement harmless rather than a silent bug.

**v1 — the onboarding surface.** `POST /api/v1/properties` does *not* write a
property. It stores the submission on a `verificationrequest` and sends the
owner a WhatsApp template through Twilio. The listing only reaches the
`properties` collection once the owner replies YES *and* a member of
`VERIFICATION_TEAM_NUMBERS` confirms. `PUT` and `DELETE` carrying an
`x-employee-email` header are refused unless an administrator has granted that
employee permission for that listing, and a grant is single-use.

**v2 — the public site and the leads panel.** `POST /api/v2/properties` writes
the property immediately, behind a bearer token. No Twilio, no approval chain.

Both behaviours are wanted. Neither is a bug. They just cannot share a path.

## Route map

```
/api/v1/health              process + database status         (shared router)
/api/v1/properties          onboarding CRUD, Cloudinary upload, WhatsApp verification
/api/v1/admin               admin console accounts, stats, activity, system telemetry
/api/v1/verifications       owner/verifier verification requests
/api/v1/whatsapp            Twilio inbound webhook
/api/v1/permissions         employee edit/delete permission requests

/api/v2/health              process + database status         (shared router)
/api/v2/listings            public Explore feed for lampose.com
/api/v2/properties          direct property CRUD for the leads panel
/api/v2/auth                leads panel + onboarding employee login
/api/v2/users               leads panel team management
/api/v2/scraper             Google Maps lead scraping, leads, CSV export
```

`GET /api` returns this map as JSON, and the boot banner prints it.

### Unversioned paths still work

Every frontend was written against unversioned paths, so each one resolves to
the version that already answered it. Nothing had to change to keep working:

| Path | Serves |
| --- | --- |
| `/api/properties` `/api/permissions` `/api/verifications` `/api/whatsapp` `/api/admin` | v1 |
| `/api/listings` `/api/auth` `/api/users` `/api/scraper` | v2 |
| `/api/health` | shared |

`/health`, `/listings`, `/auth`, `/users` and `/scraper` are also mounted
without the `/api` prefix, so a base URL that lost its `/api` still resolves.

**`/properties` with no `/api` prefix is deliberately not mounted.** It is the
one path where the two versions mean different things; a deployment whose base
URL lost its prefix should get a 404 that says so rather than the wrong
semantics silently.

## Layout

```
server.js              boot, banner, graceful shutdown
app.js                 the Express app (split out so scripts/ can boot it)
config/
  env.js               all configuration, read once — loads .env
  db.js                connection + retry + the v1 in-memory failover
  cors.js              one policy for all three frontends
  twilio.js            WhatsApp templates for owner/verifier verification
middleware/
  requestLogger.js     one console line per API call
  errorHandler.js      404 + error translation to JSON
  authMiddleware.js    JWT for the v2 (scriper_users) identity
  requireDb.js         503 DB_DISCONNECTED instead of a buffered query
models/                Property (shared), Admin, VerificationRequest,
                       PermissionRequest, scriper (User/ScrapeJob/ScrapedLead)
controllers/           v2 handlers
routes/v1/  routes/v2/ per-version routers
routes/index.js        the version registry and legacy aliases
services/              permissionStore (v1), playwrightScraper (v2)
storage/dbStore.js     leads data access, MongoDB or local JSON
utils/                 listing projection, regex escaping
scripts/               verify, smoke, inspect, export, migrate
```

## Two identity systems

They share a process and a database and nothing else. Do not try to make one
verify the other's tokens.

| | v1 admin console | v2 leads panel |
| --- | --- | --- |
| Route | `/api/v1/admin/login` | `/api/v2/auth/login` |
| Collection | `admins` | `scriper_users` |
| Roles | Super Admin / Admin / Editor / Viewer | ADMIN / EMPLOYEE |
| Token verified server-side? | No — the console holds it client-side | Yes, on every guarded route |

The onboarding app authenticates its field agents against the **v2** accounts
(`/api/v2/auth/onboarding-login`), then identifies them on writes with the
`x-employee-email` header, which the v1 permission gate reads.

## Every API call is logged

`middleware/requestLogger.js` is the first middleware in the stack — before
CORS — so preflights, blocked origins and 404s are all visible. The line is
printed when the response finishes, so it carries the status and duration.

```
🌐 [10:35:12 PM] 🟢 [v2] GET /api/v2/listings?category=PG → 200 (35ms) | from 127.0.0.1 | query: {"category":"PG"}
🌐 [10:35:13 PM] 🟡 [v2] POST /api/v2/auth/login → 401 (33ms) | from https://leads.lampose.com | body: {"email":"nobody@example.com","password":"***REDACTED***"}
🌐 [10:35:13 PM] 🟡 [v1] PUT /api/v1/properties/68f… → 403 (22ms) | from 127.0.0.1 | body: {"name":"x","image":"<image/jpeg, 391B base64>"} | employee: field.agent@lampose.in
🌐 [10:35:13 PM] 🟡 [—] GET /api/nope → 404 (1ms) | from 127.0.0.1
```

The `[v1]`/`[v2]` tag is the resolved version, so a call that reached the wrong
surface is obvious in the log rather than something you deduce from the
payload. `[v1*]`/`[v2*]` marks an unversioned path. Fields named password,
token, secret or adminCode are redacted; base64 images are collapsed to their
size. Turn bodies off with `REQUEST_LOG_BODY=false`, the whole thing off with
`REQUEST_LOGGING=false`.

## Failure behaviour

Nothing here exits the process. One backend now serves three frontends, and a
fault affecting one must not take the other two down.

- **MongoDB unreachable at boot** — the server still listens. v2 routes answer
  `503 DB_DISCONNECTED`; v1 falls back to its in-memory store so field agents
  can keep submitting. The connection retries every `DB_RETRY_MS`, and the
  failover is cleared when it lands. `GET /api/health` reports
  `inMemoryFallback: true` while it is on. **Anything written during that
  window lives only in the process.**
- **`JWT_SECRET` missing in production** — `/api/v2/auth` and `/api/v2/users`
  answer `503 AUTH_NOT_CONFIGURED`. No forgeable token is ever issued, and the
  public site and onboarding app keep working. (The original leads backend
  refused to boot over this, which is no longer an option.)
- **Playwright not installed** — only `POST /api/v2/scraper/start` answers 503.
  It is required lazily for exactly this reason.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run verify` | 78 checks. Boots the app and replays every call the three frontends make — plus the admin-console routes no frontend in this repo calls — checking each response carries the fields the calling component reads. Add `--scrape` for a live Google Maps scrape. Cleans up after itself, in MongoDB *and* Cloudinary. |
| `npm run smoke` | Faster "is it healthy" check, including the CORS preflight from each production origin. Gates a deploy. `SMOKE_URL=https://api.lampose.com npm run smoke` to test a deployment. |
| `npm run inspect:db` | Collection names, counts and document shapes. Never prints the connection string. |
| `npm run inspect:properties` | Category/stayType/amenity tallies and image coverage across `properties`. |
| `npm run export:listings` | Writes a build-time snapshot of `properties` into the public site's `src/data/listings.js`. `:clean` drops obvious test rows. |
| `npm run migrate:json` | One-way, idempotent import of an old `data/*.json` leads store into MongoDB. |
| `npm run seed:admins` | Creates the first v1 Super Admin. |

Two things `verify` deliberately does not do, and why:

- **A complete `POST /api/v1/properties`.** That endpoint sends a real
  WhatsApp message to a real number. The route is exercised through its
  validation paths instead, which return before Twilio is touched.
- **A live scrape**, unless you pass `--scrape`. Without it, the check
  confirms Playwright's Chromium actually launches.

Everything else is exercised for real, including the Cloudinary uploads: it
posts 1x1 PNGs through multipart and destroys them again on the way out.

## Configuration

See `.env.example` — every variable is documented there. The ones worth
knowing about:

- `VERIFICATION_TEAM_NUMBERS` — when **empty**, an owner's YES auto-verifies
  the property with no second pair of eyes. Set it to put a verifier in the
  loop.
- `BODY_LIMIT` — 25mb, not the 1mb the leads backend used. The onboarding app
  posts base64 images in the JSON body; lowering this breaks image upload.
- `REQUIRE_AUTH` — turns the v2 guards off. Leave it on.
- `SEED_DEFAULT_USERS` — keep false whenever `MONGO_URI` points at the real
  cluster; the demo credentials are public knowledge.

## Deploy

`deploy/` has an nginx vhost and a systemd unit, both pointing at port 5001.
Two things in there that are easy to get wrong and are commented in place: do
not add `Access-Control-Allow-Origin` in nginx (the app already sets it
per-origin, and two headers make every browser reject the response), and point
your uptime check at `/api/health/live` rather than `/api/health` — the latter
answers 503 when MongoDB is down, which would restart-loop the container over
a fault it cannot fix.
