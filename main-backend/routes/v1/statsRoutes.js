const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Admin = require('../../models/Admin');
const Property = require('../../models/Property');
const VerificationRequest = require('../../models/VerificationRequest');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build an array of the last `days` calendar dates (UTC), oldest first. */
const buildDateWindow = (days) => {
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const window = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end - i * DAY_MS);
    window.push(d.toISOString().split('T')[0]);
  }
  return window;
};

/** Turn an aggregation of { _id, count } into a plain lookup map. */
const toCountMap = (rows) =>
  rows.reduce((acc, row) => {
    acc[row._id || 'Unspecified'] = row.count;
    return acc;
  }, {});

/**
 * @route   GET /api/admin/stats
 * @desc    Real aggregate metrics for the admin dashboard, computed from MongoDB.
 *          Every number here is derived from live collections — no synthetic values.
 * @access  Admin
 */
router.get('/stats', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 180);
    const windowStart = new Date(Date.now() - days * DAY_MS);
    const previousStart = new Date(Date.now() - 2 * days * DAY_MS);

    const [
      adminTotal,
      adminActive,
      adminsByRole,
      propertyTotal,
      propertyInWindow,
      propertyInPreviousWindow,
      propertiesByCategory,
      propertiesByStayType,
      topPlaces,
      rentStats,
      onboardingSeries,
      topOnboarders,
      verificationTotal,
      verificationsByStatus,
      verificationInWindow,
      verificationInPreviousWindow,
    ] = await Promise.all([
      Admin.countDocuments({}),
      Admin.countDocuments({ status: 'Active' }),
      Admin.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),

      Property.countDocuments({}),
      Property.countDocuments({ createdAt: { $gte: windowStart } }),
      Property.countDocuments({ createdAt: { $gte: previousStart, $lt: windowStart } }),
      Property.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Property.aggregate([
        { $group: { _id: '$stayType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Property.aggregate([
        { $group: { _id: '$place', count: { $sum: 1 }, avgRent: { $avg: '$rent' } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),
      Property.aggregate([
        {
          $group: {
            _id: null,
            avgRent: { $avg: '$rent' },
            minRent: { $min: '$rent' },
            maxRent: { $max: '$rent' },
            avgDeposit: { $avg: '$deposit' },
            totalRent: { $sum: '$rent' },
          },
        },
      ]),
      Property.aggregate([
        { $match: { createdAt: { $gte: windowStart } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
      ]),
      Property.aggregate([
        { $match: { employeeEmail: { $nin: ['', null] } } },
        { $group: { _id: '$employeeEmail', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),

      VerificationRequest.countDocuments({}),
      VerificationRequest.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      VerificationRequest.countDocuments({ createdAt: { $gte: windowStart } }),
      VerificationRequest.countDocuments({ createdAt: { $gte: previousStart, $lt: windowStart } }),
    ]);

    const statusMap = toCountMap(verificationsByStatus);
    const verified = statusMap.verified || 0;
    const failed = statusMap.failed || 0;
    const pending = (statusMap.pending || 0) + (statusMap.sent || 0) + (statusMap.delivered || 0);
    const expired = statusMap.expired || 0;

    // Success rate over requests that reached a terminal state.
    const terminal = verified + failed + expired;
    const verificationSuccessRate = terminal > 0 ? (verified / terminal) * 100 : null;

    const seriesMap = toCountMap(onboardingSeries);
    const trend = buildDateWindow(days).map((date) => ({
      date,
      count: seriesMap[date] || 0,
    }));

    const rent = rentStats[0] || {};

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      windowDays: days,
      admins: {
        total: adminTotal,
        active: adminActive,
        byRole: adminsByRole.map((r) => ({ label: r._id || 'Unspecified', count: r.count })),
      },
      properties: {
        total: propertyTotal,
        addedInWindow: propertyInWindow,
        addedInPreviousWindow: propertyInPreviousWindow,
        byCategory: propertiesByCategory.map((c) => ({ label: c._id || 'Unspecified', count: c.count })),
        byStayType: propertiesByStayType.map((s) => ({ label: s._id || 'Unspecified', count: s.count })),
        topPlaces: topPlaces.map((p) => ({
          label: p._id || 'Unspecified',
          count: p.count,
          avgRent: Math.round(p.avgRent || 0),
        })),
        topOnboarders: topOnboarders.map((e) => ({ label: e._id, count: e.count })),
        rent: {
          average: Math.round(rent.avgRent || 0),
          min: rent.minRent || 0,
          max: rent.maxRent || 0,
          averageDeposit: Math.round(rent.avgDeposit || 0),
          portfolioMonthly: rent.totalRent || 0,
        },
        trend,
      },
      verifications: {
        total: verificationTotal,
        verified,
        failed,
        pending,
        expired,
        successRate: verificationSuccessRate,
        createdInWindow: verificationInWindow,
        createdInPreviousWindow: verificationInPreviousWindow,
        byStatus: verificationsByStatus.map((s) => ({ label: s._id || 'unknown', count: s.count })),
      },
    });
  } catch (error) {
    console.error('❌ [GET /api/admin/stats Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error computing dashboard statistics.',
    });
  }
});

/**
 * @route   GET /api/admin/activity
 * @desc    Recent activity feed merged from the properties, verificationrequests
 *          and admins collections. Replaces the previous hardcoded notifications.
 * @access  Admin
 */
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);

    const [properties, verifications, admins] = await Promise.all([
      Property.find({}, 'name place category rent employeeEmail createdAt')
        .sort({ createdAt: -1 })
        .limit(limit),
      VerificationRequest.find({}, 'ownerMobileE164 status lastError attempts createdAt updatedAt')
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('property', 'name'),
      Admin.find({}, 'name email role status createdAt').sort({ createdAt: -1 }).limit(limit),
    ]);

    const events = [];

    properties.forEach((p) => {
      events.push({
        id: `prop_${p._id}`,
        kind: 'property',
        severity: 'info',
        title: `Property onboarded — ${p.name}`,
        detail: `${p.category} in ${p.place}${p.rent ? ` · ₹${p.rent.toLocaleString('en-IN')}/mo` : ''}${
          p.employeeEmail ? ` · by ${p.employeeEmail}` : ''
        }`,
        timestamp: p.createdAt,
      });
    });

    verifications.forEach((v) => {
      const failedState = v.status === 'failed' || v.status === 'expired';
      events.push({
        id: `verif_${v._id}`,
        kind: 'verification',
        severity: failedState ? 'critical' : v.status === 'verified' ? 'good' : 'warning',
        title: `Owner verification ${v.status} — ${v.ownerMobileE164}`,
        detail:
          v.lastError ||
          `${v.property?.name ? `${v.property.name} · ` : ''}attempt ${v.attempts}`,
        timestamp: v.updatedAt || v.createdAt,
      });
    });

    admins.forEach((a) => {
      events.push({
        id: `admin_${a._id}`,
        kind: 'admin',
        severity: 'info',
        title: `Administrator account created — ${a.name}`,
        detail: `${a.role} · ${a.email}`,
        timestamp: a.createdAt,
      });
    });

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json({
      success: true,
      count: Math.min(events.length, limit),
      items: events.slice(0, limit),
    });
  } catch (error) {
    console.error('❌ [GET /api/admin/activity Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error building activity feed.',
    });
  }
});

/**
 * @route   GET /api/admin/system
 * @desc    Live runtime + database telemetry for the System page.
 * @access  Admin
 */
router.get('/system', async (req, res) => {
  try {
    const conn = mongoose.connection;
    const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

    let collections = [];
    let dbStats = null;

    if (conn.readyState === 1) {
      const list = await conn.db.listCollections().toArray();
      collections = await Promise.all(
        list.map(async (c) => ({
          name: c.name,
          documents: await conn.db.collection(c.name).countDocuments(),
        }))
      );
      collections.sort((a, b) => b.documents - a.documents);

      const raw = await conn.db.stats();
      dbStats = {
        storageSizeBytes: raw.storageSize || 0,
        dataSizeBytes: raw.dataSize || 0,
        indexSizeBytes: raw.indexSize || 0,
        objects: raw.objects || 0,
        indexes: raw.indexes || 0,
      };
    }

    const mem = process.memoryUsage();

    return res.json({
      success: true,
      database: {
        name: conn.name || 'n/a',
        host: conn.host || 'n/a',
        readyState: READY_STATES[conn.readyState] || 'unknown',
        connected: conn.readyState === 1,
        collections,
        stats: dbStats,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime()),
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        rssBytes: mem.rss,
        pid: process.pid,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ [GET /api/admin/system Error]:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error reading system telemetry.',
    });
  }
});

module.exports = router;
