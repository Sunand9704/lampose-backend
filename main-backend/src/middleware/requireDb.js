/* A query issued while the connection is down sits in mongoose's buffer until
   it times out and surfaces as a generic 500 ten seconds later. Neither
   frontend has fallback data, so the visitor is looking at an error either
   way — it should be the true one, immediately.

   `DB_DISCONNECTED` is the code the Lampose client keys off to say "the
   server is up but its database is not" rather than "the server is down". */
import { isLamposeUp, isScriperUp } from '../config/db.js';

const unavailable = (res, which) => res.status(503).json({
  success: false,
  code: 'DB_DISCONNECTED',
  message: `The server is running but not connected to the ${which} database.`,
  error: `The server is running but not connected to the ${which} database.`,
});

export const requireLamposeDb = (req, res, next) => (
  isLamposeUp() ? next() : unavailable(res, 'listings')
);

export const requireScriperStore = (req, res, next) => (
  isScriperUp() ? next() : unavailable(res, 'scriper')
);

export default requireLamposeDb;
