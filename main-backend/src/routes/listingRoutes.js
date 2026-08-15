import express from 'express';
import { getListings, getListingById } from '../controllers/listingController.js';
import { requireLamposeDb } from '../middleware/requireDb.js';

const router = express.Router();

router.get('/', requireLamposeDb, getListings);
router.get('/:id', requireLamposeDb, getListingById);

export default router;
