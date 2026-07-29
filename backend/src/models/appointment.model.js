const db = require('../config/database');

const AppointmentModel = {
  async findAll({ patientId, doctorId, status, dateFrom, dateTo, limit = 20, offset = 0 }) {
    const conditions = [];
    const params     = [];
    let idx = 1;
    if (patientId) { conditions.push(`a.patient_id = $${idx++}`); params.push(patientId); }
    if (doctorId)  { conditions.push(`a.doctor_id  = $${idx++}`); params.push(doctorId);  }
    if (status)    { conditions.push(`a.status     = $${idx++}`); params.push(status);    }
    if (dateFrom)  { conditions.push(`a.scheduled_at >= $${idx++}`); params.push(dateFrom); }
    if (dateTo)    { conditions.push(`a.scheduled_at <= $${idx++}`); params.push(dateTo);   }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT a.*,
              p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone,
              d.first_name || ' ' || d.last_name AS doctor_name,  d.specialisation
       FROM appointments a
       JOIN patients p ON p.patient_id = a.patient_id
       JOIN doctors  d ON d.doctor_id  = a.doctor_id
       ${where}
       ORDER BY a.scheduled_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );
    return rows;
  },

  async count({ patientId, doctorId, status, dateFrom, dateTo }) {
    const conditions = [];
    const params     = [];
    let idx = 1;
    if (patientId) { conditions.push(`patient_id = $${idx++}`); params.push(patientId); }
    if (doctorId)  { conditions.push(`doctor_id  = $${idx++}`); params.push(doctorId);  }
    if (status)    { conditions.push(`status     = $${idx++}`); params.push(status);    }
    if (dateFrom)  { conditions.push(`scheduled_at >= $${idx++}`); params.push(dateFrom); }
    if (dateTo)    { conditions.push(`scheduled_at <= $${idx++}`); params.push(dateTo);   }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT COUNT(*) AS total FROM appointments ${where}`, params);
    return parseInt(rows[0].total);
  },

  async findById(appointmentId) {
    const { rows } = await db.query(
      `SELECT a.*,
              p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone,
              d.first_name || ' ' || d.last_name AS doctor_name,  d.specialisation,
              COALESCE(
                json_agg(
                  json_build_object(
                    'treatment_id',   t.treatment_id,
                    'treatment_name', t.treatment_name,
                    'category',       t.category,
                    'quantity',       at2.quantity,
                    'unit_cost',      at2.unit_cost,
                    'notes',          at2.notes
                  )
                ) FILTER (WHERE t.treatment_id IS NOT NULL), '[]'
              ) AS treatments
       FROM appointments a
       JOIN patients p  ON p.patient_id   = a.patient_id
       JOIN doctors  d  ON d.doctor_id    = a.doctor_id
       LEFT JOIN appointment_treatments at2 ON at2.appointment_id = a.appointment_id
       LEFT JOIN treatments t              ON t.treatment_id       = at2.treatment_id
       WHERE a.appointment_id = $1
       GROUP BY a.appointment_id, p.first_name, p.last_name, p.phone, d.first_name, d.last_name, d.specialisation`,
      [appointmentId]
    );
    return rows[0] || null;
  },

  async create(data) {
    const { patient_id, doctor_id, scheduled_at, duration_mins = 30, reason = null, notes = null } = data;
    const { rows } = await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, duration_mins, reason, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [patient_id, doctor_id, scheduled_at, duration_mins, reason, notes]
    );
    return rows[0];
  },

  async update(appointmentId, data) {
    const fields = ['scheduled_at','duration_mins','status','reason','notes','no_show_probability','reminder_sent'];
    const updates = [], values = [];
    let idx = 1;
    for (const f of fields) {
      if (data[f] !== undefined) { updates.push(`${f} = $${idx++}`); values.push(data[f]); }
    }
    if (!updates.length) return null;
    values.push(appointmentId);
    const { rows } = await db.query(
      `UPDATE appointments SET ${updates.join(', ')}, updated_at = NOW()
       WHERE appointment_id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async cancel(appointmentId) {
    const { rows } = await db.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW()
       WHERE appointment_id = $1 AND status NOT IN ('completed','cancelled')
       RETURNING *`,
      [appointmentId]
    );
    return rows[0] || null;
  },

  /** Check for scheduling conflicts for a doctor */
  async hasConflict(doctorId, scheduledAt, durationMins, excludeId = null) {
    const params = [doctorId, scheduledAt, durationMins];
    const exclude = excludeId ? `AND appointment_id <> $4` : '';
    if (excludeId) params.push(excludeId);
    const { rows } = await db.query(
      `SELECT 1 FROM appointments
       WHERE doctor_id = $1
         AND status NOT IN ('cancelled','no_show')
         AND scheduled_at < ($2::TIMESTAMP + ($3 || ' minutes')::INTERVAL)
         AND ($2::TIMESTAMP)  < (scheduled_at + (duration_mins || ' minutes')::INTERVAL)
         ${exclude}`,
      params
    );
    return rows.length > 0;
  },

  async addTreatment(appointmentId, treatmentId, quantity, unitCost, notes = null) {
    const { rows } = await db.query(
      `INSERT INTO appointment_treatments (appointment_id, treatment_id, quantity, unit_cost, notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (appointment_id, treatment_id)
       DO UPDATE SET quantity = $3, unit_cost = $4, notes = $5
       RETURNING *`,
      [appointmentId, treatmentId, quantity, unitCost, notes]
    );
    return rows[0];
  },

  async removeTreatment(appointmentId, treatmentId) {
    const { rowCount } = await db.query(
      'DELETE FROM appointment_treatments WHERE appointment_id = $1 AND treatment_id = $2',
      [appointmentId, treatmentId]
    );
    return rowCount > 0;
  },

  async delete(appointmentId) {
    await db.query('DELETE FROM invoices WHERE appointment_id = $1', [appointmentId]);
    const { rowCount } = await db.query('DELETE FROM appointments WHERE appointment_id = $1', [appointmentId]);
    return rowCount > 0;
  },
};

module.exports = AppointmentModel;
