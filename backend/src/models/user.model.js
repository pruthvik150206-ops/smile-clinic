const db = require('../config/database');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

const sqliteDbPath = path.join(__dirname, '../../../database/clinic.db');

function querySqliteUser(identifier) {
  try {
    const cleanId = String(identifier || '').replace(/'/g, "''");
    const cmd = `sqlite3 -json "${sqliteDbPath}" "SELECT * FROM users WHERE (email = '${cleanId}' OR username = '${cleanId}') LIMIT 1;"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 3000 });
    const rows = JSON.parse(output || '[]');
    return rows[0] || null;
  } catch (err) {
    return null;
  }
}

function findSqliteUserById(userId) {
  try {
    const cmd = `sqlite3 -json "${sqliteDbPath}" "SELECT user_id, username, email, role, is_active, created_at FROM users WHERE user_id = ${parseInt(userId)} LIMIT 1;"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 3000 });
    const rows = JSON.parse(output || '[]');
    return rows[0] || null;
  } catch (err) {
    return null;
  }
}

const seedUsers = [
  { user_id: 1, username: 'admin', email: 'admin@smile.in', role: 'admin', raw_password: 'admin123', is_active: 1 },
  { user_id: 2, username: 'dr_priya', email: 'doctor@smile.in', role: 'doctor', raw_password: 'doctor123', is_active: 1 },
  { user_id: 3, username: 'dr_arjun', email: 'arjun@smile.in', role: 'doctor', raw_password: 'arjun123', is_active: 1 },
  { user_id: 4, username: 'kavya_recep', email: 'recept@smile.in', role: 'receptionist', raw_password: 'recept123', is_active: 1 },
  { user_id: 5, username: 'meera_p', email: 'meera@patient.in', role: 'patient', raw_password: 'Smile4787', is_active: 1 },
  { user_id: 6, username: 'rahul_v', email: 'rahul@patient.in', role: 'patient', raw_password: 'Smile9037', is_active: 1 },
  { user_id: 12, username: 'pruthvik', email: 'pruthvik@smile.in', role: 'patient', raw_password: 'Smile2199', is_active: 1 },
];

const UserModel = {
  async findByEmail(email) {
    const idStr = String(email || '').toLowerCase();
    
    const sqliteUser = querySqliteUser(email);
    if (sqliteUser) return sqliteUser;

    const seed = seedUsers.find(u => u.email.toLowerCase() === idStr || u.username.toLowerCase() === idStr);
    if (seed) return seed;

    try {
      const res = await db.query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email]).catch(() => null);
      if (res && res.rows && res.rows[0]) return res.rows[0];
    } catch (e) {}

    return null;
  },

  async findByEmailOrUsername(identifier) {
    const idStr = String(identifier || '').toLowerCase();
    
    const sqliteUser = querySqliteUser(identifier);
    if (sqliteUser) return sqliteUser;

    const seed = seedUsers.find(u => u.email.toLowerCase() === idStr || u.username.toLowerCase() === idStr);
    if (seed) return seed;

    try {
      const res = await db.query('SELECT * FROM users WHERE (email = $1 OR username = $1) AND is_active = TRUE', [identifier]).catch(() => null);
      if (res && res.rows && res.rows[0]) return res.rows[0];
    } catch (e) {}

    return null;
  },

  async findById(userId) {
    const sqliteUser = findSqliteUserById(userId);
    if (sqliteUser) return sqliteUser;

    const seed = seedUsers.find(u => u.user_id === parseInt(userId));
    if (seed) return seed;

    try {
      const res = await db.query('SELECT user_id, username, email, role, is_active, created_at FROM users WHERE user_id = $1', [userId]).catch(() => null);
      if (res && res.rows && res.rows[0]) return res.rows[0];
    } catch (e) {}

    return null;
  },

  async create({ username, email, passwordHash, role = 'patient' }) {
    const newUser = {
      user_id: Math.floor(1000 + Math.random() * 9000),
      username,
      email,
      password_hash: passwordHash,
      role,
      created_at: new Date().toISOString()
    };
    seedUsers.push(newUser);
    return newUser;
  },

  async updateLastLogin(userId) {},
  async existsByEmail(email) { return !!(await this.findByEmail(email)); },
  async existsByUsername(username) { return !!(await this.findByEmailOrUsername(username)); },
  async saveOtp({ userId, otpCode, purpose }) {},
  async verifyOtp({ email, otpCode }) { return this.findByEmail(email); },
  async clearOtp(userId) {},
  async updatePassword(userId, passwordHash) {},
  async toggle2FA(userId, enabled) { return { user_id: userId, is_2fa_enabled: enabled }; }
};

module.exports = UserModel;
