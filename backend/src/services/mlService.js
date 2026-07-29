/**
 * services/mlService.js
 * ──────────────────────────────────────────────────────────
 * Client for the Python ML microservice.
 * Used by the Node.js backend to enrich appointments with
 * no-show predictions before saving or returning them.
 *
 * Features:
 *  - Automatic retry on transient failures (max 3)
 *  - Circuit breaker: stops calling ML if it's down
 *  - Graceful degradation: returns null on ML unavailability
 *  - Caching: stores predictions per appointment for 1h
 */

const https = require('https');
const http  = require('http');
const logger = require('../utils/logger');

const ML_BASE     = process.env.ML_SERVICE_URL  || 'http://localhost:8001';
const ML_TIMEOUT  = parseInt(process.env.ML_TIMEOUT_MS || '4000');
const MAX_RETRIES = 3;

// ── In-memory prediction cache (replace with Redis in prod) ──
const predictionCache = new Map();
const CACHE_TTL_MS    = 60 * 60 * 1000; // 1 hour

// ── Circuit breaker state ─────────────────────────────────
const circuit = { failures: 0, lastFailure: null, open: false };
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS  = 30_000; // 30 s

function circuitCheck() {
  if (!circuit.open) return true;
  if (Date.now() - circuit.lastFailure > CIRCUIT_RESET_MS) {
    circuit.open     = false;
    circuit.failures = 0;
    logger.info('ML circuit breaker: reset (half-open probe)');
    return true;
  }
  return false;   // still open
}

function circuitFail() {
  circuit.failures++;
  circuit.lastFailure = Date.now();
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.open = true;
    logger.warn(`ML circuit breaker: OPEN after ${circuit.failures} failures`);
  }
}

function circuitSuccess() {
  circuit.failures = 0;
  circuit.open     = false;
}

// ── Low-level HTTP helper ─────────────────────────────────
function httpPost(url, body, retries = 0) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  ML_TIMEOUT,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('ML service returned non-JSON')); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('ML request timed out')); });
    req.on('error',   err => {
      if (retries < MAX_RETRIES - 1) {
        const delay = 200 * (retries + 1);
        setTimeout(() => httpPost(url, body, retries + 1).then(resolve).catch(reject), delay);
      } else {
        reject(err);
      }
    });

    req.write(payload);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────

/**
 * Predict no-show probability for a single appointment.
 * Returns the ML prediction object or null on failure.
 *
 * @param {object} appointmentData - fields from the appointment + patient
 * @param {number} appointmentData.lead_time_days
 * @param {number} appointmentData.prior_no_shows
 * @param {number} appointmentData.appointment_hour
 * @param {number} appointmentData.age
 * @param {number} appointmentData.distance_km
 * @param {number} appointmentData.treatment_cost
 * @param {number} appointmentData.previous_appointments
 * @param {number} appointmentData.month
 * @param {0|1}    appointmentData.reminder_sent
 * @param {0|1}    appointmentData.has_insurance
 * @param {0|1}    appointmentData.is_follow_up
 * @param {string} appointmentData.day_of_week
 * @param {string} appointmentData.treatment_category
 * @param {string} appointmentData.gender
 */
const predictNoShow = async (appointmentData) => {
  const cacheKey = `noshow:${JSON.stringify(appointmentData)}`;
  const cached   = predictionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  if (!circuitCheck()) {
    logger.warn('ML circuit OPEN — skipping prediction');
    return null;
  }

  try {
    const { status, body } = await httpPost(`${ML_BASE}/predict/no-show`, appointmentData);
    if (status !== 200) throw new Error(`ML service returned ${status}`);
    circuitSuccess();

    predictionCache.set(cacheKey, { data: body, ts: Date.now() });
    return body;
  } catch (err) {
    circuitFail();
    logger.error('ML prediction failed', { error: err.message });
    return null;  // graceful degradation
  }
};

/**
 * Batch predict for an array of appointments (max 100).
 * Returns array aligned with input (nulls on failure).
 */
const predictBatch = async (appointments) => {
  if (!circuitCheck()) return appointments.map(() => null);
  try {
    const { status, body } = await httpPost(`${ML_BASE}/predict/batch`, { appointments });
    if (status !== 200) throw new Error(`ML batch returned ${status}`);
    circuitSuccess();
    return body.results;
  } catch (err) {
    circuitFail();
    logger.error('ML batch prediction failed', { error: err.message });
    return appointments.map(() => null);
  }
};

/**
 * Get explainability for an appointment prediction.
 */
const explainPrediction = async (appointmentData) => {
  if (!circuitCheck()) return null;
  try {
    const { status, body } = await httpPost(`${ML_BASE}/predict/explain`, appointmentData);
    if (status !== 200) throw new Error(`ML explain returned ${status}`);
    circuitSuccess();
    return body;
  } catch (err) {
    circuitFail();
    logger.error('ML explain failed', { error: err.message });
    return null;
  }
};

/**
 * Health check — useful for /health endpoint in backend.
 */
const checkHealth = () => {
  return new Promise((resolve) => {
    const parsed = new URL(`${ML_BASE}/health`);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: parsed.hostname, port: parsed.port, path: '/health', timeout: 2000 }, res => {
      resolve({ reachable: res.statusCode === 200, circuit: circuit.open ? 'open' : 'closed' });
    });
    req.on('error', () => resolve({ reachable: false, circuit: circuit.open ? 'open' : 'closed' }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
    req.end();
  });
};

/**
 * Build ML feature payload from DB objects.
 * Centralises the mapping so controllers don't have to.
 */
const buildFeaturePayload = ({ appointment, patient, treatment }) => ({
  lead_time_days:        Math.floor((new Date(appointment.scheduled_at) - new Date(appointment.created_at)) / 86400000),
  prior_no_shows:        patient.prior_no_shows  || 0,
  appointment_hour:      new Date(appointment.scheduled_at).getHours(),
  age:                   Math.floor((Date.now() - new Date(patient.date_of_birth)) / (365.25 * 86400000)),
  distance_km:           patient.distance_km     || 5.0,
  treatment_cost:        treatment?.base_cost    || 1000,
  previous_appointments: patient.total_appointments || 0,
  month:                 new Date(appointment.scheduled_at).getMonth() + 1,
  reminder_sent:         appointment.reminder_sent ? 1 : 0,
  has_insurance:         patient.has_insurance   ? 1 : 0,
  is_follow_up:          appointment.is_follow_up ? 1 : 0,
  day_of_week:           ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date(appointment.scheduled_at).getDay()],
  treatment_category:    treatment?.category     || 'restorative',
  gender:                patient.gender          || 'other',
  patient_id:            patient.patient_id,
  appointment_id:        appointment.appointment_id,
});

module.exports = { predictNoShow, predictBatch, explainPrediction, checkHealth, buildFeaturePayload };
