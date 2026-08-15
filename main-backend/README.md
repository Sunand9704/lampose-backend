# Lampose Main Backend

One Express API serving both frontends:

| Frontend | Was served by | Calls |
| --- | --- | --- |
| `Lampose/lampose-frontend` (public site) | `lampose-backend` | `/api/health`, `/api/listings` |
| `scriper_vol_3/scriper-frontend` (leads + onboarding panel) | `scriper-backend` | `/api/auth`, `/api/users`, `/api/scraper`, `/api/properties` |

Neither frontend needs a change: both already point at `http://localhost:5000/api`
(`VITE_API_BASE_URL` and `VITE_API_URL` respectively), and every route below is
mounted at **both** `/api/x` and `/x` so a base URL written either way works.

---

## Quick start

```bash
npm install
npx playwright install --with-deps chromium   # only needed for the scraper
cp .env.example .env                          # then fill in MONGO_URI + secrets
npm run dev
```

Verify everything before you trust it:

```bash
npm run smoke                                 # boots the app and checks every route group + CORS
SMOKE_URL=https://api.lampose.com npm run smoke   # or against a deployment
```

There are no accounts on a fresh database. Create the first administrator
through the panel's register form, or:

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"you@lampose.in","password":"<password>","role":"ADMIN","adminCode":"<ADMIN_SECRET_KEY>"}'
```

---

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | – | 200 healthy, 503 when a datastore is down. Reports each store separately. |
| GET | `/api/health/live` | – | Always 200 — point platform health checks here. |
| GET | `/api/listings` | – | Explore feed. Filters: `category`, `city`, `maxPrice`, `search`. |
| GET | `/api/listings/:id` | – | |
| GET | `/api/properties` | – | Raw onboarding documents. Filters: `category`, `search`, `place`, `stayType`. |
| GET | `/api/properties/:id` | – | |
| POST | `/api/properties` | ✅ | Onboard a property. |
| DELETE | `/api/properties/:id` | ✅ | |
| POST | `/api/auth/register` | – | `role: ADMIN` requires `adminCode`. |
| POST | `/api/auth/login` | – | |
| POST | `/api/auth/onboarding-login` | – | Alias: `/api/auth/verify-employee`. |
| POST | `/api/auth/verify-token` | – | |
| GET | `/api/auth/me` | ✅ | |
| GET | `/api/users` | ✅ | |
| POST | `/api/users` | ✅ ADMIN | |
| DELETE | `/api/users/:userId` | ✅ ADMIN | |
| POST | `/api/scraper/start` | – | 503 if Chromium is not installed. |
| GET | `/api/scraper/status/:jobId` | – | |
| POST | `/api/scraper/stop/:jobId` | – | |
| GET | `/api/scraper/leads` | – | |
| POST | `/api/scraper/assign` | – | |
| PATCH | `/api/scraper/leads/:id/status` | – | |
| GET | `/api/scraper/export` | – | `format=csv\|json`. |
| GET | `/api/scraper/jobs` `/stats` `/team-stats` | – | |

`✅` = a bearer token is required. Turn the added guards off with
`REQUIRE_AUTH=false`; `/api/auth/me` stays guarded regardless.

`/api/scraper/*` is deliberately left open, as it was in the original backend.
The dashboard downloads `/api/scraper/export` with `window.open()`, which
cannot send an `Authorization` header — adding `protect` there would break the
export button rather than secure it. Locking the group down needs a signed
download URL and a frontend change; see *Known gaps* below.

---

## Data

**One database, one connection.** `MONGO_URI` points at it (e.g.
`lamp_onboarding`); `DB_NAME` overrides the database named in the URI if you
ever need to. The two data domains are kept apart by collection name:

| Collection | Written by |
| --- | --- |
| `properties` | the onboard.lampose.com backend **and** this one |
| `admins`, `verificationrequests` | onboard.lampose.com only — untouched here |
| `scriper_users` | this backend only |
| `scriper_jobs` | this backend only |
| `scriper_leads` | this backend only |

The `scriper_` prefix is deliberate rather than cosmetic. This database has a
second writer whose code is not in this repo; it keeps its accounts in
`admins` today, but nothing stops it adding a `users` collection later, at
which point two apps with different schemas would be sharing one collection
and logins would misbehave for reasons nobody could find.

For the same reason `Property` is declared `strict: false` — that collection's
shape can change without this repo changing, and a field the other backend
adds must survive a write from here rather than being dropped.

**Importing the old JSON store.** The previous scriper backend kept its data in
`scriper-backend/data/*.json` (its `MONGODB_URI` still had the `<db_password>`
placeholder, so it never reached Mongo). To carry that history across:

```bash
npm run migrate:json -- --dry-run     # count what would be imported
npm run migrate:json                  # import it
```

Idempotent — users match on email, jobs on `jobId`, leads on
`jobId + business name + phone`.

---

## Deploying

1. Set `NODE_ENV=production`. The server **refuses to start** if `JWT_SECRET`
   or `ADMIN_SECRET_KEY` is missing — a forgeable token is worse than an
   outage.
2. Set a real `JWT_SECRET`:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
3. Set `MONGO_URI`. Do **not** run production on the JSON store: a container
   filesystem is wiped on every deploy. The server warns loudly if you do.
4. Point the platform health check at `/api/health/live`, not `/api/health` —
   the latter answers 503 when MongoDB is unreachable, which would restart-loop
   the container over a fault the container cannot fix.
5. Add any origin outside `*.lampose.com` / localhost / the usual preview hosts
   to `ALLOWED_ORIGINS`.
6. For the scraper, run `npx playwright install --with-deps chromium` in the
   build step. Without it the API still runs and only `/api/scraper/start`
   answers 503.

`npm run smoke` against the deployed URL checks all of the above, including the
CORS preflight from each production origin — the failure that only ever
reproduces in a browser.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm start` | Run the API. |
| `npm run smoke` | Boot and exercise every route group + CORS. Exits non-zero on failure. |
| `npm run verify` | Every API call both frontends make, checked field by field. `-- --scrape` adds a live scrape. |
| `npm run migrate:json` | Import the old scriper JSON store into MongoDB. |
| `npm run export:listings` | Regenerate `lampose-frontend/src/data/listings.js` from `properties`. |
| `npm run inspect:db` | Collection shapes and counts. |
| `npm run inspect:properties` | Field coverage across `properties`. |
| `npm run browsers` | Install Chromium for the scraper. |

---

## Known gaps

- **`/api/scraper/*` is unauthenticated**, as it was before the merge. Anyone
  who knows the host can read and export the leads table. Fixing it properly
  means issuing a short-lived signed URL for the export and adding `protect` to
  the rest — a frontend change too, so it is called out rather than done
  quietly.
- **The scraper is in-process.** A scrape holds a headless Chromium for the
  duration; several concurrent jobs on a small instance will exhaust its
  memory. If it gets busy, move it to a worker.
- **Job progress is in-process memory.** Behind more than one instance, a
  status poll can land on the replica that is not running the job; it falls
  back to the database record, so progress appears to jump rather than stream.
