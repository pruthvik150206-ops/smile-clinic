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

const fs = require('fs');

const candidatePaths = [
  path.join(process.cwd(), 'frontend/static'),
  '/var/task/frontend/static',
  path.join(__dirname, '../../frontend/static'),
  path.join(__dirname, '../frontend/static'),
  path.join(process.cwd(), 'public')
];
const staticPath = candidatePaths.find(p => fs.existsSync(path.join(p, 'dms.html'))) || candidatePaths[0];
const landingExists = fs.existsSync(path.join(staticPath, 'landing.html'));
console.log('[static] cwd:', process.cwd(), '| __dirname:', __dirname);
console.log('[static] resolved:', staticPath, '| landing:', landingExists);

app.use(express.static(staticPath, { index: false }));

// Debug route — remove after confirming paths
app.get('/api/debug-paths', (req, res) => {
  const results = candidatePaths.map(p => ({
    path: p,
    exists: fs.existsSync(p),
    hasLanding: fs.existsSync(path.join(p, 'landing.html')),
    hasDms: fs.existsSync(path.join(p, 'dms.html')),
  }));
  res.json({ cwd: process.cwd(), dirname: __dirname, resolved: staticPath, landingExists, candidates: results });
});

app.get(['/', '/landing', '/landing.html'], (req, res) => {
  const landingFile = path.join(staticPath, 'landing.html');
  if (fs.existsSync(landingFile)) {
    return res.sendFile(landingFile);
  }
  return res.status(500).json({ error: 'landing.html not found', tried: landingFile, cwd: process.cwd(), dirname: __dirname });
});

app.get(['/dms', '/dms.html', '/portal', '/portal.html', '/login', '/login.html'], (req, res) => {
  const dmsFile = path.join(staticPath, 'dms.html');
  if (fs.existsSync(dmsFile)) {
    return res.sendFile(dmsFile);
  }
  return res.status(404).send('DMS Portal page file not found');
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/json/') || req.path === '/favicon.ico') return next();
  const idxFile = path.join(staticPath, 'index.html');
  if (fs.existsSync(idxFile)) {
    return res.sendFile(idxFile);
  }
  return next();
});

app.get('/api/health', async (req, res) => {
  const mlService = require('./services/mlService');
  const mlHealth  = await mlService.checkHealth();
  res.json({ success: true, data: { status: 'healthy', db: 'connected', ml: mlHealth, timestamp: new Date().toISOString() } });
});

const AppointmentController = require('./controllers/appointment.controller');
const DoctorModel           = require('./models/doctor.model');

app.post('/api/public/book',             AppointmentController.publicBook);
app.post('/api/public/book-appointment', AppointmentController.publicBook);
app.get('/api/public/doctors', async (req, res) => {
  try {
    const doctors = await DoctorModel.findAll({});
    return res.json({ success: true, data: doctors });
  } catch (err) {
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

const statsRoutes        = require('./routes/stats.routes');
const prescriptionRoutes = require('./routes/prescription.routes');

app.use('/api/auth',          authRoutes);
app.use('/api/patients',      patientRoutes);
app.use('/api/doctors',       doctorRoutes);
app.use('/api/appointments',  appointmentRoutes);
app.use('/api/invoices',      billingRoutes);
app.use('/api/treatments',    treatmentRoutes);
app.use('/api/ml',            mlRoutes);
app.use('/api/stats',         statsRoutes);
app.use('/api/prescriptions', prescriptionRoutes);

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
