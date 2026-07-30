const bcrypt   = require('bcryptjs');
const UserModel = require('../models/user.model');
const PatientModel = require('../models/patient.model');
const { sendOTPEmail } = require('../services/emailService');
const { signAccess, signRefresh, verifyRefresh } = require('../utils/jwt');
const { success, created, badRequest, unauthorized, conflict, notFound } = require('../utils/response');
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
    return created(res, {
      token: accessToken,
      refreshToken,
      user: {
        userId: user.user_id,
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        created_at: user.created_at
      }
    });
  },

  async login(req, res) {
    const { email, username, password } = req.body;
    const identifier = (email || username || '').trim();

    if (!identifier) return badRequest(res, 'Email or username is required');

    const user = await UserModel.findByEmailOrUsername(identifier);
    if (!user) return unauthorized(res, 'Invalid email/username or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return unauthorized(res, 'Invalid email/username or password');

    await UserModel.updateLastLogin(user.user_id);

    const accessToken  = signAccess({ userId: user.user_id, role: user.role, email: user.email });
    const refreshToken = signRefresh({ userId: user.user_id });

    logger.info('User logged in', { userId: user.user_id, role: user.role });

    if (user.is_2fa_enabled) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await UserModel.saveOtp({ userId: user.user_id, otpCode: otp, purpose: '2fa_login' });
      await sendOTPEmail(user.email, otp, '2fa_login');
      logger.info('2FA OTP generated for user', { userId: user.user_id });
      return success(res, {
        requires2FA: true,
        email: user.email,
        message: '2FA verification code sent to your email',
        demoOtp: otp
      });
    }

    return success(res, {
      token: accessToken,
      refreshToken,
      user: {
        userId: user.user_id,
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        is_2fa_enabled: !!user.is_2fa_enabled
      }
    });
  },

  async verify2FA(req, res) {
    const { email, otp } = req.body;
    if (!email || !otp) return badRequest(res, 'Email and OTP code are required');

    const user = await UserModel.verifyOtp({ email: email.trim(), otpCode: otp.trim(), purpose: '2fa_login' });
    if (!user) return badRequest(res, 'Invalid or expired 2FA OTP code');

    await UserModel.clearOtp(user.user_id);
    await UserModel.updateLastLogin(user.user_id);

    const accessToken  = signAccess({ userId: user.user_id, role: user.role, email: user.email });
    const refreshToken = signRefresh({ userId: user.user_id });

    return success(res, {
      token: accessToken,
      refreshToken,
      user: {
        userId: user.user_id,
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        is_2fa_enabled: true
      }
    });
  },

  async forgotPassword(req, res) {
    const { email } = req.body;
    if (!email) return badRequest(res, 'Email is required');

    const user = await UserModel.findByEmail(email.trim());
    if (!user) return notFound(res, 'No account found with that email address');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await UserModel.saveOtp({ userId: user.user_id, otpCode: otp, purpose: 'forgot_password' });
    await sendOTPEmail(user.email, otp, 'forgot_password');

    logger.info('Forgot Password OTP generated', { userId: user.user_id });
    return success(res, {
      message: 'OTP verification code sent to your email',
      email: user.email,
      demoOtp: otp
    });
  },

  async verifyOtp(req, res) {
    const { email, otp, purpose = 'forgot_password' } = req.body;
    if (!email || !otp) return badRequest(res, 'Email and OTP code are required');

    const user = await UserModel.verifyOtp({ email: email.trim(), otpCode: otp.trim(), purpose });
    if (!user) return badRequest(res, 'Invalid or expired OTP code');

    return success(res, { message: 'OTP verified successfully' });
  },

  async resetPassword(req, res) {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword)
      return badRequest(res, 'Email, OTP, and new password are required');

    if (newPassword.length < 6)
      return badRequest(res, 'Password must be at least 6 characters');

    const user = await UserModel.verifyOtp({ email: email.trim(), otpCode: otp.trim(), purpose: 'forgot_password' });
    if (!user) return badRequest(res, 'Invalid or expired OTP code');

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await UserModel.updatePassword(user.user_id, passwordHash);

    logger.info('Password reset completed', { userId: user.user_id });
    return success(res, { message: 'Password reset successfully. You can now sign in with your new password.' });
  },

  async toggle2FA(req, res) {
    const { enabled } = req.body;
    const user = await UserModel.toggle2FA(req.user.userId, !!enabled);
    return success(res, {
      is_2fa_enabled: !!user.is_2fa_enabled,
      message: user.is_2fa_enabled ? '2FA enabled successfully' : '2FA disabled'
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
    return success(res, { ...user, userId: user.user_id, user_id: user.user_id, is_2fa_enabled: !!user.is_2fa_enabled });
  },

  async logout(req, res) {
    return success(res, { message: 'Logged out successfully' });
  },
};

module.exports = AuthController;
