import express from 'express';
import cors from 'cors';

import config from './config/env.js';
import corsOptions from './config/cors.js';
import requestLogger from './middleware/requestLogger.js';
import { registerRoutes, ROUTE_GROUPS } from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

const app = express();

/* Behind Render/Railway/Nginx the socket address is the proxy's. Without
   this, req.ip is useless in logs and req.protocol is always http. */
if (config.trustProxy) app.set('trust proxy', 1);

// Express advertises itself in a header by default; nothing needs to know.
app.disable('x-powered-by');

/* CORS runs before everything else so a rejected origin never reaches a
   handler, and so preflights are answered by this middleware — no
   app.options('*'), which Express 5's path parser rejects outright. */
app.use(cors(corsOptions));

app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));

// After the body parsers, so the log line can show what was posted.
app.use(requestLogger);

app.get(['/', '/api'], (req, res) => {
  res.json({
    message: 'Lampose Main Backend API',
    status: 'running',
    environment: config.nodeEnv,
    endpoints: ROUTE_GROUPS.map(([path]) => `/api${path}`),
  });
});

registerRoutes(app);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
