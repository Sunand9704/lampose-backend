const express = require('express');
const {
  getProperties,
  getPropertyById,
  createProperty,
  deleteProperty,
} = require('../../controllers/propertyController');
const { requireLamposeDb } = require('../../middleware/requireDb');
const { protect } = require('../../middleware/authMiddleware');

const router = express.Router();

/* Reads are public — the same rows are already public through
   /api/v2/listings. Writes are not: without a guard, anyone who found this
   host could delete every property in the collection. The leads panel runs
   entirely behind its own login and its axios client attaches the token to
   every request, so this costs it nothing. Set REQUIRE_AUTH=false to lift it.

   requireLamposeDb runs before protect on the write routes on purpose: the
   token check reads the user collection, and with the database down that
   query would buffer for ten seconds before failing with something that names
   nothing. Checking the connection first turns it into an immediate 503. */
router.get('/', requireLamposeDb, getProperties);
router.get('/:id', requireLamposeDb, getPropertyById);
router.post('/', requireLamposeDb, protect, createProperty);
router.delete('/:id', requireLamposeDb, protect, deleteProperty);

module.exports = router;
