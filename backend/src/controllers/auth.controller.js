const bcrypt   = require('bcryptjs');
const UserModel = require('../models/user.model');
const PatientModel = require('../models/patient.model');
const { signAccess, signRefresh, verifyRefresh } = require('../utils/jwt');
const { success, created, badRequest, unauthorized, conflict } = require('../utils/response');
const logger = require('../utils/logger');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12');

const AuthController = {

  async register(req, res) {
    const { username, email, password, role = 'patient' } = req.body;

    if (await UserModel.existsByEmail(email))
      return conflict(res, 'An account with that email already exists');
    if (await UserModel.existsByUsername(username))
      return conflict(res, 'That username is already taken');

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await UserModel.create({ username, email, passwordHash, role });

    const accessToken  = signAccess({ userId: user.user_id, role: user.role, email: user.email });
    const refreshToken = signRefresh({ userId: user.user_id });

    logger.info('New user registered', { userId: user.user_id, role });
    return created(res, { token: accessToken, refreshToken, user });
  },

  async login(req, res) {
    const { email, password } = req.body;

    const user = await UserModel.findByEmail(email);
    if (!user) return unauthorized(res, 'Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return unauthorized(res, 'Invalid email or password');

    await UserModel.updateLastLogin(user.user_id);

    const accessToken  = signAccess({ userId: user.user_id, role: user.role, email: user.email });
    const refreshToken = signRefresh({ userId: user.user_id });

    logger.info('User logged in', { userId: user.user_id, role: user.role });
    return success(res, {
      token: accessToken,
      refreshToken,
      user: { userId: user.user_id, username: user.username, email: user.email, role: user.role }
    });
  },

  async refresh(req, res) {
    const { refreshToken } = req.body;
    if (!refreshToken) return badRequest(res, 'Refresh token required');

    const payload = verifyRefresh(refreshToken);
    if (!payload) return unauthorized(res, 'Invalid or expired refresh token');

    const user = await UserModel.findById(payload.userId);
    if (!user || !user.is_active) return unauthorized(res, 'User not found or inactive');

    const newAccess  = signAccess({ userId: user.user_id, role: user.role, email: user.email });
    const newRefresh = signRefresh({ userId: user.user_id });
    return success(res, { token: newAccess, refreshToken: newRefresh });
  },

  async me(req, res) {
    const user = await UserModel.findById(req.user.userId);
    if (!user) return unauthorized(res, 'User not found');
    return success(res, user);
  },

  async logout(req, res) {
    // Stateless JWT: client discards token. In production, add token to Redis blocklist.
    return success(res, { message: 'Logged out successfully' });
  },
};

module.exports = AuthController;
