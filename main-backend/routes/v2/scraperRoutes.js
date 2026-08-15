const express = require('express');
const scraperController = require('../../controllers/scraperController');
const { requireScriperStore } = require('../../middleware/requireDb');

const router = express.Router();

router.use(requireScriperStore);

// Scrape operations
router.post('/start', scraperController.startScrape);
router.get('/status/:jobId', scraperController.getStatus);
router.post('/stop/:jobId', scraperController.stopScrape);

// Leads & data management
router.get('/leads', scraperController.getLeads);
router.post('/assign', scraperController.assignLeads);
router.patch('/leads/:id/status', scraperController.updateLeadStatus);

/* Left unauthenticated deliberately. The dashboard downloads this with
   window.open(), a plain browser navigation that cannot carry an
   Authorization header — putting `protect` here would break the export
   button rather than secure it. Guarding it properly needs a signed
   short-lived download URL, which is a change to the frontend too. */
router.get('/export', scraperController.exportLeads);

// Job history, team & statistics
router.get('/jobs', scraperController.getJobs);
router.get('/stats', scraperController.getStats);
router.get('/team-stats', scraperController.getTeamStats);

module.exports = router;
