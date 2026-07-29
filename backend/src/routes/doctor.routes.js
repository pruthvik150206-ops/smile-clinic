const router = require('express').Router();
const DoctorController = require('../controllers/doctor.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);
router.get('/',                       DoctorController.list);
router.post('/',  restrictTo('admin'), DoctorController.create);
router.get('/:id',                    DoctorController.getOne);
router.put('/:id',  restrictTo('admin'), DoctorController.update);
router.patch('/:id', restrictTo('admin'), DoctorController.update);
router.put('/:id/availability', restrictTo('admin','doctor'), DoctorController.setAvailability);
module.exports = router;
