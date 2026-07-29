const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const { testConnection } = require('./config/database');
const logger             = require('./utils/logger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes        = require('./routes/auth.routes');
const patientRoutes     = require('./routes/patient.routes');
const doctorRoutes      = require('./routes/doctor.routes');
const appointmentRoutes = require('./routes/appointment.routes');
const billingRoutes     = require('./routes/billing.routes');
const treatmentRoutes   = require('./routes/treatment.routes');
const mlRoutes          = require('./routes/ml.routes');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: msg => logger.info(msg.trim()) } }));
}

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many auth attempts.' } }
}));
app.use('/api', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '300'),
  message:  { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }
}));

const path = require('path');
const staticPath = path.join(__dirname, '../../frontend/static');
app.use(express.static(staticPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(staticPath, 'index.html'));
});

app.get('/api/health', async (req, res) => {
  const mlService = require('./services/mlService');
  const mlHealth  = await mlService.checkHealth();
  res.json({ success: true, data: { status: 'healthy', db: 'connected', ml: mlHealth, timestamp: new Date().toISOString() } });
});

app.use('/api/auth',         authRoutes);
app.use('/api/patients',     patientRoutes);
app.use('/api/doctors',      doctorRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/invoices',     billingRoutes);
app.use('/api/treatments',   treatmentRoutes);
app.use('/api/ml',           mlRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  const start = async () => {
    try {
      await testConnection();
      app.listen(PORT, () => {
        logger.info(`SmileClinic API running on port ${PORT}`);
      });
    } catch (err) {
      logger.error('Failed to start', { error: err.message });
      process.exit(1);
    }
  };
  start();
}

module.exports = app;
