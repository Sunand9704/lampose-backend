const mongoose = require('mongoose');
const PermissionRequest = require('../models/PermissionRequest');
const { getIsInMemory } = require('../config/db');

/**
 * Storage layer for permission requests.
 *
 * Both the permissions API and the property write-guard read through here so
 * the two can never disagree about what an employee is allowed to do. When the
 * database is unreachable the same operations run against a process-local
 * array, matching the failover the rest of the backend already uses — an
 * outage must not silently hand out unrestricted delete rights.
 */

const memoryStore = () => {
  global.inMemoryPermissionRequests = global.inMemoryPermissionRequests || [];
  return global.inMemoryPermissionRequests;
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/** True while a grant is still spendable — approved, unused and unexpired. */
const isActiveGrant = (doc) => {
  if (!doc || doc.status !== 'granted') return false;
  if (!doc.expiresAt) return true;
  return new Date(doc.expiresAt).getTime() > Date.now();
};

/** A request the employee is still waiting on, or a grant they can still spend. */
const isOpen = (doc) => doc.status === 'pending' || isActiveGrant(doc);

const matches = (doc, filter) => {
  if (filter.status && filter.status !== 'All' && doc.status !== filter.status) return false;
  if (filter.action && filter.action !== 'All' && doc.action !== filter.action) return false;
  if (filter.propertyRef && doc.propertyRef !== filter.propertyRef) return false;
  if (filter.employeeEmail && normalizeEmail(doc.employeeEmail) !== normalizeEmail(filter.employeeEmail)) {
    return false;
  }
  return true;
};

const buildQuery = (filter = {}) => {
  const query = {};
  if (filter.status && filter.status !== 'All') query.status = filter.status;
  if (filter.action && filter.action !== 'All') query.action = filter.action;
  if (filter.propertyRef) query.propertyRef = filter.propertyRef;
  if (filter.employeeEmail) query.employeeEmail = normalizeEmail(filter.employeeEmail);
  return query;
};

const byNewest = (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

const listRequests = async (filter = {}) => {
  if (getIsInMemory()) {
    return memoryStore()
      .filter((doc) => matches(doc, filter))
      .sort(byNewest);
  }
  return PermissionRequest.find(buildQuery(filter)).sort({ createdAt: -1 });
};

const createRequest = async (payload) => {
  const record = {
    ...payload,
    employeeEmail: normalizeEmail(payload.employeeEmail),
    status: 'pending',
    decidedBy: '',
    decidedAt: null,
    usedAt: null,
    expiresAt: null,
  };

  if (getIsInMemory()) {
    const doc = {
      _id: 'perm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      ...record,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    memoryStore().push(doc);
    return doc;
  }

  // Only a real ObjectId is stored as a ref; unverified listings keep the
  // string reference alone.
  if (!mongoose.Types.ObjectId.isValid(record.propertyRef)) {
    delete record.property;
  }

  return PermissionRequest.create(record);
};

const findById = async (id) => {
  if (getIsInMemory()) {
    return memoryStore().find((doc) => doc._id === id) || null;
  }
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return PermissionRequest.findById(id);
};

const updateRequest = async (id, changes) => {
  if (getIsInMemory()) {
    const doc = memoryStore().find((item) => item._id === id);
    if (!doc) return null;
    Object.assign(doc, changes, { updatedAt: new Date().toISOString() });
    return doc;
  }
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return PermissionRequest.findByIdAndUpdate(id, changes, { new: true, runValidators: true });
};

const deleteRequest = async (id) => {
  if (getIsInMemory()) {
    const index = memoryStore().findIndex((doc) => doc._id === id);
    if (index === -1) return null;
    return memoryStore().splice(index, 1)[0];
  }
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return PermissionRequest.findByIdAndDelete(id);
};

/** The employee's still-open request for this listing and action, if any. */
const findOpenRequest = async (propertyRef, employeeEmail, action) => {
  const list = await listRequests({ propertyRef, employeeEmail, action });
  return list.find(isOpen) || null;
};

/** The grant an employee can spend right now on this listing and action. */
const findActiveGrant = async (propertyRef, employeeEmail, action) => {
  const list = await listRequests({ propertyRef, employeeEmail, action, status: 'granted' });
  return list.find(isActiveGrant) || null;
};

/** Close a grant the moment it is spent, so one approval buys one action. */
const markUsed = async (id) => updateRequest(id, { status: 'used', usedAt: new Date() });

module.exports = {
  normalizeEmail,
  isActiveGrant,
  isOpen,
  listRequests,
  createRequest,
  findById,
  updateRequest,
  deleteRequest,
  findOpenRequest,
  findActiveGrant,
  markUsed,
};
