/* ══════════════════════════════════════════════════════════════════════════
   Every route group, mounted twice.

   The two frontends disagree about whether the /api prefix belongs in their
   base URL — Lampose ships VITE_API_BASE_URL=http://host:5000/api, Scriper
   ships VITE_API_URL=http://host:5000/api, and a deployment that trims the
   suffix in either one would 404 on everything. Mounting each router at both
   /api/x and /x makes both spellings work, which is what the Lampose backend
   already did and what stops a copy-paste of the wrong env var from becoming
   a production outage.
   ══════════════════════════════════════════════════════════════════════════ */
import healthRoutes from './healthRoutes.js';
import listingRoutes from './listingRoutes.js';
import propertyRoutes from './propertyRoutes.js';
import authRoutes from './authRoutes.js';
import userRoutes from './userRoutes.js';
import scraperRoutes from './scraperRoutes.js';

export const ROUTE_GROUPS = [
  ['/health', healthRoutes],
  ['/listings', listingRoutes],
  ['/properties', propertyRoutes],
  ['/auth', authRoutes],
  ['/users', userRoutes],
  ['/scraper', scraperRoutes],
];

export const registerRoutes = (app) => {
  for (const [path, router] of ROUTE_GROUPS) {
    app.use(`/api${path}`, router);
    app.use(path, router);
  }
};

export default registerRoutes;
