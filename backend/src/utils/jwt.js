const jwt = require('jsonwebtoken');

const ACCESS_SECRET  = process.env.JWT_SECRET          || 'dev_access_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET  || 'dev_refresh_secret';
const ACCESS_EXP     = process.env.JWT_EXPIRES_IN       || '15m';
const REFRESH_EXP    = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

/**
 * Sign a short-lived access token.
 * @param {{ userId, role }} payload
 */
const signAccess = (payload) =>
  jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXP });

/**
 * Sign a long-lived refresh token.
 * @param {{ userId }} payload
 */
const signRefresh = (payload) =>
  jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXP });

/**
 * Verify an access token — throws on failure.
 */
const verifyAccess = (token) => jwt.verify(token, ACCESS_SECRET);

/**
 * Verify a refresh token — throws on failure.
 */
const verifyRefresh = (token) => jwt.verify(token, REFRESH_SECRET);

/**
 * Extract raw token from "Bearer <token>" header.
 */
const extractBearer = (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.split(' ')[1];
};

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh, extractBearer };
