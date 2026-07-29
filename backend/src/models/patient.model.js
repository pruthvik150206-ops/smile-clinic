const db = require('../config/database');

const PatientModel = {
  async findAll({ search = '', limit = 20, offset = 0 }) {
    const like = `%${search}%`;
    const { rows } = await db.query(
      `SELECT p.*, u.email
       FROM patients p
       JOIN users u ON u.user_id = p.user_id
       WHERE p.first_name ILIKE $1 OR p.last_name ILIKE $1 OR p.phone ILIKE $1
       ORDER BY p.last_name, p.first_name
       LIMIT $2 OFFSET $3`,
      [like, limit, offset]
    );
    return rows;
  },

  async count(search = '') {
    const like = `%${search}%`;
    const { rows } = await db.query(
      `SELECT COUNT(*) AS total
       FROM patients
       WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR phone ILIKE $1`,
      [like]
    );
    return parseInt(rows[0].total);
  },

  async findById(patientId) {
    const { rows } = await db.query(
      `SELECT p.*, u.email
       FROM patients p
       JOIN users u ON u.user_id = p.user_id
       WHERE p.patient_id = $1`,
      [patientId]
    );
    return rows[0] || null;
  },

  async findByUserId(userId) {
    const { rows } = await db.query(
      'SELECT * FROM patients WHERE user_id = $1',
      [userId]
    );
    return rows[0] || null;
  },

  async create(data, client = db) {
    const {
      user_id, first_name, last_name, date_of_birth, gender, phone,
      address = null, city = null, pincode = null, blood_group = null,
      allergies = null, medical_notes = null,
      emergency_contact_name = null, emergency_contact_phone = null,
    } = data;
    const { rows } = await client.query(
      `INSERT INTO patients
         (user_id, first_name, last_name, date_of_birth, gender, phone,
          address, city, pincode, blood_group, allergies, medical_notes,
          emergency_contact_name, emergency_contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [user_id, first_name, last_name, date_of_birth, gender, phone,
       address, city, pincode, blood_group, allergies, medical_notes,
       emergency_contact_name, emergency_contact_phone]
    );
    return rows[0];
  },

  async update(patientId, data) {
    const fields = [
      'first_name','last_name','date_of_birth','gender','phone',
      'address','city','pincode','blood_group','allergies','medical_notes',
      'emergency_contact_name','emergency_contact_phone',
    ];
    const updates = [];
    const values  = [];
    let idx = 1;
    for (const field of fields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        values.push(data[field]);
      }
    }
    if (!updates.length) return null;
    values.push(patientId);
    const { rows } = await db.query(
      `UPDATE patients SET ${updates.join(', ')}, updated_at = NOW()
       WHERE patient_id = $${idx}
       RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async delete(patientId) {
    const { rowCount } = await db.query(
      'DELETE FROM patients WHERE patient_id = $1',
      [patientId]
    );
    return rowCount > 0;
  },

  /** Patient's appointment history */
  async getAppointments(patientId, limit = 10, offset = 0) {
    const { rows } = await db.query(
      `SELECT a.*, d.first_name || ' ' || d.last_name AS doctor_name, d.specialisation
       FROM appointments a
       JOIN doctors d ON d.doctor_id = a.doctor_id
       WHERE a.patient_id = $1
       ORDER BY a.scheduled_at DESC
       LIMIT $2 OFFSET $3`,
      [patientId, limit, offset]
    );
    return rows;
  },
};

module.exports = PatientModel;
