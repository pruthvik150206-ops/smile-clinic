const router = require('express').Router();
const BillingController = require('../controllers/billing.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);
router.get('/',                  BillingController.listInvoices);
router.post('/',                 restrictTo('admin','receptionist'), BillingController.createInvoice);
router.get('/revenue-report',    restrictTo('admin'), BillingController.revenueReport);
router.get('/claims',            BillingController.listClaims);
router.post('/claims',           restrictTo('admin','receptionist'), BillingController.createClaim);
router.patch('/claims/:id',      restrictTo('admin'), BillingController.updateClaim);
router.get('/:id',               BillingController.getInvoice);
router.patch('/:id/pay',         restrictTo('admin','receptionist'), BillingController.markPaid);
router.patch('/:id/void',        restrictTo('admin'), BillingController.voidInvoice);
module.exports = router;
