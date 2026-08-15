# Deploying to a VPS

Ubuntu 22.04/24.04. Substitute your own paths and domain.

## Before you start — four things that will bite

1. **MongoDB Atlas will refuse the VPS.** Atlas blocks every IP that is not on
   its Network Access list, and your VPS is not on it. The backend starts fine,
   then every data route answers `503 DB_DISCONNECTED` and the log reads
   `Server selection timed out`. Add the VPS's public IP in
   Atlas → Network Access → Add IP Address **before** you deploy. This is the
   single most likely reason a first deploy looks broken.
2. **Check your secrets before you ship them.** `.env.example` is in the repo,
   so anything still set to its example value is public knowledge — and
   `ADMIN_SECRET_KEY` is what stops a stranger registering themselves as an
   administrator. The current `JWT_SECRET` is also under the 32 characters the
   server warns about in production. Generate real ones (step 4).
3. **Playwright needs system libraries and RAM.** Chromium pulls ~50 apt
   packages and uses roughly 1 GB while a scrape runs. On a 1 GB VPS the scrape
   will be OOM-killed. 2 GB is the practical minimum; the systemd unit caps the
   service at 1.5 GB so a runaway job cannot take the box down.
4. **Get your leads off the old server first.** The old leads backend stored
   everything in `data/*.json` on its own disk — 3 users, 11 jobs and 225 leads
   in the copy in this repo, and the deployed one has its own. There is no
   database copy. Download those files before you decommission anything.

## 1. Node

The app requires Node ≥ 18 (`engines` in package.json), but Playwright's
Chromium and `node --watch` are happier on 22. Ubuntu's default is older, so
use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

## 2. A user and a directory

Run as an unprivileged user — the service should not be able to touch the rest
of the box.

```bash
sudo adduser --system --group --home /srv/lampose-api lampose
sudo mkdir -p /srv/lampose-api
sudo chown lampose:lampose /srv/lampose-api
```

## 3. Code and dependencies

```bash
sudo -u lampose git clone <your-repo> /srv/lampose-api
cd /srv/lampose-api
sudo -u lampose npm ci --omit=dev

# Chromium for the scraper. --with-deps installs the apt packages, so this
# one needs root. Skip it if you do not want scraping on this box: the API
# still runs and only /api/v2/scraper/start answers 503.
sudo npx playwright install --with-deps chromium
```

Everything the app needs at runtime is a plain dependency — express, mongoose,
bcryptjs, jsonwebtoken, multer, cloudinary, twilio, playwright — so
`npm ci --omit=dev` installs the lot.

## 4. Environment

```bash
sudo -u lampose cp .env.example .env
sudo -u lampose nano .env
sudo chmod 600 /srv/lampose-api/.env
```

Minimum for production:

```ini
NODE_ENV=production
PORT=5001
MONGO_URI=mongodb+srv://user:pass@cluster0.xxxx.mongodb.net/lamp_onboarding?retryWrites=true&w=majority
JWT_SECRET=<64 hex chars — see below>
ADMIN_SECRET_KEY=<something only you know>
```

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The server **starts anyway** if either secret is missing, but disables what
they protect: `/api/v2/auth` and `/api/v2/users` answer
`503 AUTH_NOT_CONFIGURED`, so no forgeable token is ever issued. It used to
exit instead. It cannot now — one process serves all three frontends, and
killing it over the leads panel's login would take lampose.com and
onboard.lampose.com down with it. Read the `[config]` lines at the top of the
boot log; they name every fault in one pass.

You do not need `ALLOWED_ORIGINS`: lampose.com, www, leads, onboard and every
`*.lampose.com` host are built in.

## 5. Service

```bash
sudo cp deploy/lampose-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lampose-api
sudo systemctl status lampose-api
sudo journalctl -u lampose-api -f
```

A healthy boot logs `✅ [MongoDB Connected]` and prints the banner, which lists
both API versions, every mounted route and the CORS allowlist. Every API call
after that gets one line — see the "Every API call is logged" section of the
README.

## 6. Import the old leads

Copy `users.json`, `jobs.json`, `leads.json` off the old server, then:

```bash
sudo -u lampose npm run migrate:json -- --from /path/to/downloaded --dry-run
sudo -u lampose npm run migrate:json -- --from /path/to/downloaded
```

Password hashes are copied verbatim, so existing accounts keep their passwords.
Idempotent — running it twice imports nothing the second time.

If you skip this, the panel has no accounts and nobody can log in. Create the
first administrator instead:

```bash
curl -X POST http://127.0.0.1:5001/api/v2/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"you@lampose.in","password":"<pw>","role":"ADMIN","adminCode":"<ADMIN_SECRET_KEY>"}'
```

## 7. nginx and TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-api.lampose.com.conf /etc/nginx/sites-available/api.lampose.com
sudo ln -s /etc/nginx/sites-available/api.lampose.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.lampose.com
```

Read the comment at the top of that config before editing it: adding CORS
headers in nginx breaks CORS, because the app already sets them and browsers
reject a response carrying two `Access-Control-Allow-Origin` headers.

## 8. Firewall

Only 80/443 should be public. Node stays on 127.0.0.1:5001 behind nginx.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 9. Verify before repointing anything

```bash
cd /srv/lampose-api
SMOKE_URL=https://api.lampose.com npm run smoke      # 25 route + CORS checks
SMOKE_URL=https://api.lampose.com npm run verify     # 78 API calls
```

Both exit non-zero on failure, so they can gate the switch.

## 10. Repoint the frontends

```
lampose-frontend/.env     VITE_API_BASE_URL=https://api.lampose.com/api/v2
leads-frontend/.env       VITE_API_URL=https://api.lampose.com/api/v2
onboards-frontend/.env    VITE_API_URL=https://api.lampose.com/api/v1/properties
                          VITE_AUTH_API_URL=https://api.lampose.com/api/v2/auth/onboarding-login
```

The `/v2` on the leads panel is not cosmetic. Unversioned `/api/properties` is
the onboarding app's endpoint, where a POST sends the owner a WhatsApp
verification instead of creating the listing. Point the leads panel at plain
`/api` and its "Add Property" button silently starts messaging owners.

Vite bakes these in **at build time**, not at runtime. Changing the value
requires a rebuild and redeploy of the frontend — restarting it is not enough,
and the symptom is the old backend URL still showing in the network tab.

Do one frontend at a time and leave the old backends running for a few days.
Rolling back is just putting the old URL back and rebuilding.

## Updating later

```bash
cd /srv/lampose-api
sudo -u lampose git pull
sudo -u lampose npm ci --omit=dev
sudo systemctl restart lampose-api
```

Restart is graceful: systemd sends SIGTERM, the app stops accepting new
connections, finishes what is in flight, disconnects from MongoDB and exits.
An in-progress scrape is abandoned — its job row stays at `running`, which is
cosmetic, but avoid restarting mid-scrape if you can.
