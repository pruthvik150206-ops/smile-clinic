/**
 * routes/ml.routes.js
 */
const router        = require('express').Router();
const MLController  = require('../controllers/ml.controller');
const { protect, restrictTo } = require('../middleware/auth');

// Health — public (for load balancers)
router.get('/health', MLController.health);

// Risk summary for dashboard — any authenticated user
router.get('/risk-summary', protect, MLController.riskSummary);

// Manual prediction (test form in frontend) — admin / doctor
router.post('/predict/manual', protect, restrictTo('admin','doctor'), MLController.predictManual);

// Predict for specific appointment — doctor / receptionist / admin
router.post('/predict/:appointmentId', protect, restrictTo('admin','doctor','receptionist'), MLController.predictForAppointment);

// Batch scoring — admin only
router.post('/predict-batch', protect, restrictTo('admin'), MLController.predictBatch);

// Explain — doctor / admin
router.get('/explain/:appointmentId', protect, restrictTo('admin','doctor'), MLController.explainAppointment);

module.exports = router;
