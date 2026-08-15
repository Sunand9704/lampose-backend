const express = require('express');
const { getListings, getListingById } = require('../../controllers/listingController');
const { requireLamposeDb } = require('../../middleware/requireDb');

const router = express.Router();

/* Public and unauthenticated — this is what lampose.com's Explore and Listing
   pages read. */
router.get('/', requireLamposeDb, getListings);
router.get('/:id', requireLamposeDb, getListingById);

module.exports = router;
