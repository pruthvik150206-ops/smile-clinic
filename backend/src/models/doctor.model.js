const db = require('../config/database');

const DoctorModel = {
  async findAll({ search = '', specialisation = '', limit = 20, offset = 0 }) {
    const params = [`%${search}%`, limit, offset];
    let where = `(d.first_name ILIKE $1 OR d.last_name ILIKE $1 OR d.specialisation ILIKE $1)`;
    if (specialisation) {
      where += ` AND d.specialisation ILIKE $4`;
      params.push(`%${specialisation}%`);
    }
    const { rows } = await db.query(
      `SELECT d.*, u.email
       FROM doctors d JOIN users u ON u.user_id = d.user_id
       WHERE ${where}
       ORDER BY d.last_name LIMIT $2 OFFSET $3`,
      params
    );
    return rows;
  },

  async count({ search = '', specialisation = '' }) {
    const params = [`%${search}%`];
    let where = `(first_name ILIKE $1 OR last_name ILIKE $1 OR specialisation ILIKE $1)`;
    if (specialisation) {
      where += ` AND specialisation ILIKE $2`;
      params.push(`%${specialisation}%`);
    }
    const { rows } = await db.query(`SELECT COUNT(*) AS total FROM doctors WHERE ${where}`, params);
    return parseInt(rows[0].total);
  },

  async findById(doctorId) {
    const { rows } = await db.query(
      `SELECT d.*, u.email,
              json_agg(
                json_build_object('day',da.day_of_week,'start',da.slot_start,'end',da.slot_end)
                ORDER BY da.day_of_week
              ) FILTER (WHERE da.availability_id IS NOT NULL) AS availability
       FROM doctors d
       JOIN users u ON u.user_id = d.user_id
       LEFT JOIN doctor_availability da ON da.doctor_id = d.doctor_id
       WHERE d.doctor_id = $1
       GROUP BY d.doctor_id, u.email`,
      [doctorId]
    );
    return rows[0] || null;
  },

  async findByUserId(userId) {
    const { rows } = await db.query('SELECT * FROM doctors WHERE user_id = $1', [userId]);
    return rows[0] || null;
  },

  async create(data, client = db) {
    const { user_id, first_name, last_name, specialisation, license_number, phone, consultation_fee = 0, bio = null } = data;
    const { rows } = await client.query(
      `INSERT INTO doctors (user_id, first_name, last_name, specialisation, license_number, phone, consultation_fee, bio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user_id, first_name, last_name, specialisation, license_number, phone, consultation_fee, bio]
    );
    return rows[0];
  },

  async update(doctorId, data) {
    const fields = ['first_name','last_name','specialisation','phone','consultation_fee','bio','is_available'];
    const updates = [], values = [];
    let idx = 1;
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = $${idx++}`); values.push(data[f]); }
    }
    if (!updates.length) return null;
    values.push(doctorId);
    const { rows } = await db.query(
      `UPDATE doctors SET ${updates.join(', ')}, updated_at = NOW() WHERE doctor_id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async setAvailability(doctorId, slots) {
    return db.withTransaction ? require('../config/database').withTransaction(async (client) => {
      await client.query('DELETE FROM doctor_availability WHERE doctor_id = $1', [doctorId]);
      for (const slot of slots) {
        await client.query(
          `INSERT INTO doctor_availability (doctor_id, day_of_week, slot_start, slot_end, max_appointments)
           VALUES ($1,$2,$3,$4,$5)`,
          [doctorId, slot.day_of_week, slot.slot_start, slot.slot_end, slot.max_appointments || 10]
        );
      }
    }) : null;
  },
};

module.exports = DoctorModel;
