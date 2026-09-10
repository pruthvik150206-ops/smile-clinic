const { Pool } = require('pg');
const logger   = require('../utils/logger');

const isSslEnabled = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('supabase'));

const defaultDbUrl = 'postgresql://postgres.iyqkzdhhkkmhrebsfril:9a4d49f1g12h78@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const databaseUrl = process.env.DATABASE_URL || (process.env.DB_HOST ? null : defaultDbUrl);

const poolConfig = databaseUrl
  ? {
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: parseInt(process.env.DB_POOL_MAX || '10'),
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE_MS || '1200'),
      keepAlive: true,
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'dental_clinic',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      max:      parseInt(process.env.DB_POOL_MAX        || '10'),
      idleTimeoutMillis:    parseInt(process.env.DB_POOL_IDLE_MS    || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE_MS || '1200'),
      ssl: isSslEnabled ? { rejectUnauthorized: false } : false,
      keepAlive: true,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => logger.error('PostgreSQL idle client error', { error: err.message }));

let lastPgFailureTimestamp = 0;
const PG_COOLDOWN_MS = 60000; // 60 seconds fast-fail cooldown when PG is unreachable

/**
 * Execute a single query with circuit-breaker protection.
 * @param {string} text  - Parameterised SQL
 * @param {any[]}  params - Bind values
 */
const query = async (text, params) => {
  if (Date.now() - lastPgFailureTimestamp < PG_COOLDOWN_MS) {
    throw new Error('PostgreSQL circuit-breaker active — fast fallback to SQLite');
  }
  try {
    return await pool.query(text, params);
  } catch (err) {
    lastPgFailureTimestamp = Date.now();
    throw err;
  }
};

/**
 * Run multiple queries inside one transaction.
 * @param {Function} callback - receives a connected client
 */
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const testConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query('SELECT NOW() AS now');
    logger.info(`PostgreSQL connected — server time: ${rows[0].now}`);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_purpose VARCHAR(30);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_2fa_enabled BOOLEAN DEFAULT FALSE;
    `);
  } catch (err) {
    lastPgFailureTimestamp = Date.now();
    logger.warn('PostgreSQL DB offline — operating in high-availability local storage mode', { error: err.message });
  } finally {
    if (client) client.release();
  }
};

module.exports = { query, withTransaction, testConnection, pool };
