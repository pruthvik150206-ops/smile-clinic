const db = require('../config/database');
const { success, created, notFound, badRequest } = require('../utils/response');

const TreatmentController = {
  async list(req, res) {
    const { category } = req.query;
    const where = category ? 'WHERE category=$1 AND is_active=TRUE' : 'WHERE is_active=TRUE';
    const params = category ? [category] : [];
    const { rows } = await db.query(`SELECT * FROM treatments ${where} ORDER BY category,treatment_name`, params);
    return success(res, rows);
  },
  async getOne(req, res) {
    const { rows } = await db.query('SELECT * FROM treatments WHERE treatment_id=$1', [req.params.id]);
    if (!rows[0]) return notFound(res, 'Treatment');
    return success(res, rows[0]);
  },
  async create(req, res) {
    const { treatment_name, category, base_cost, description, duration_mins = 30 } = req.body;
    if (!treatment_name || !category || base_cost == null) return badRequest(res, 'treatment_name, category and base_cost are required');
    const { rows } = await db.query(
      `INSERT INTO treatments (treatment_name,category,description,base_cost,duration_mins) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [treatment_name, category, description, base_cost, duration_mins]
    );
    return created(res, rows[0]);
  },
  async update(req, res) {
    const fields = ['treatment_name','category','description','base_cost','duration_mins','is_active'];
    const updates = [], values = [];
    let idx = 1;
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f}=$${idx++}`); values.push(req.body[f]); }
    }
    if (!updates.length) return badRequest(res, 'No fields to update');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE treatments SET ${updates.join(',')} WHERE treatment_id=$${idx} RETURNING *`, values);
    if (!rows[0]) return notFound(res, 'Treatment');
    return success(res, rows[0]);
  },
};

module.exports = TreatmentController;
