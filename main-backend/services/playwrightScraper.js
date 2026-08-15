/* ══════════════════════════════════════════════════════════════════════════
   Google Maps scraping engine.

   Playwright is required lazily. It is a ~150 MB dependency whose browsers
   are downloaded by a separate step, and on a host where that step was
   skipped a top-level require throws while the module graph is loading —
   which would take the whole API down, the public listings and the
   onboarding app included, over a feature most requests never touch. Loaded
   on first use instead, a missing browser is a 503 on
   /api/v2/scraper/start and nothing else.
   ══════════════════════════════════════════════════════════════════════════ */
const config = require('../config/env');
const dbStore = require('../storage/dbStore');

/* In-memory progress, so the dashboard can poll a job that is still running.
   Entries are dropped a while after the job ends: the final state is in the
   database, and a Map that only ever grows is a leak in a long-lived process. */
const activeJobs = new Map();
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;

let chromiumRef = null;

const getChromium = async () => {
  if (chromiumRef) return chromiumRef;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    chromiumRef = require('playwright').chromium;
    return chromiumRef;
  } catch (error) {
    chromiumRef = null; // let a later request try again
    throw new Error(
      `The scraping engine is unavailable: ${error.message}. `
      + 'Run "npm install playwright && npx playwright install --with-deps chromium" on this host.',
    );
  }
};

class ScraperUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScraperUnavailableError';
    this.status = 503;
    this.code = 'SCRAPER_UNAVAILABLE';
  }
}

/* ── Field helpers ────────────────────────────────────────────────────── */

function cleanPhone(raw) {
  if (!raw) return '';
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  return cleaned.length < 6 ? '' : cleaned;
}

function extractEmail(text) {
  if (!text) return '';
  const match = String(text).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : '';
}

/* Prefers exact coordinates, then the scraped place URL, then a name+address
   search — so the "open in maps" button always has something to open. */
function buildMapsUrl(placeUrl, businessName, address, latitude, longitude) {
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }
  if (placeUrl && placeUrl.includes('/maps/place/')) return placeUrl;

  const term = [businessName, address].filter(Boolean).join(', ').trim();
  return term ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(term)}` : '';
}

const forget = (jobId) => {
  const timer = setTimeout(() => activeJobs.delete(jobId), FINISHED_JOB_TTL_MS);
  if (timer.unref) timer.unref();
};

/* Opt-in (SCRAPER_FILL_SHORT_RESULTS=true) padding so a demo always looks
   full. Off by default: invented rows are indistinguishable from scraped ones
   once they are in the leads table, and someone will eventually call one. */
function generateFillerLeads(jobId, count, { source, queryKeyword, location, landmark }) {
  const categories = [queryKeyword || 'Business Services', 'Consultant', 'Enterprise', 'Provider', 'Agency'];
  const filler = [];

  for (let i = 1; i <= count; i += 1) {
    const marker = Math.floor(1000 + Math.random() * 9000);
    const name = `[SAMPLE] ${queryKeyword || 'Lead'} ${landmark || location} ${i} (${marker})`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const website = Math.random() > 0.3 ? `https://www.${slug}.com` : '';
    const address = landmark
      ? `Plot ${marker}, Near ${landmark}, ${location}`
      : `Plot ${marker}, Sector ${i}, ${location}`;

    filler.push({
      jobId,
      source,
      businessName: name,
      phone: `+91 ${Math.floor(7000000000 + Math.random() * 2999999999)}`,
      email: website ? `contact@${slug}.com` : '',
      website,
      hasWebsite: Boolean(website),
      address,
      rating: (3.8 + Math.random() * 1.1).toFixed(1),
      reviewsCount: Math.floor(10 + Math.random() * 250),
      category: categories[i % categories.length],
      city: location,
      landmark,
      mapsUrl: buildMapsUrl('', landmark ? `${landmark}, ${location}` : location, address),
      scrapedAt: new Date().toISOString(),
    });
  }

  return filler;
}

async function finishStopped(jobId, jobState) {
  console.log(`[scraper] job ${jobId} stopped by user`);
  jobState.progress = 100;
  jobState.statusMessage = 'Scrape mission stopped by user';
  await dbStore.updateJob(jobId, {
    status: 'stopped',
    progress: 100,
    statusMessage: 'Scrape mission stopped by user',
  });
  return forget(jobId);
}

async function runBrowserScrape(jobId, options) {
  const { searchQuery, source, targetDepth, location, queryKeyword, landmark } = options;
  const jobState = activeJobs.get(jobId);
  const chromium = await getChromium();

  let browser = null;

  const report = async (progress, statusMessage) => {
    jobState.progress = progress;
    jobState.statusMessage = statusMessage;
    await dbStore.updateJob(jobId, { progress, statusMessage });
  };

  try {
    browser = await chromium.launch({
      headless: true,
      /* --no-sandbox is required inside most containers, where the process
         cannot create its own user namespace. */
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    if (jobState.stopped) return await finishStopped(jobId, jobState);

    await report(15, `Navigating to search provider (${source})...`);

    const leads = [];

    if (source === 'GoogleMaps' || source === 'ALL') {
      const targetUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });

      // Consent interstitials appear in some regions and block the feed.
      try {
        const accept = await page.$('button[aria-label*="Accept"], button[aria-label*="Agree"]');
        if (accept) await accept.click();
      } catch { /* no interstitial: nothing to dismiss */ }

      await report(25, 'Searching listings & scrolling result feed...');

      const maxScrolls = Math.ceil(targetDepth / 3) + 3;
      for (let scroll = 0; scroll < maxScrolls && !jobState.stopped; scroll += 1) {
        // eslint-disable-next-line no-await-in-loop
        await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollTop += 1200;
          else window.scrollBy(0, 1200);
        });
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(2000);

        // eslint-disable-next-line no-await-in-loop
        const cardCount = await page.evaluate(() => document.querySelectorAll(
          'div[role="article"], div.Nv2PK, a[href*="/maps/place/"]',
        ).length);

        const progress = Math.min(80, 25 + Math.round((cardCount / targetDepth) * 55));
        // eslint-disable-next-line no-await-in-loop
        await report(progress, `Found ${cardCount} listing elements. Extracting data...`);

        if (cardCount >= targetDepth) break;
      }

      const rawResults = await page.evaluate((limit) => {
        const items = [];
        const seenNames = new Set();
        const cards = document.querySelectorAll('div[role="article"], div.Nv2PK, a[href*="/maps/place/"]');

        cards.forEach((card) => {
          if (items.length >= limit) return;

          const nameEl = card.querySelector('.qBF1Pd, .fontHeadlineSmall, [class*="title"], h3');
          const name = nameEl ? nameEl.textContent.trim() : '';
          if (!name || seenNames.has(name.toLowerCase())) return;
          seenNames.add(name.toLowerCase());

          const textContent = card.textContent || '';
          const phoneMatch = textContent.match(/(\+?\d{1,4}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}/);

          const ratingEl = card.querySelector('span.MW4etd, [aria-label*="stars"], span[aria-label*="rating"]');
          const reviewsEl = card.querySelector('span.UY7F9, [aria-label*="reviews"]');
          const categoryEl = card.querySelector('button[aria-label*="category"], .W4Efsd span');
          const websiteEl = card.querySelector('a[aria-label*="website"], a[data-value="Website"], a[href*="http"]:not([href*="google.com"])');
          const addressEl = card.querySelector('.W4Efsd:last-child, [class*="address"]');

          let reviewsCount = 0;
          if (reviewsEl) {
            const digits = reviewsEl.textContent.replace(/[^0-9]/g, '');
            if (digits) reviewsCount = parseInt(digits, 10);
          }

          let mapsUrl = '';
          if (card.tagName === 'A' && card.href && card.href.includes('/maps/place/')) {
            mapsUrl = card.href;
          } else {
            const placeLink = card.querySelector('a[href*="/maps/place/"]');
            if (placeLink) mapsUrl = placeLink.href;
          }

          let latitude = null;
          let longitude = null;
          if (mapsUrl) {
            // Place URLs embed coordinates as !3d<lat>!4d<lng> or @<lat>,<lng>
            const coords = mapsUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
              || mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
            if (coords) {
              latitude = parseFloat(coords[1]);
              longitude = parseFloat(coords[2]);
            }
          }

          items.push({
            businessName: name,
            phone: phoneMatch ? phoneMatch[0].trim() : '',
            rating: ratingEl ? ratingEl.textContent.trim() : '',
            reviewsCount,
            category: categoryEl ? categoryEl.textContent.trim() : '',
            website: websiteEl ? websiteEl.href : '',
            address: addressEl ? addressEl.textContent.trim() : '',
            mapsUrl,
            latitude,
            longitude,
          });
        });

        return items;
      }, targetDepth);

      console.log(`[scraper] job ${jobId} parsed ${rawResults.length} listings from the Maps DOM`);

      rawResults.forEach((item) => {
        if (jobState.stopped) return;

        const address = item.address || (landmark ? `Near ${landmark}, ${location}` : String(location));

        leads.push({
          jobId,
          source: 'GoogleMaps',
          businessName: item.businessName,
          phone: cleanPhone(item.phone) || item.phone || '',
          email: extractEmail(item.website || item.address || item.businessName),
          website: item.website || '',
          hasWebsite: Boolean(item.website && item.website.length > 5),
          address,
          /* Left blank when Maps did not show one. The original substituted
             "4.5" and "12 reviews", which is indistinguishable from a real
             rating once it reaches the dashboard. */
          rating: item.rating || '',
          reviewsCount: item.reviewsCount || 0,
          category: item.category || queryKeyword || 'Business',
          city: location,
          landmark,
          mapsUrl: buildMapsUrl(item.mapsUrl, item.businessName, address, item.latitude, item.longitude),
          latitude: item.latitude === null ? undefined : item.latitude,
          longitude: item.longitude === null ? undefined : item.longitude,
          scrapedAt: new Date().toISOString(),
        });
      });
    }

    if (config.scraper.fillShortResults && leads.length < targetDepth && !jobState.stopped) {
      leads.push(...generateFillerLeads(jobId, targetDepth - leads.length, {
        source, queryKeyword, location, landmark,
      }));
    }

    await browser.close();
    browser = null;

    if (jobState.stopped) return await finishStopped(jobId, jobState);

    const saved = await dbStore.saveLeads(leads);

    jobState.progress = 100;
    jobState.scrapedCount = saved.length;
    jobState.statusMessage = `Successfully extracted ${saved.length} leads!`;

    await dbStore.updateJob(jobId, {
      status: 'completed',
      progress: 100,
      statusMessage: `Scrape finished successfully. Extracted ${saved.length} records.`,
      resultCount: saved.length,
    });

    console.log(`[scraper] job ${jobId} completed — ${saved.length} leads saved`);
    return forget(jobId);
  } finally {
    /* A throw anywhere above must not leave a headless Chromium running: a
       few abandoned browsers will exhaust the memory of a small box. */
    if (browser) await browser.close().catch(() => {});
  }
}

/* ── Public API ───────────────────────────────────────────────────────── */

async function startScrapeJob(jobId, params) {
  if (!config.scraper.enabled) {
    throw new ScraperUnavailableError('Scraping is disabled on this deployment (SCRAPER_ENABLED=false).');
  }

  const { query, location, landmark = '', source = 'GoogleMaps', depth } = params;
  const targetDepth = Math.max(
    1,
    Math.min(parseInt(depth, 10) || config.scraper.defaultDepth, config.scraper.maxDepth),
  );
  const cleanLandmark = String(landmark || '').trim();

  /* A landmark biases the search to that neighbourhood, e.g.
     "PG near Andhra University, Visakhapatnam". */
  const searchQuery = (cleanLandmark
    ? `${query} near ${cleanLandmark}, ${location}`
    : `${query} in ${location}`).trim();

  /* Fail before any work starts if the engine cannot run at all, so the
     dashboard does not show a mission that was never going to move. */
  await getChromium().catch((error) => { throw new ScraperUnavailableError(error.message); });

  console.log(`[scraper] job ${jobId} started — "${searchQuery}" via ${source}, target ${targetDepth}`);

  const jobState = {
    jobId,
    stopped: false,
    progress: 5,
    statusMessage: 'Launching browser engine...',
    scrapedCount: 0,
  };
  activeJobs.set(jobId, jobState);

  await dbStore.updateJob(jobId, {
    status: 'running',
    progress: 5,
    statusMessage: `Launching browser for query: "${searchQuery}"`,
  });

  /* Deliberately not awaited: the request returns a job id straight away and
     the dashboard polls for progress. The catch is what keeps a scrape
     failure from becoming an unhandled rejection. */
  runBrowserScrape(jobId, {
    searchQuery, source, targetDepth, location, queryKeyword: query, landmark: cleanLandmark,
  })
    .catch(async (error) => {
      console.error(`[scraper] job ${jobId} failed: ${error.message}`);
      const state = activeJobs.get(jobId);
      if (state) {
        state.stopped = true;
        state.statusMessage = `Error: ${error.message}`;
      }
      await dbStore.updateJob(jobId, {
        status: 'error',
        statusMessage: `Error: ${error.message}`,
        error: error.message,
      });
      forget(jobId);
    });

  return jobState;
}

function getJobStatus(jobId) {
  return activeJobs.get(jobId) || null;
}

async function stopJob(jobId) {
  const jobState = activeJobs.get(jobId);
  if (jobState) {
    jobState.stopped = true;
    jobState.statusMessage = 'Stopping job...';
  }
  await dbStore.updateJob(jobId, { status: 'stopped', statusMessage: 'Stopped by user request' });
  console.log(`[scraper] stop requested for job ${jobId}`);
  return Boolean(jobState);
}

/* Called on shutdown so an in-flight scrape does not keep writing progress
   into a database the process is about to disconnect from. */
function stopAllJobs() {
  for (const state of activeJobs.values()) state.stopped = true;
}

module.exports = {
  startScrapeJob,
  getJobStatus,
  stopJob,
  stopAllJobs,
  ScraperUnavailableError,
};
