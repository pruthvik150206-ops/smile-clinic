const router = require('express').Router();
const { body } = require('express-validator');
const AppointmentController = require('../controllers/appointment.controller');
const { protect, restrictTo } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const createRules = [
  body('patient_id').isInt({ min: 1 }).withMessage('Valid patient_id required'),
  body('doctor_id').isInt({ min: 1 }).withMessage('Valid doctor_id required'),
  body('scheduled_at').notEmpty().withMessage('scheduled_at required'),
];

router.use(protect);
router.get('/',    AppointmentController.list);
router.post('/',   restrictTo('admin','receptionist','doctor'), createRules, validate, AppointmentController.create);
router.get('/:id', AppointmentController.getOne);
router.put('/:id',    restrictTo('admin','receptionist','doctor'), AppointmentController.update);
router.patch('/:id',  restrictTo('admin','receptionist','doctor'), AppointmentController.update);
router.delete('/:id', restrictTo('admin'), AppointmentController.delete);
router.post('/:id/cancel', restrictTo('admin','receptionist'), AppointmentController.cancel);
router.post('/:id/treatments', restrictTo('admin','doctor'), AppointmentController.addTreatment);
router.delete('/:id/treatments/:treatmentId', restrictTo('admin','doctor'), AppointmentController.removeTreatment);
module.exports = router;
