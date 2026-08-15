import express from 'express';
import {
  getProperties,
  getPropertyById,
  createProperty,
  deleteProperty,
} from '../controllers/propertyController.js';
import { requireLamposeDb } from '../middleware/requireDb.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

/* Reads are public — the same rows are already public through /api/listings.
   Writes are not: without a guard, anyone who finds this host could delete
   every property in the collection. The onboarding panel runs entirely behind
   its own login and its axios client attaches the token to every request, so
   this costs it nothing. Set REQUIRE_AUTH=false to lift it. */
router.get('/', requireLamposeDb, getProperties);
router.get('/:id', requireLamposeDb, getPropertyById);
router.post('/', protect, requireLamposeDb, createProperty);
router.delete('/:id', protect, requireLamposeDb, deleteProperty);

export default router;
