const { verifyAccess, extractBearer } = require('../utils/jwt');
const { unauthorized, forbidden }     = require('../utils/response');
const logger                          = require('../utils/logger');

/**
 * Protect middleware — validates JWT and attaches req.user.
 */
const protect = (req, res, next) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return unauthorized(res, 'No token provided');

  try {
    req.user = verifyAccess(token);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    logger.warn(`Auth failure: ${msg} — ${req.ip}`);
    return unauthorized(res, msg);
  }
};

/**
 * Restrict access to one or more roles.
 * Must be used AFTER protect().
 * @param {...string} roles
 */
const restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return forbidden(res, `Role '${req.user.role}' is not permitted to perform this action`);
  }
  next();
};

/**
 * Allow a patient to access only their own records,
 * while admin/doctor/receptionist can access any.
 * Requires :patientId param or body.patient_id.
 */
const ownOrPrivileged = (req, res, next) => {
  const { role, userId } = req.user;
  if (['admin', 'doctor', 'receptionist'].includes(role)) return next();

  // Patient: must match their own resource
  // Controller should call this after loading the resource
  req._enforceOwnership = true;
  next();
};

module.exports = { protect, restrictTo, ownOrPrivileged };
