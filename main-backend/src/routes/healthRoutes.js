import express from 'express';
import config from '../config/env.js';
import { lamposeStatus, scriperStatus, isLamposeUp, isScriperUp } from '../config/db.js';
import dbStore from '../storage/dbStore.js';

const router = express.Router();

/* Liveness: is the process answering at all? Always 200 while it is.

   Kept separate from /health on purpose. A platform health check pointed at a
   probe that returns 503 when MongoDB is unreachable will restart-loop the
   container over a fault the container cannot fix, taking the clear error
   message down with it. Point the platform here and humans at /health. */
router.get('/live', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// @route   GET /api/health
// @desc    Reports the process and each datastore apart, so a client can say
//          which link is broken instead of "something failed".
// @access  Public
router.get('/', (req, res) => {
  const lampose = lamposeStatus();
  const scriper = scriperStatus();
  const healthy = isLamposeUp() && isScriperUp();

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'Lampose Main Backend',
    message: healthy
      ? 'Backend server is running and connected to the database'
      : 'Backend server is running but the database is not connected',
    /* The Lampose client reads `database.connected` to tell a dead API from a
       disconnected database, so this key keeps its original shape. */
    database: lampose,
    /* One connection now serves both, but the two data domains are still
       reported apart: a client should be able to say which half is
       unavailable, and the scriper half can be on the JSON store. */
    databases: { lampose, scriper },
    collections: {
      lampose: ['properties'],
      scriper: ['scriper_users', 'scriper_jobs', 'scriper_leads'],
    },
    storage: dbStore.isMongo() ? 'MongoDB' : 'Local JSON Store',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
});

export default router;
