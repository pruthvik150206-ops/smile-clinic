const router  = require('express').Router();
const db      = require('../config/database');
const { protect } = require('../middleware/auth');
const { success } = require('../utils/response');

router.get('/dashboard', protect, async (req, res) => {
  try {
    const [pts, dcs, aps, rev] = await Promise.all([
      db.query('SELECT COUNT(*) FROM patients'),
      db.query('SELECT COUNT(*) FROM doctors'),
      db.query('SELECT COUNT(*) FROM appointments'),
      db.query(`SELECT
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN total_amount ELSE 0 END), 0) AS pending_bills
        FROM invoices`),
    ]);

    const total_patients     = parseInt(pts.rows[0]?.count || 0);
    const total_doctors      = parseInt(dcs.rows[0]?.count || 0);
    const total_appointments = parseInt(aps.rows[0]?.count || 0);
    const total_revenue      = parseFloat(rev.rows[0]?.total_revenue || 0);
    const pending_bills      = parseFloat(rev.rows[0]?.pending_bills || 0);

    return success(res, {
      total_patients,
      total_doctors,
      total_appointments,
      total_revenue,
      pending_bills
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

module.exports = router;
