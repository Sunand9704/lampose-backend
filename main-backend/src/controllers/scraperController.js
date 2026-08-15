import crypto from 'node:crypto';
import dbStore from '../storage/dbStore.js';
import playwrightScraper from '../services/playwrightScraper.js';

const fail = (res, status, message) => res.status(status).json({
  success: false,
  message,
  error: message,
});

const leadFilters = (query) => ({
  jobId: query.jobId,
  source: query.source,
  hasPhone: query.hasPhone,
  hasWebsite: query.hasWebsite,
  assignedUserId: query.assignedUserId,
  leadStatus: query.leadStatus,
  search: query.search,
});

// @route POST /api/scraper/start
export const startScrape = async (req, res, next) => {
  try {
    const { query, location, landmark = '', source = 'GoogleMaps', depth } = req.body || {};

    if (!query || !location) {
      return fail(res, 400, 'Both "query" and "location" are required parameters.');
    }

    const cleanLandmark = String(landmark || '').trim();
    const jobId = `job_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const name = cleanLandmark
      ? `${query} near ${cleanLandmark}, ${location} (${source})`
      : `${query} in ${location} (${source})`;

    await dbStore.createJob({
      jobId,
      name,
      source,
      query,
      location,
      landmark: cleanLandmark,
      depth: parseInt(depth, 10) || undefined,
      status: 'started',
      progress: 0,
      statusMessage: 'Task queued...',
    });

    try {
      /* Awaited only far enough to know the browser engine exists — the
         scrape itself runs on after the response is sent. */
      await playwrightScraper.startScrapeJob(jobId, {
        query, location, landmark: cleanLandmark, source, depth,
      });
    } catch (error) {
      /* The job row already exists, so leaving it at "started" would show a
         mission in the history that is never going to move. */
      await dbStore.updateJob(jobId, {
        status: 'error',
        statusMessage: error.message,
        error: error.message,
      });
      throw error;
    }

    return res.json({
      success: true,
      message: 'Scrape mission started successfully!',
      data: { jobId, name, source, query, location, landmark: cleanLandmark, depth },
    });
  } catch (error) {
    if (error.name === 'ScraperUnavailableError') return fail(res, 503, error.message);
    return next(error);
  }
};

// @route GET /api/scraper/status/:jobId
export const getStatus = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const live = playwrightScraper.getJobStatus(jobId);
    const stored = await dbStore.getJob(jobId);

    if (!live && !stored) return fail(res, 404, 'Job not found');

    /* The in-memory state is ahead of the database between progress writes,
       so it wins wherever it exists. */
    return res.json({
      success: true,
      data: {
        jobId,
        name: stored?.name || 'Scrape Mission',
        status: live
          ? (live.stopped ? 'stopped' : (stored?.status || 'running'))
          : (stored?.status || 'completed'),
        progress: live ? live.progress : (stored?.progress ?? 100),
        statusMessage: live ? live.statusMessage : (stored?.statusMessage || 'Completed'),
        resultCount: live ? live.scrapedCount : (stored?.resultCount ?? 0),
      },
    });
  } catch (error) {
    return next(error);
  }
};

// @route POST /api/scraper/stop/:jobId
export const stopScrape = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    await playwrightScraper.stopJob(jobId);
    return res.json({ success: true, message: `Job ${jobId} stop request submitted` });
  } catch (error) {
    return next(error);
  }
};

// @route GET /api/scraper/leads
export const getLeads = async (req, res, next) => {
  try {
    const leads = await dbStore.getLeads(leadFilters(req.query));
    return res.json({ success: true, count: leads.length, data: leads });
  } catch (error) {
    return next(error);
  }
};

// @route POST /api/scraper/assign
export const assignLeads = async (req, res, next) => {
  try {
    const { leadIds, userObj } = req.body || {};

    if (!Array.isArray(leadIds) || leadIds.length === 0 || !userObj?.userId) {
      return fail(res, 400, 'Missing leadIds array or userObj object.');
    }

    const assigned = await dbStore.assignLeads(leadIds, userObj);
    return res.json({
      success: true,
      count: assigned,
      message: `Successfully assigned ${assigned} lead(s) to ${userObj.name || 'the selected employee'}.`,
    });
  } catch (error) {
    return next(error);
  }
};

// @route PATCH /api/scraper/leads/:id/status
export const updateLeadStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, noteText, authorName } = req.body || {};

    if (!status) return fail(res, 400, 'Status is required.');

    const updated = await dbStore.updateLeadStatus(id, status, noteText, authorName);
    if (!updated) return fail(res, 404, 'Lead not found.');

    return res.json({ success: true, message: 'Lead status & notes updated successfully.' });
  } catch (error) {
    return next(error);
  }
};

// @route GET /api/scraper/team-stats
export const getTeamStats = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await dbStore.getTeamStats() });
  } catch (error) {
    return next(error);
  }
};

// @route GET /api/scraper/jobs
export const getJobs = async (req, res, next) => {
  try {
    const jobs = await dbStore.getJobs();
    return res.json({ success: true, count: jobs.length, data: jobs });
  } catch (error) {
    return next(error);
  }
};

// @route GET /api/scraper/stats
export const getStats = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await dbStore.getStats() });
  } catch (error) {
    return next(error);
  }
};

/* ── CSV ──────────────────────────────────────────────────────────────────
   A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so
   a business name of "=cmd|..." becomes executable the moment someone opens
   the export. Prefixing an apostrophe is the standard neutralisation and is
   invisible in the cell. */
const csvCell = (value) => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

const CSV_COLUMNS = [
  ['Business Name', (l) => l.businessName],
  ['Phone', (l) => l.phone],
  ['Email', (l) => l.email],
  ['Website', (l) => l.website],
  ['Has Website', (l) => (l.hasWebsite ? 'TRUE' : 'FALSE')],
  ['Address', (l) => l.address],
  ['Rating', (l) => l.rating],
  ['Reviews', (l) => l.reviewsCount ?? 0],
  ['Category', (l) => l.category],
  ['City', (l) => l.city],
  ['Landmark / Area', (l) => l.landmark],
  ['Google Maps Link', (l) => l.mapsUrl],
  ['Assigned Employee', (l) => l.assignedTo?.name || 'Unassigned'],
  ['Lead Status', (l) => l.leadStatus || 'NEW'],
  ['Source', (l) => l.source],
  ['Scraped At', (l) => l.scrapedAt],
];

// @route GET /api/scraper/export
export const exportLeads = async (req, res, next) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    const leads = await dbStore.getLeads(leadFilters(req.query));
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="scraped_leads_${stamp}.json"`);
      return res.send(JSON.stringify(leads, null, 2));
    }

    const rows = [
      CSV_COLUMNS.map(([header]) => csvCell(header)).join(','),
      ...leads.map((lead) => CSV_COLUMNS.map(([, read]) => csvCell(read(lead))).join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scraped_leads_${stamp}.csv"`);
    /* The BOM is what makes Excel read the file as UTF-8 rather than the
       system codepage, which otherwise mangles every non-ASCII name. */
    return res.send(`﻿${rows.join('\r\n')}`);
  } catch (error) {
    return next(error);
  }
};

export default {
  startScrape,
  getStatus,
  stopScrape,
  getLeads,
  assignLeads,
  updateLeadStatus,
  getTeamStats,
  getJobs,
  getStats,
  exportLeads,
};
