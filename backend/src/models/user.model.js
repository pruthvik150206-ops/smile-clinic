const db = require('../config/database');

const UserModel = {
  async findByEmail(email) {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
      [email]
    );
    return rows[0] || null;
  },

  async findByEmailOrUsername(identifier) {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE (email = $1 OR username = $1) AND is_active = TRUE',
      [identifier]
    );
    return rows[0] || null;
  },

  async findById(userId) {
    const { rows } = await db.query(
      'SELECT user_id, username, email, role, is_active, created_at FROM users WHERE user_id = $1',
      [userId]
    );
    return rows[0] || null;
  },

  async create({ username, email, passwordHash, role = 'patient' }) {
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, username, email, role, created_at`,
      [username, email, passwordHash, role]
    );
    return rows[0];
  },

  async updateLastLogin(userId) {
    await db.query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [userId]);
  },

  async existsByEmail(email) {
    const { rows } = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    return rows.length > 0;
  },

  async existsByUsername(username) {
    const { rows } = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
    return rows.length > 0;
  },

  async saveOtp({ userId, otpCode, purpose, expiresMinutes = 10 }) {
    await db.query(
      `UPDATE users 
       SET otp_code = $1, 
           otp_expires_at = NOW() + ($2 * INTERVAL '1 minute'), 
           otp_purpose = $3 
       WHERE user_id = $4`,
      [otpCode, parseInt(expiresMinutes) || 10, purpose, userId]
    );
  },

  async verifyOtp({ email, otpCode, purpose }) {
    const { rows } = await db.query(
      `SELECT * FROM users 
       WHERE email = $1 
         AND otp_code = $2 
         AND (otp_purpose = $3 OR $3 IS NULL)
         AND (otp_expires_at IS NULL OR otp_expires_at > NOW())`,
      [email, otpCode, purpose]
    );
    return rows[0] || null;
  },

  async clearOtp(userId) {
    await db.query(
      `UPDATE users SET otp_code = NULL, otp_expires_at = NULL, otp_purpose = NULL WHERE user_id = $1`,
      [userId]
    );
  },

  async updatePassword(userId, passwordHash) {
    await db.query(
      `UPDATE users SET password_hash = $1, otp_code = NULL, otp_expires_at = NULL, otp_purpose = NULL WHERE user_id = $2`,
      [passwordHash, userId]
    );
  },

  async toggle2FA(userId, enabled) {
    const { rows } = await db.query(
      `UPDATE users SET is_2fa_enabled = $1 WHERE user_id = $2 RETURNING user_id, is_2fa_enabled`,
      [enabled, userId]
    );
    return rows[0];
  }
};

module.exports = UserModel;
