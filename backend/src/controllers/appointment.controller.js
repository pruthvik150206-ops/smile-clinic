const AppointmentModel = require('../models/appointment.model');
const PatientModel     = require('../models/patient.model');
const DoctorModel      = require('../models/doctor.model');
const db               = require('../config/database');
const mlService        = require('../services/mlService');
const { success, created, notFound, badRequest, conflict, paginate } = require('../utils/response');
const logger = require('../utils/logger');

const AppointmentController = {

  async list(req, res) {
    const { patient_id, doctor_id, status, date_from, date_to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const role   = req.user.role;

    // Patients can only see their own appointments
    let effectivePatientId = patient_id;
    if (role === 'patient') {
      const self = await PatientModel.findByUserId(req.user.userId);
      effectivePatientId = self ? self.patient_id : -1;
    }

    // Doctors can only see their assigned appointments
    let effectiveDoctorId = doctor_id;
    if (role === 'doctor') {
      const selfDoc = await DoctorModel.findByUserId(req.user.userId);
      effectiveDoctorId = selfDoc ? selfDoc.doctor_id : -1;
    }

    const [appointments, total] = await Promise.all([
      AppointmentModel.findAll({ patientId: effectivePatientId, doctorId: effectiveDoctorId, status, dateFrom: date_from, dateTo: date_to, limit: parseInt(limit), offset: parseInt(offset) }),
      AppointmentModel.count({ patientId: effectivePatientId, doctorId: effectiveDoctorId, status, dateFrom: date_from, dateTo: date_to }),
    ]);
    return success(res, paginate(appointments, total, page, limit));
  },

  async getOne(req, res) {
    const appt = await AppointmentModel.findById(req.params.id);
    if (!appt) return notFound(res, 'Appointment');
    return success(res, appt);
  },

  async create(req, res) {
    const { patient_id, doctor_id, scheduled_at, treatment_id, booking_source } = req.body;
    if (!patient_id || !scheduled_at)
      return badRequest(res, 'patient_id and scheduled_at are required');

    const patient = await PatientModel.findById(patient_id);
    if (!patient) return notFound(res, 'Patient');

    if (doctor_id) {
      const doctor = await DoctorModel.findById(doctor_id);
      if (!doctor) return notFound(res, 'Doctor');
      const conflict = await AppointmentModel.hasConflict(doctor_id, scheduled_at, req.body.duration_mins || 30);
      if (conflict) return res.status(409).json({ success: false, error: { code: 'SCHEDULE_CONFLICT', message: 'Doctor already has an appointment at that time.' } });
    }

    // Create appointment
    const apptPayload = {
      ...req.body,
      booking_source: booking_source || 'Call Booking'
    };
    const appt = await AppointmentModel.create(apptPayload);

    // Add treatment if given
    if (treatment_id) {
      const { rows } = await db.query('SELECT * FROM treatments WHERE treatment_id=$1', [treatment_id]);
      const tx = rows[0];
      if (tx) await AppointmentModel.addTreatment(appt.appointment_id, treatment_id, 1, tx.base_cost);
    }

    // Fetch extra patient stats for ML
    const { rows: stats } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='no_show') AS prior_no_shows,
              COUNT(*) AS total_appointments
       FROM appointments WHERE patient_id=$1`, [patient_id]
    );
    const enriched = { ...patient, ...stats[0] };

    // Get treatment details for ML
    let treatment = null;
    if (treatment_id) {
      const { rows } = await db.query('SELECT * FROM treatments WHERE treatment_id=$1', [treatment_id]);
      treatment = rows[0] || null;
    }

    const features   = mlService.buildFeaturePayload({ appointment: appt, patient: enriched, treatment });
    const prediction = await mlService.predictNoShow(features);

    if (prediction) {
      await AppointmentModel.update(appt.appointment_id, { no_show_probability: prediction.no_show_probability });
      await db.query(
        `INSERT INTO ml_predictions (appointment_id,model_name,model_version,prediction_score,prediction_label,feature_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [appt.appointment_id, 'no_show_xgboost', prediction.model_version,
         prediction.no_show_probability, prediction.label, JSON.stringify(features)]
      ).catch(() => {});
    }

    const full = await AppointmentModel.findById(appt.appointment_id);
    logger.info('Appointment created', { appointment_id: appt.appointment_id, risk: prediction?.risk_level });
    return created(res, { ...full, ...(prediction || {}) });
  },

  async update(req, res) {
    const existing = await AppointmentModel.findById(req.params.id);
    if (!existing) return notFound(res, 'Appointment');
    const updated = await AppointmentModel.update(req.params.id, req.body);
    return success(res, updated);
  },

  async cancel(req, res) {
    const appt = await AppointmentModel.cancel(req.params.id);
    if (!appt) return notFound(res, 'Appointment (or already cancelled/completed)');
    return success(res, appt);
  },

  async addTreatment(req, res) {
    const { treatment_id, quantity = 1, unit_cost, notes } = req.body;
    if (!treatment_id) return badRequest(res, 'treatment_id is required');
    const { rows } = await db.query('SELECT base_cost FROM treatments WHERE treatment_id=$1', [treatment_id]);
    const cost = unit_cost || rows[0]?.base_cost || 0;
    const row  = await AppointmentModel.addTreatment(req.params.id, treatment_id, quantity, cost, notes);
    return success(res, row);
  },

  async removeTreatment(req, res) {
    const ok = await AppointmentModel.removeTreatment(req.params.id, req.params.treatmentId);
    if (!ok) return notFound(res, 'Treatment on appointment');
    return success(res, { removed: true });
  },

  async delete(req, res) {
    const ok = await AppointmentModel.delete(req.params.id);
    if (!ok) return notFound(res, 'Appointment');
    logger.info('Appointment deleted', { appointment_id: req.params.id });
    return success(res, { deleted: true, appointment_id: parseInt(req.params.id) });
  },

  async publicBook(req, res) {
    try {
      const { first_name, last_name, name, email, phone, doctor_id, scheduled_at, reason, notes } = req.body;
      const patientName = name || `${first_name || ''} ${last_name || ''}`.trim() || 'Guest Patient';

      let patient = null;
      if (email || phone) {
        try {
          const query = 'SELECT p.* FROM patients p LEFT JOIN users u ON u.user_id = p.user_id WHERE ($1::text IS NOT NULL AND u.email = $1) OR ($2::text IS NOT NULL AND p.phone = $2)';
          const existing = await db.query(query, [email || null, phone || null]).catch(() => ({ rows: [] }));
          patient = existing.rows && existing.rows[0];
        } catch (e) {}
      }

      if (!patient) {
        const nameParts = patientName.split(' ');
        const fName = nameParts[0] || 'Guest';
        const lName = nameParts.slice(1).join(' ') || 'Patient';

        patient = await PatientModel.create({
          first_name: fName,
          last_name: lName,
          email: email || `patient_${Date.now()}@smileclinic.in`,
          phone: phone || '0000000000',
          gender: 'Other',
          date_of_birth: '1990-01-01',
          medical_history: reason || notes || 'Online website booking'
        }).catch(err => {
          logger.warn('Failed to auto-create patient for public booking', { error: err.message });
          return { patient_id: 1 };
        });
      }

      const docId = doctor_id ? parseInt(doctor_id) : null;
      const apptDate = scheduled_at || new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 16);

      const appt = await AppointmentModel.create({
        patient_id: patient ? patient.patient_id : 1,
        doctor_id: docId,
        scheduled_at: apptDate,
        status: 'scheduled',
        reason: reason || notes || 'Website Online Booking',
        notes: reason || notes || 'Website Online Booking',
        booking_source: req.body.booking_source || 'Website Booking'
      });

      return success(res, {
        message: 'Appointment booked successfully! Our clinic will confirm shortly.',
        appointment_id: appt.appointment_id,
        scheduled_at: appt.scheduled_at
      });
    } catch (err) {
      logger.error('Public booking failed', { error: err.message });
      return badRequest(res, 'Could not complete booking: ' + err.message);
    }
  }
};

module.exports = AppointmentController;

