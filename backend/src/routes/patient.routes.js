const router = require('express').Router();
const { body } = require('express-validator');
const PatientController  = require('../controllers/patient.controller');
const { protect, restrictTo, ownOrPrivileged } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const createRules = [
  body('first_name').trim().notEmpty().withMessage('First name required'),
  body('last_name').trim().notEmpty().withMessage('Last name required'),
  body('phone').notEmpty().withMessage('Phone required'),
  body('gender').optional().isIn(['male','female','other','prefer_not_to_say']),
  body('email').optional().isEmail().withMessage('Valid email required'),
];

router.use(protect);

router.get('/',    PatientController.list);
router.post('/',   restrictTo('admin','receptionist'), createRules, validate, PatientController.create);

router.get('/:id',              ownOrPrivileged, PatientController.getOne);
router.put('/:id',              restrictTo('admin','receptionist','doctor'), PatientController.update);
router.patch('/:id',            restrictTo('admin','receptionist','doctor'), PatientController.update);
router.delete('/:id',           restrictTo('admin'), PatientController.remove);
router.get('/:id/appointments', ownOrPrivileged, PatientController.getAppointments);

module.exports = router;
