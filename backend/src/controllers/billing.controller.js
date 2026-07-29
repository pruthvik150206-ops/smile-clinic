const db = require('../config/database');
const { success, created, notFound, badRequest } = require('../utils/response');
const logger = require('../utils/logger');

const BillingController = {

  async listInvoices(req, res) {
    const { patient_id, status, page = 1, limit = 20 } = req.query;
    const conditions = [], params = [];
    let idx = 1;
    if (patient_id) { conditions.push(`i.patient_id=$${idx++}`); params.push(patient_id); }
    if (status)     { conditions.push(`i.payment_status=$${idx++}`); params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(parseInt(limit), (page - 1) * parseInt(limit));

    const { rows } = await db.query(
      `SELECT i.*, p.first_name||' '||p.last_name AS patient_name
       FROM invoices i JOIN patients p ON p.patient_id=i.patient_id
       ${where} ORDER BY i.issued_at DESC LIMIT $${idx} OFFSET $${idx+1}`, params
    );
    return success(res, rows);
  },

  async getInvoice(req, res) {
    const { rows } = await db.query(
      `SELECT i.*, p.first_name||' '||p.last_name AS patient_name
       FROM invoices i JOIN patients p ON p.patient_id=i.patient_id WHERE i.invoice_id=$1`,
      [req.params.id]
    );
    if (!rows[0]) return notFound(res, 'Invoice');
    return success(res, rows[0]);
  },

  async createInvoice(req, res) {
    const { patient_id, appointment_id, subtotal, discount = 0, tax_rate = 0, payment_method, payment_status = 'pending' } = req.body;
    if (!patient_id || subtotal == null) return badRequest(res, 'patient_id and subtotal are required');
    const tax_amount   = (subtotal - discount) * tax_rate;
    const total_amount = subtotal - discount + tax_amount;
    const { rows } = await db.query(
      `INSERT INTO invoices (appointment_id,patient_id,subtotal,discount,tax_rate,tax_amount,total_amount,payment_status,payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [appointment_id || null, patient_id, subtotal, discount, tax_rate, tax_amount, total_amount, payment_status, payment_method || null]
    );
    logger.info('Invoice created', { invoice_id: rows[0].invoice_id, total_amount });
    return created(res, rows[0]);
  },

  async markPaid(req, res) {
    const { payment_method } = req.body;
    const { rows } = await db.query(
      `UPDATE invoices SET payment_status='paid', payment_method=$1, paid_at=NOW()
       WHERE invoice_id=$2 AND payment_status!='paid' RETURNING *`,
      [payment_method || 'cash', req.params.id]
    );
    if (!rows[0]) return notFound(res, 'Invoice (or already paid)');
    return success(res, rows[0]);
  },

  async voidInvoice(req, res) {
    const { rows } = await db.query(
      `UPDATE invoices SET payment_status='waived' WHERE invoice_id=$1 RETURNING *`, [req.params.id]
    );
    if (!rows[0]) return notFound(res, 'Invoice');
    return success(res, rows[0]);
  },

  async revenueReport(req, res) {
    const { rows } = await db.query(
      `SELECT DATE_TRUNC('month',issued_at) AS month,
              COUNT(*) AS total_invoices,
              SUM(total_amount) AS gross_revenue,
              SUM(CASE WHEN payment_status='paid' THEN total_amount ELSE 0 END) AS collected,
              SUM(CASE WHEN payment_status IN ('pending','overdue') THEN total_amount ELSE 0 END) AS outstanding
       FROM invoices GROUP BY 1 ORDER BY 1 DESC LIMIT 12`
    );
    return success(res, rows);
  },

  // Insurance claims
  async listClaims(req, res) {
    const { rows } = await db.query(
      `SELECT ic.*, i.total_amount AS invoice_total
       FROM insurance_claims ic JOIN invoices i ON i.invoice_id=ic.invoice_id
       ORDER BY ic.submitted_on DESC`
    );
    return success(res, rows);
  },

  async createClaim(req, res) {
    const { invoice_id, provider_name, policy_number, claim_amount } = req.body;
    if (!invoice_id || !provider_name || !claim_amount) return badRequest(res, 'invoice_id, provider_name and claim_amount required');
    const { rows } = await db.query(
      `INSERT INTO insurance_claims (invoice_id,provider_name,policy_number,claim_amount)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [invoice_id, provider_name, policy_number, claim_amount]
    );
    return created(res, rows[0]);
  },

  async updateClaim(req, res) {
    const { claim_status, approved_amount, rejection_reason } = req.body;
    const resolved_on = ['approved','rejected','paid'].includes(claim_status) ? 'NOW()' : 'NULL';
    const { rows } = await db.query(
      `UPDATE insurance_claims SET claim_status=$1, approved_amount=$2, rejection_reason=$3,
       resolved_on=${resolved_on === 'NOW()' ? 'NOW()' : 'NULL'} WHERE claim_id=$4 RETURNING *`,
      [claim_status, approved_amount, rejection_reason, req.params.id]
    );
    if (!rows[0]) return notFound(res, 'Claim');
    return success(res, rows[0]);
  },
};

module.exports = BillingController;
