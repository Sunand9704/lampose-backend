/* ══════════════════════════════════════════════════════════════════════════
   Health, mounted under both /api/v1 and /api/v2 as well as the unversioned
   /api/health and /health.

   The payload is the union of what the two merged backends returned, because
   both shapes have live readers:

     lampose-frontend  listingsApi.diagnose() reads `database.connected` to
                       tell a dead API from a disconnected database
     the old v1 probe  read `status`, `service` and `uptimeSeconds`

   Nothing was renamed, so no client had to change.
   ══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const config = require('../config/env');
const {
  lamposeStatus,
  scriperStatus,
  isLamposeUp,
  isScriperUp,
  getIsInMemory,
} = require('../config/db');
const dbStore = require('../storage/dbStore');

const router = express.Router();

/* Liveness: is the process answering at all? Always 200 while it is.

   Kept separate from /health on purpose. A platform health check pointed at a
   probe that returns 503 when MongoDB is unreachable will restart-loop the
   container over a fault the container cannot fix, taking the clear error
   message down with it. Point the platform here and humans at /health. */
router.get('/live', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// @route   GET /api/health  |  /api/v1/health  |  /api/v2/health
// @desc    Reports the process and each datastore apart, so a client can say
//          which link is broken instead of "something failed".
// @access  Public
router.get('/', (req, res) => {
  const lampose = lamposeStatus();
  const scriper = scriperStatus();
  const healthy = isLamposeUp() && isScriperUp();
  const uptimeSeconds = Math.round(process.uptime());

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'Lampose Main Backend API',
    message: healthy
      ? 'Backend server is running and connected to the database'
      : 'Backend server is running but the database is not connected',
    /* The Lampose client reads `database.connected` to tell a dead API from a
       disconnected database, so this key keeps its original shape. */
    database: lampose,
    /* One connection serves both data domains, but they are reported apart:
       a client should be able to say which half is unavailable, and the leads
       half can be on the JSON store. */
    databases: { lampose, scriper },
    collections: {
      v1: ['properties', 'admins', 'verificationrequests', 'permissionrequests'],
      v2: ['properties', 'scriper_users', 'scriper_jobs', 'scriper_leads'],
    },
    apis: {
      v1: 'onboard.lampose.com — onboarding, admin console, WhatsApp verification, permissions',
      v2: 'lampose.com + leads.lampose.com — listings, auth, users, leads scraper',
    },
    storage: dbStore.isMongo() ? 'MongoDB' : 'Local JSON Store',
    /* True only when the first connection attempt failed and the v1 routes
       fell back to their process-local store. Anything written while this is
       on is not in MongoDB. */
    inMemoryFallback: getIsInMemory(),
    uptime: process.uptime(),
    uptimeSeconds,
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
});

module.exports = router;
