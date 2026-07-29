const router = require('express').Router();
const TreatmentController = require('../controllers/treatment.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);
router.get('/',    TreatmentController.list);
router.post('/',   restrictTo('admin'), TreatmentController.create);
router.get('/:id', TreatmentController.getOne);
router.put('/:id',   restrictTo('admin'), TreatmentController.update);
router.patch('/:id', restrictTo('admin'), TreatmentController.update);
module.exports = router;
