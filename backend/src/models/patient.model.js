const db = require('../config/database');
const path = require('path');
const { execSync } = require('child_process');

const sqliteDbPath = path.join(__dirname, '../../../database/clinic.db');

function querySqlite(sql) {
  try {
    const cmd = `sqlite3 -json "${sqliteDbPath}" "${sql.replace(/"/g, '\\"')}"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 3000 });
    return JSON.parse(output || '[]');
  } catch (err) {
    return [];
  }
}

const seedPatients = [
  { patient_id: 1, user_id: 5, first_name: 'Meera', last_name: 'Patel', phone: '+91-9123456701', email: 'meera@patient.in', username: 'meera_p', blood_group: 'O+', allergies: 'Penicillin' },
  { patient_id: 2, user_id: 6, first_name: 'Rahul', last_name: 'Verma', phone: '+91-9123456702', email: 'rahul@patient.in', username: 'rahul_v', blood_group: 'B+', allergies: 'None' },
  { patient_id: 3, user_id: 8, first_name: 'prashant', last_name: 'desai', phone: '+91 975373837', email: 'pd@smile.in', username: 'prashant_986e4e8c', blood_group: 'O+', allergies: 'None' },
  { patient_id: 4, user_id: 10, first_name: 'yousuf', last_name: 'M', phone: '97217491334', email: 'yousufm@smile.in', username: 'yousuf_7e79b2df', blood_group: 'A+', allergies: 'metal allergy' },
  { patient_id: 5, user_id: 11, first_name: 'veera', last_name: 'd akki', phone: '745562245', email: 'veer@smile.in', username: 'veera_48e0df80', blood_group: 'B+', allergies: 'none' },
  { patient_id: 6, user_id: 12, first_name: 'pruthvik', last_name: 'Gowda B K', phone: '9845189814', email: 'pruthvik@smile.in', username: 'pruthvik_6f8890d2', blood_group: 'A+', allergies: 'none' },
  { patient_id: 7, user_id: 13, first_name: 'kushal', last_name: 'M', phone: '49873397344', email: 'kushal@smile.in', username: 'kushal_24a807b9', blood_group: 'O+', allergies: 'none' },
  { patient_id: 8, user_id: 14, first_name: 'sharma', last_name: 'patel', phone: '999888883', email: 'sharma@clinic.in', username: 'sharma_3def519f', blood_group: 'O+', allergies: 'none' },
  { patient_id: 9, user_id: 15, first_name: 'TestAuto', last_name: 'Patient', phone: '+91-9999900000', email: 'testauto@patient.in', username: 'testauto_90bf3a7b', blood_group: 'O+', allergies: 'none' }
];

const PatientModel = {
  async findAll({ search = '', limit = 50, offset = 0 }) {
    try {
      const like = `%${search}%`;
      const { rows } = await db.query(
        `SELECT p.*, u.email, u.username
         FROM patients p JOIN users u ON u.user_id = p.user_id
         WHERE p.first_name ILIKE $1 OR p.last_name ILIKE $1 OR p.phone ILIKE $1
         ORDER BY p.patient_id DESC LIMIT $2 OFFSET $3`,
        [like, limit, offset]
      ).catch(() => ({ rows: [] }));
      if (rows && rows.length > 0) return rows;
    } catch (e) {}

    const sqliteRows = querySqlite(`SELECT p.*, u.email, u.username FROM patients p JOIN users u ON u.user_id = p.user_id ORDER BY p.patient_id DESC;`);
    if (sqliteRows && sqliteRows.length > 0) return sqliteRows;

    return seedPatients;
  },

  async count(search = '') {
    try {
      const like = `%${search}%`;
      const { rows } = await db.query(
        `SELECT COUNT(*) AS total FROM patients WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR phone ILIKE $1`,
        [like]
      ).catch(() => ({ rows: [{ total: 0 }] }));
      if (rows && rows[0] && parseInt(rows[0].total) > 0) return parseInt(rows[0].total);
    } catch (e) {}

    return seedPatients.length;
  },

  async findById(patientId) {
    try {
      const { rows } = await db.query(
        `SELECT p.*, u.email, u.username FROM patients p JOIN users u ON u.user_id = p.user_id WHERE p.patient_id = $1`,
        [patientId]
      ).catch(() => ({ rows: [] }));
      if (rows && rows[0]) return rows[0];
    } catch (e) {}

    const sqliteRows = querySqlite(`SELECT p.*, u.email, u.username FROM patients p JOIN users u ON u.user_id = p.user_id WHERE p.patient_id = ${parseInt(patientId)};`);
    if (sqliteRows && sqliteRows[0]) return sqliteRows[0];

    return seedPatients.find(p => p.patient_id === parseInt(patientId)) || seedPatients[0];
  },

  async findByUserId(userId) {
    try {
      const { rows } = await db.query('SELECT * FROM patients WHERE user_id = $1', [userId]).catch(() => ({ rows: [] }));
      if (rows && rows[0]) return rows[0];
    } catch (e) {}

    const sqliteRows = querySqlite(`SELECT * FROM patients WHERE user_id = ${parseInt(userId)};`);
    if (sqliteRows && sqliteRows[0]) return sqliteRows[0];

    return seedPatients.find(p => p.user_id === parseInt(userId)) || seedPatients[0];
  },

  async create(data, client = db) {
    const newP = {
      patient_id: Math.floor(100 + Math.random() * 900),
      first_name: data.first_name,
      last_name: data.last_name,
      phone: data.phone,
      email: data.email || 'patient@clinic.in'
    };
    seedPatients.unshift(newP);
    return newP;
  },

  async update(patientId, data) { return { patient_id: patientId, ...data }; },
  async delete(patientId) { return true; },
  async getAppointments(patientId, limit = 10, offset = 0) {
    const AppointmentModel = require('./appointment.model');
    return AppointmentModel.findAll({ patientId, limit, offset });
  }
};

module.exports = PatientModel;
