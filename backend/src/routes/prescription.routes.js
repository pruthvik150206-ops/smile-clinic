const router  = require('express').Router();
const db      = require('../config/database');
const { protect } = require('../middleware/auth');
const { success } = require('../utils/response');

router.get('/', protect, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        a.appointment_id AS prescription_id,
        a.appointment_id,
        a.patient_id,
        a.doctor_id,
        a.scheduled_at AS issued_at,
        a.reason AS diagnosis,
        p.first_name || ' ' || p.last_name AS patient_name,
        d.first_name || ' ' || d.last_name AS doctor_name,
        COALESCE(a.notes, 'Follow standard dental care instructions.') AS notes
      FROM appointments a
      JOIN patients p ON p.patient_id = a.patient_id
      JOIN doctors d ON d.doctor_id = a.doctor_id
      ORDER BY a.scheduled_at DESC
    `);
    return success(res, rows);
  } catch (err) {
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

module.exports = router;
