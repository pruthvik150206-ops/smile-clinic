/**
 * controllers/ml.controller.js
 * ──────────────────────────────────────────────────────────
 * Proxies and enriches ML service calls with DB context.
 * The frontend calls these endpoints; they never call the
 * Python ML service directly (single entry point = backend).
 */

const { predictNoShow, predictBatch, explainPrediction, checkHealth, buildFeaturePayload } = require('../services/mlService');
const AppointmentModel = require('../models/appointment.model');
const PatientModel     = require('../models/patient.model');
const db               = require('../config/database');
const { success, notFound, badRequest, error: errResp } = require('../utils/response');
const logger           = require('../utils/logger');

const MLController = {

  /**
   * POST /api/ml/predict/:appointmentId
   * Fetch appointment from DB → build features → call ML → save score → return.
   */
  async predictForAppointment(req, res) {
    const { appointmentId } = req.params;
    const appt = await AppointmentModel.findById(appointmentId);
    if (!appt) return notFound(res, 'Appointment');

    const patient = await PatientModel.findById(appt.patient_id);
    if (!patient) return notFound(res, 'Patient');

    // fetch first treatment for this appointment (if any)
    const { rows: txRows } = await db.query(
      `SELECT t.category, t.base_cost FROM appointment_treatments at2
       JOIN treatments t ON t.treatment_id = at2.treatment_id
       WHERE at2.appointment_id = $1 LIMIT 1`, [appointmentId]
    );
    const treatment = txRows[0] || null;

    // Add prior_no_shows + total_appointments from DB
    const { rows: stats } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'no_show') AS prior_no_shows,
         COUNT(*) AS total_appointments
       FROM appointments WHERE patient_id = $1`, [patient.patient_id]
    );
    const enrichedPatient = { ...patient, ...stats[0] };

    const features = buildFeaturePayload({ appointment: appt, patient: enrichedPatient, treatment });
    const prediction = await predictNoShow(features);

    if (!prediction) {
      return errResp(res, 'ML service unavailable', 503, 'ML_UNAVAILABLE');
    }

    // Persist score to appointments table
    await AppointmentModel.update(appointmentId, {
      no_show_probability: prediction.no_show_probability,
    });

    // Store full prediction in ml_predictions
    await db.query(
      `INSERT INTO ml_predictions
         (appointment_id, model_name, model_version, prediction_score, prediction_label, feature_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (appointment_id) DO UPDATE
         SET prediction_score  = EXCLUDED.prediction_score,
             prediction_label  = EXCLUDED.prediction_label,
             feature_snapshot  = EXCLUDED.feature_snapshot,
             predicted_at      = NOW()`,
      [appointmentId, prediction.model_version.includes('xgb') ? 'no_show_xgboost' : 'no_show_lr',
       prediction.model_version, prediction.no_show_probability,
       prediction.label, JSON.stringify(features)]
    ).catch(()=>{});  // non-blocking — ml_predictions may not exist in dev

    logger.info('ML prediction stored', { appointmentId, probability: prediction.no_show_probability, risk: prediction.risk_level });
    return success(res, prediction);
  },

  /**
   * POST /api/ml/predict/batch
   * Body: { appointment_ids: [1,2,3] }
   * Returns predictions for all, saves scores.
   */
  async predictBatch(req, res) {
    const { appointment_ids } = req.body;
    if (!Array.isArray(appointment_ids) || !appointment_ids.length) {
      return badRequest(res, 'appointment_ids must be a non-empty array');
    }
    if (appointment_ids.length > 100) {
      return badRequest(res, 'Maximum 100 appointments per batch');
    }

    const results = [];
    for (const id of appointment_ids) {
      const appt    = await AppointmentModel.findById(id).catch(() => null);
      const patient = appt ? await PatientModel.findById(appt.patient_id).catch(() => null) : null;
      if (!appt || !patient) { results.push({ appointment_id: id, error: 'Not found' }); continue; }

      const features   = buildFeaturePayload({ appointment: appt, patient, treatment: null });
      const prediction = await predictNoShow(features);
      if (prediction) {
        await AppointmentModel.update(id, { no_show_probability: prediction.no_show_probability }).catch(() => {});
        results.push({ appointment_id: id, ...prediction });
      } else {
        results.push({ appointment_id: id, error: 'ML unavailable' });
      }
    }

    return success(res, { total: appointment_ids.length, results });
  },

  /**
   * POST /api/ml/predict/manual
   * Body: raw feature object — for testing or the frontend "try it" form.
   */
  async predictManual(req, res) {
    const prediction = await predictNoShow(req.body);
    if (!prediction) return errResp(res, 'ML service unavailable', 503, 'ML_UNAVAILABLE');
    return success(res, prediction);
  },

  /**
   * GET /api/ml/explain/:appointmentId
   */
  async explainAppointment(req, res) {
    const { appointmentId } = req.params;
    const appt = await AppointmentModel.findById(appointmentId);
    if (!appt) return notFound(res, 'Appointment');
    const patient  = await PatientModel.findById(appt.patient_id);
    const features = buildFeaturePayload({ appointment: appt, patient, treatment: null });
    const result   = await explainPrediction(features);
    if (!result) return errResp(res, 'ML service unavailable', 503, 'ML_UNAVAILABLE');
    return success(res, result);
  },

  /**
   * GET /api/ml/health
   */
  async health(req, res) {
    const mlHealth = await checkHealth();
    return success(res, { ml_service: mlHealth });
  },

  /**
   * GET /api/ml/risk-summary
   * Returns count of appointments by risk level (for dashboard widget).
   */
  async riskSummary(req, res) {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE no_show_probability < 0.35)  AS low_risk,
        COUNT(*) FILTER (WHERE no_show_probability >= 0.35 AND no_show_probability < 0.60) AS medium_risk,
        COUNT(*) FILTER (WHERE no_show_probability >= 0.60) AS high_risk,
        COUNT(*) FILTER (WHERE no_show_probability IS NULL) AS unscored
      FROM appointments
      WHERE status IN ('scheduled','confirmed')
        AND scheduled_at > NOW()
    `).catch(() => ({ rows: [{ low_risk:0, medium_risk:0, high_risk:0, unscored:0 }] }));
    return success(res, rows[0]);
  },
};

module.exports = MLController;
