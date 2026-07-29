/**
 * Consistent JSON response envelope used across all controllers.
 *
 * Success:  { success: true,  data: <payload>,  meta?: <pagination> }
 * Error:    { success: false, error: { code, message, details? } }
 */

const success = (res, data = null, statusCode = 200, meta = null) => {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
};

const created = (res, data = null) => success(res, data, 201);

const noContent = (res) => res.status(204).send();

const error = (res, message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) => {
  const body = { success: false, error: { code, message } };
  if (details) body.error.details = details;
  return res.status(statusCode).json(body);
};

const notFound = (res, resource = 'Resource') =>
  error(res, `${resource} not found`, 404, 'NOT_FOUND');

const badRequest = (res, message, details = null) =>
  error(res, message, 400, 'BAD_REQUEST', details);

const unauthorized = (res, message = 'Authentication required') =>
  error(res, message, 401, 'UNAUTHORIZED');

const forbidden = (res, message = 'Insufficient permissions') =>
  error(res, message, 403, 'FORBIDDEN');

const conflict = (res, message) =>
  error(res, message, 409, 'CONFLICT');

const paginate = (items, total, page, limit) => ({
  items,
  pagination: {
    total,
    page:       parseInt(page),
    limit:      parseInt(limit),
    totalPages: Math.ceil(total / limit),
    hasNext:    page * limit < total,
    hasPrev:    page > 1,
  },
});

module.exports = { success, created, noContent, error, notFound, badRequest, unauthorized, forbidden, conflict, paginate };
