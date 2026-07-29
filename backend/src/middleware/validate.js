const { validationResult } = require('express-validator');
const { badRequest }        = require('../utils/response');

/**
 * Run after express-validator chains.
 * Returns 400 with field-level error details if any rule fails.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const details = errors.array().map(({ path, msg, value }) => ({ field: path, message: msg, value }));
    return badRequest(res, 'Validation failed', details);
  }
  next();
};

module.exports = { validate };
