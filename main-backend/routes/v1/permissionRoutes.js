const express = require('express');
const router = express.Router();
const store = require('../../services/permissionStore');
const { ACTIONS, STATUSES } = require('../../models/PermissionRequest');

// How long an approval stays spendable before the employee has to ask again.
const GRANT_WINDOW_HOURS = Number(process.env.PERMISSION_GRANT_TTL_HOURS || 24);

/** Shape a stored request for the clients, hiding nothing they are allowed to see. */
const present = (doc) => {
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    ...raw,
    _id: String(raw._id),
    active: store.isActiveGrant(raw),
  };
};

/**
 * @route   GET /api/permissions
 * @desc    Every edit/delete permission request, newest first. The admin console
 *          reads this; the audit trail is the point of the collection.
 * @access  Admin
 */
router.get('/', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  try {
    const { status, action, employeeEmail, propertyId, search } = req.query;

    let items = await store.listRequests({
      status,
      action,
      employeeEmail,
      propertyRef: propertyId,
    });

    if (search) {
      const q = String(search).toLowerCase();
      items = items.filter((doc) =>
        [doc.employeeEmail, doc.reason, doc.propertySnapshot?.name, doc.propertySnapshot?.place]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q))
      );
    }

    const data = items.map(present);
    console.log(`\n🔑 [${timestamp}] [GET /permissions] Returning ${data.length} permission request(s)`);

    return res.json({
      success: true,
      count: data.length,
      data,
      items: data, // Dual format for frontend compatibility
    });
  } catch (error) {
    console.error('❌ [GET /api/permissions Error]:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error fetching permission requests.',
    });
  }
});

/**
 * @route   GET /api/permissions/access
 * @desc    What one employee may currently do with one listing. The onboarding
 *          app calls this to decide whether Edit / Delete are live or locked.
 * @access  Employee
 */
router.get('/access', async (req, res) => {
  try {
    const propertyId = String(req.query.propertyId || '').trim();
    const employeeEmail = store.normalizeEmail(req.query.employeeEmail || req.headers['x-employee-email']);

    if (!propertyId || !employeeEmail) {
      return res.status(400).json({
        success: false,
        message: 'Both propertyId and employeeEmail are required to resolve access.',
      });
    }

    const permissions = {};
    for (const action of ACTIONS) {
      const history = await store.listRequests({ propertyRef: propertyId, employeeEmail, action });
      const latest = history[0] || null;
      const grant = history.find(store.isActiveGrant) || null;

      permissions[action] = {
        allowed: !!grant,
        status: latest ? latest.status : 'none',
        requestId: latest ? String(latest._id) : null,
        grantId: grant ? String(grant._id) : null,
        reason: latest ? latest.reason || '' : '',
        decidedBy: latest ? latest.decidedBy || '' : '',
        decidedAt: latest ? latest.decidedAt || null : null,
        expiresAt: grant ? grant.expiresAt || null : null,
        requestedAt: latest ? latest.createdAt || null : null,
      };
    }

    return res.json({
      success: true,
      data: { propertyId, employeeEmail, permissions },
    });
  } catch (error) {
    console.error('❌ [GET /api/permissions/access Error]:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error resolving permission access.',
    });
  }
});

/**
 * @route   POST /api/permissions
 * @desc    An employee asks an administrator for edit or delete rights on a
 *          listing. Nothing is granted here — the record starts as pending.
 * @access  Employee
 */
router.post('/', async (req, res) => {
  const timestamp = new Date().toLocaleTimeString();
  try {
    const { propertyId, action, reason, property } = req.body;
    const employeeEmail = store.normalizeEmail(req.body.employeeEmail || req.headers['x-employee-email']);

    if (!propertyId || !employeeEmail || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing mandatory fields: propertyId, employeeEmail and action are required.',
      });
    }

    if (!ACTIONS.includes(action)) {
      return res.status(400).json({
        success: false,
        error: `Invalid action. Must be one of: ${ACTIONS.join(', ')}`,
      });
    }

    // Asking twice while a decision is outstanding must not spawn a second
    // record — the admin should see one row per real ask.
    const open = await store.findOpenRequest(String(propertyId), employeeEmail, action);
    if (open) {
      console.log(`   ℹ️ [Permission Duplicate] "${employeeEmail}" already has an open ${action} request.`);
      return res.status(200).json({
        success: true,
        duplicate: true,
        message:
          open.status === 'pending'
            ? 'A request for this listing is already awaiting administrator approval.'
            : 'You already hold an approved permission for this listing.',
        data: present(open),
      });
    }

    const created = await store.createRequest({
      propertyRef: String(propertyId),
      property: propertyId,
      propertySnapshot: {
        name: property?.name || '',
        place: property?.place || '',
        category: property?.category || '',
        ownerName: property?.ownerName || '',
        ownerMobile: property?.ownerMobile || '',
      },
      employeeEmail,
      action,
      reason: (reason || '').trim(),
      requestedIp: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
    });

    console.log(`\n========================================================================`);
    console.log(`🔐 [PERMISSION REQUESTED] ${timestamp}`);
    console.log(`👨‍💼 Employee:   "${employeeEmail}"`);
    console.log(`🎯 Action:     ${action.toUpperCase()}`);
    console.log(`🏠 Property:   "${property?.name || propertyId}" (${propertyId})`);
    console.log(`📝 Reason:     ${reason || 'Not stated'}`);
    console.log(`========================================================================\n`);

    return res.status(201).json({
      success: true,
      message: 'Permission request submitted. An administrator must approve it before you can proceed.',
      data: present(created),
    });
  } catch (error) {
    console.error('❌ [POST /api/permissions Error]:', error.message);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({ success: false, error: messages.join(', ') });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Error creating permission request.',
    });
  }
});

/**
 * @route   PUT /api/permissions/:id
 * @desc    An administrator's decision — grant, deny, revoke, or return to
 *          pending. Granting opens a time-boxed window; everything else closes it.
 * @access  Admin
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { status, decidedBy, expiresInHours } = req.body;

    if (!status || !STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${STATUSES.join(', ')}`,
      });
    }

    const existing = await store.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Permission request not found.' });
    }

    const hours = Number(expiresInHours) > 0 ? Number(expiresInHours) : GRANT_WINDOW_HOURS;
    const changes = {
      status,
      decidedBy: (decidedBy || '').trim(),
      decidedAt: new Date(),
    };

    if (status === 'granted') {
      changes.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      changes.usedAt = null;
    } else if (status === 'pending') {
      changes.decidedBy = '';
      changes.decidedAt = null;
      changes.expiresAt = null;
      changes.usedAt = null;
    } else {
      changes.expiresAt = null;
    }

    const updated = await store.updateRequest(id, changes);

    console.log(
      `✏️ [Permission ${status.toUpperCase()}] ID: ${id} | ${existing.action} on "${existing.propertySnapshot?.name || existing.propertyRef}" | Employee: ${existing.employeeEmail} | By: ${changes.decidedBy || 'admin'}`
    );

    return res.json({
      success: true,
      message: `Permission request marked ${status}.`,
      data: present(updated),
    });
  } catch (error) {
    console.error(`❌ [PUT /api/permissions/${id} Error]:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error updating permission request.',
    });
  }
});

/**
 * @route   POST /api/permissions/:id/consume
 * @desc    Close a grant once the employee has actually used it, so one
 *          approval buys exactly one edit or delete.
 * @access  Employee
 */
router.post('/:id/consume', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await store.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Permission request not found.' });
    }

    if (!store.isActiveGrant(existing)) {
      return res.status(409).json({
        success: false,
        message: 'That permission is no longer active and cannot be used.',
      });
    }

    const updated = await store.markUsed(id);
    console.log(`🔒 [Permission Spent] ID: ${id} | ${existing.action} by ${existing.employeeEmail}`);

    return res.json({ success: true, message: 'Permission closed after use.', data: present(updated) });
  } catch (error) {
    console.error(`❌ [POST /api/permissions/${id}/consume Error]:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error closing permission request.',
    });
  }
});

/**
 * @route   DELETE /api/permissions/:id
 * @desc    Remove a permission record from the audit trail.
 * @access  Admin
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await store.deleteRequest(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Permission request not found.' });
    }

    console.log(`🗑️ [Permission Deleted] ID: ${id} | Employee: ${deleted.employeeEmail}`);
    return res.json({ success: true, message: 'Permission request deleted.', data: present(deleted) });
  } catch (error) {
    console.error(`❌ [DELETE /api/permissions/${id} Error]:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error deleting permission request.',
    });
  }
});

module.exports = router;
