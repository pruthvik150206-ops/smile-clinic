const DoctorModel  = require('../models/doctor.model');
const UserModel   = require('../models/user.model');
const bcrypt      = require('bcryptjs');
const { withTransaction } = require('../config/database');
const { success, created, notFound, badRequest, conflict, paginate } = require('../utils/response');
const logger = require('../utils/logger');

const DoctorController = {

  async list(req, res) {
    const { search = '', specialisation = '', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const [doctors, total] = await Promise.all([
      DoctorModel.findAll({ search, specialisation, limit: parseInt(limit), offset: parseInt(offset) }),
      DoctorModel.count({ search, specialisation }),
    ]);
    return success(res, paginate(doctors, total, page, limit));
  },

  async getOne(req, res) {
    const doctor = await DoctorModel.findById(req.params.id);
    if (!doctor) return notFound(res, 'Doctor');
    return success(res, doctor);
  },

  async create(req, res) {
    const { first_name, last_name, specialisation, license_number, phone, email, password } = req.body;
    if (!first_name || !last_name || !specialisation || !license_number || !phone)
      return badRequest(res, 'first_name, last_name, specialisation, license_number and phone are required');

    let targetUserId = req.body.user_id;
    if (!targetUserId && email) {
      const existingUser = await UserModel.findByEmail(email);
      if (existingUser) {
        targetUserId = existingUser.user_id;
      } else {
        const hash = await bcrypt.hash(password || 'Doctor123!', 12);
        const uname = 'dr_' + first_name.toLowerCase().replace(/\s+/g, '_') + '_' + (Date.now() % 9999);
        const newUser = await UserModel.create({ username: uname, email, passwordHash: hash, role: 'doctor' });
        targetUserId = newUser.user_id;
      }
    }
    const doctor = await DoctorModel.create({ ...req.body, user_id: targetUserId });
    logger.info('Doctor created', { doctor_id: doctor.doctor_id });
    return created(res, doctor);
  },

  async update(req, res) {
    const existing = await DoctorModel.findById(req.params.id);
    if (!existing) return notFound(res, 'Doctor');
    const updated = await DoctorModel.update(req.params.id, req.body);
    return success(res, updated);
  },

  async setAvailability(req, res) {
    const doctor = await DoctorModel.findById(req.params.id);
    if (!doctor) return notFound(res, 'Doctor');
    const { slots } = req.body;
    if (!Array.isArray(slots)) return badRequest(res, 'slots must be an array');
    await DoctorModel.setAvailability(req.params.id, slots);
    return success(res, { message: 'Availability updated', slots });
  },
};

module.exports = DoctorController;
