const PatientModel = require('../models/patient.model');
const UserModel    = require('../models/user.model');
const { withTransaction } = require('../config/database');
const bcrypt  = require('bcryptjs');
const { success, created, notFound, badRequest, conflict, paginate } = require('../utils/response');
const logger  = require('../utils/logger');

const PatientController = {

  async list(req, res) {
    const { search = '', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const [patients, total] = await Promise.all([
      PatientModel.findAll({ search, limit: parseInt(limit), offset: parseInt(offset) }),
      PatientModel.count(search),
    ]);
    return success(res, paginate(patients, total, page, limit));
  },

  async getOne(req, res) {
    const patient = await PatientModel.findById(req.params.id);
    if (!patient) return notFound(res, 'Patient');

    if (req._enforceOwnership) {
      const self = await PatientModel.findByUserId(req.user.userId);
      if (!self || self.patient_id !== patient.patient_id)
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only view your own records.' } });
    }
    return success(res, patient);
  },

  async create(req, res) {
    const { first_name, last_name, phone, email, password, ...rest } = req.body;
    if (!first_name || !last_name || !phone)
      return badRequest(res, 'first_name, last_name and phone are required');

    let user_id;
    if (email) {
      if (await UserModel.existsByEmail(email)) return conflict(res, 'Email already registered');
      const hash = await bcrypt.hash(password || 'ChangeMe123!', 12);
      const username = email.split('@')[0] + '_' + Date.now();
      const user = await UserModel.create({ username, email, passwordHash: hash, role: 'patient' });
      user_id = user.user_id;
    } else {
      const placeholder = `patient_${Date.now()}@clinic.local`;
      const hash = await bcrypt.hash('ChangeMe123!', 12);
      const user = await UserModel.create({ username: `pat_${Date.now()}`, email: placeholder, passwordHash: hash, role: 'patient' });
      user_id = user.user_id;
    }

    const patient = await PatientModel.create({ user_id, first_name, last_name, phone, ...rest });
    logger.info('Patient created', { patient_id: patient.patient_id });
    return created(res, patient);
  },

  async update(req, res) {
    const existing = await PatientModel.findById(req.params.id);
    if (!existing) return notFound(res, 'Patient');

    const updated = await PatientModel.update(req.params.id, req.body);
    return success(res, updated);
  },

  async remove(req, res) {
    const existing = await PatientModel.findById(req.params.id);
    if (!existing) return notFound(res, 'Patient');

    await PatientModel.delete(req.params.id);
    logger.info('Patient deleted', { patient_id: req.params.id });
    return success(res, { deleted: true, patient_id: parseInt(req.params.id) });
  },

  async getAppointments(req, res) {
    const patient = await PatientModel.findById(req.params.id);
    if (!patient) return notFound(res, 'Patient');
    const appts = await PatientModel.getAppointments(req.params.id);
    return success(res, appts);
  },
};

module.exports = PatientController;
