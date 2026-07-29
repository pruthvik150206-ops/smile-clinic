-- ================================================================
--  SMILECLINIC DENTAL MANAGEMENT SYSTEM
--  Complete SQL File
--  Includes: PostgreSQL Schema + SQLite Schema + All Seed Data
--  Generated: 2026-05-18
-- ================================================================


-- ================================================================
--  PART A: POSTGRESQL SCHEMA  (for production use)
--  Run with: psql -U postgres -d dental_clinic -f schema.sql
-- ================================================================

-- ── Extensions ──────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Clean up existing objects (allows safe re-execution) ────────
DROP VIEW IF EXISTS v_upcoming_appointments CASCADE;
DROP VIEW IF EXISTS v_monthly_revenue CASCADE;
DROP VIEW IF EXISTS v_treatment_stats CASCADE;

DROP TABLE IF EXISTS ml_predictions CASCADE;
DROP TABLE IF EXISTS insurance_claims CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS appointment_treatments CASCADE;
DROP TABLE IF EXISTS appointments CASCADE;
DROP TABLE IF EXISTS doctor_schedules CASCADE;
DROP TABLE IF EXISTS treatments CASCADE;
DROP TABLE IF EXISTS doctors CASCADE;
DROP TABLE IF EXISTS patients CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ── ENUM types ───────────────────────────────────────────────────
DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS gender_type CASCADE;
DROP TYPE IF EXISTS appointment_status CASCADE;
DROP TYPE IF EXISTS payment_status CASCADE;
DROP TYPE IF EXISTS payment_method CASCADE;
DROP TYPE IF EXISTS claim_status CASCADE;
DROP TYPE IF EXISTS day_of_week_type CASCADE;
DROP TYPE IF EXISTS day_of_week CASCADE;
DROP TYPE IF EXISTS treatment_category CASCADE;

CREATE TYPE user_role          AS ENUM ('admin', 'doctor', 'receptionist', 'patient');
CREATE TYPE gender_type        AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
CREATE TYPE payment_status     AS ENUM ('pending', 'paid', 'partially_paid', 'overdue', 'waived');
CREATE TYPE payment_method     AS ENUM ('cash', 'card', 'upi', 'insurance', 'bank_transfer');
CREATE TYPE claim_status       AS ENUM ('submitted', 'under_review', 'approved', 'rejected', 'paid');
CREATE TYPE day_of_week_type   AS ENUM ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
CREATE TYPE treatment_category AS ENUM ('preventive', 'restorative', 'cosmetic', 'orthodontic', 'surgical', 'diagnostic');


-- ── TABLE: users ─────────────────────────────────────────────────
CREATE TABLE users (
    user_id       SERIAL          PRIMARY KEY,
    username      VARCHAR(50)     NOT NULL UNIQUE,
    email         VARCHAR(150)    NOT NULL UNIQUE,
    password_hash VARCHAR(255)    NOT NULL,
    role          user_role       NOT NULL DEFAULT 'patient',
    is_active     BOOLEAN         NOT NULL DEFAULT TRUE,
    last_login    TIMESTAMP,
    created_at    TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_users_email CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$')
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role  ON users(role);


-- ── TABLE: patients ───────────────────────────────────────────────
CREATE TABLE patients (
    patient_id              SERIAL        PRIMARY KEY,
    user_id                 INT           NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    first_name              VARCHAR(80)   NOT NULL,
    last_name               VARCHAR(80)   NOT NULL,
    date_of_birth           DATE,
    gender                  gender_type,
    phone                   VARCHAR(20)   NOT NULL,
    address                 TEXT,
    city                    VARCHAR(80),
    pincode                 VARCHAR(10),
    blood_group             VARCHAR(5),
    allergies               TEXT,
    medical_notes           TEXT,
    emergency_contact_name  VARCHAR(100),
    emergency_contact_phone VARCHAR(20),
    created_at              TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_patients_dob   CHECK (date_of_birth < CURRENT_DATE),
    CONSTRAINT chk_patients_phone CHECK (phone ~ '^[0-9+\-() ]{7,20}$')
);
CREATE INDEX idx_patients_user_id   ON patients(user_id);
CREATE INDEX idx_patients_last_name ON patients(last_name);
CREATE INDEX idx_patients_phone     ON patients(phone);


-- ── TABLE: doctors ────────────────────────────────────────────────
CREATE TABLE doctors (
    doctor_id        SERIAL        PRIMARY KEY,
    user_id          INT           NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    first_name       VARCHAR(80)   NOT NULL,
    last_name        VARCHAR(80)   NOT NULL,
    specialisation   VARCHAR(100)  NOT NULL,
    license_number   VARCHAR(50)   NOT NULL UNIQUE,
    phone            VARCHAR(20)   NOT NULL,
    consultation_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    bio              TEXT,
    is_available     BOOLEAN       NOT NULL DEFAULT TRUE,
    joined_date      DATE          NOT NULL DEFAULT CURRENT_DATE,
    created_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_doctors_fee CHECK (consultation_fee >= 0)
);
CREATE INDEX idx_doctors_user_id        ON doctors(user_id);
CREATE INDEX idx_doctors_specialisation ON doctors(specialisation);


-- ── TABLE: doctor_availability ────────────────────────────────────
CREATE TABLE doctor_availability (
    availability_id  SERIAL           PRIMARY KEY,
    doctor_id        INT              NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,
    day_of_week      day_of_week_type NOT NULL,
    slot_start       TIME             NOT NULL,
    slot_end         TIME             NOT NULL,
    max_appointments INT              NOT NULL DEFAULT 10,
    CONSTRAINT chk_avail_time CHECK (slot_end > slot_start),
    CONSTRAINT uq_avail_slot  UNIQUE (doctor_id, day_of_week, slot_start)
);
CREATE INDEX idx_avail_doctor ON doctor_availability(doctor_id);


-- ── TABLE: treatments ─────────────────────────────────────────────
CREATE TABLE treatments (
    treatment_id   SERIAL              PRIMARY KEY,
    treatment_name VARCHAR(150)        NOT NULL UNIQUE,
    category       treatment_category  NOT NULL,
    description    TEXT,
    base_cost      DECIMAL(10,2)       NOT NULL,
    duration_mins  INT                 NOT NULL DEFAULT 30,
    is_active      BOOLEAN             NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_treatment_cost     CHECK (base_cost >= 0),
    CONSTRAINT chk_treatment_duration CHECK (duration_mins > 0)
);
CREATE INDEX idx_treatments_category ON treatments(category);


-- ── TABLE: appointments ───────────────────────────────────────────
CREATE TABLE appointments (
    appointment_id      SERIAL              PRIMARY KEY,
    patient_id          INT                 NOT NULL REFERENCES patients(patient_id)  ON DELETE RESTRICT,
    doctor_id           INT                 NOT NULL REFERENCES doctors(doctor_id)    ON DELETE RESTRICT,
    scheduled_at        TIMESTAMP           NOT NULL,
    duration_mins       INT                 NOT NULL DEFAULT 30,
    status              appointment_status  NOT NULL DEFAULT 'scheduled',
    reason              TEXT,
    notes               TEXT,
    no_show_probability DECIMAL(5,4)        DEFAULT NULL,
    risk_level          VARCHAR(10)         DEFAULT NULL,
    recommended_action  TEXT                DEFAULT NULL,
    reminder_sent       BOOLEAN             NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP           NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP           NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_appt_duration CHECK (duration_mins > 0),
    CONSTRAINT chk_appt_no_show  CHECK (no_show_probability IS NULL OR no_show_probability BETWEEN 0 AND 1)
);
CREATE INDEX idx_appts_patient   ON appointments(patient_id);
CREATE INDEX idx_appts_doctor    ON appointments(doctor_id);
CREATE INDEX idx_appts_scheduled ON appointments(scheduled_at);
CREATE INDEX idx_appts_status    ON appointments(status);


-- ── TABLE: appointment_treatments (junction) ──────────────────────
CREATE TABLE appointment_treatments (
    apt_treatment_id SERIAL         PRIMARY KEY,
    appointment_id   INT            NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    treatment_id     INT            NOT NULL REFERENCES treatments(treatment_id)     ON DELETE RESTRICT,
    quantity         INT            NOT NULL DEFAULT 1,
    unit_cost        DECIMAL(10,2)  NOT NULL,
    notes            TEXT,
    CONSTRAINT uq_apt_treatment UNIQUE (appointment_id, treatment_id),
    CONSTRAINT chk_at_qty       CHECK (quantity > 0),
    CONSTRAINT chk_at_cost      CHECK (unit_cost >= 0)
);
CREATE INDEX idx_apt_treatments_appt      ON appointment_treatments(appointment_id);
CREATE INDEX idx_apt_treatments_treatment ON appointment_treatments(treatment_id);


-- ── TABLE: invoices ───────────────────────────────────────────────
CREATE TABLE invoices (
    invoice_id     SERIAL          PRIMARY KEY,
    appointment_id INT             REFERENCES appointments(appointment_id) ON DELETE RESTRICT,
    patient_id     INT             NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    subtotal       DECIMAL(12,2)   NOT NULL,
    discount       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    tax_rate       DECIMAL(5,4)    NOT NULL DEFAULT 0.18,
    tax_amount     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    total_amount   DECIMAL(12,2)   NOT NULL,
    payment_status payment_status  NOT NULL DEFAULT 'pending',
    payment_method payment_method,
    notes          TEXT,
    issued_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
    paid_at        TIMESTAMP,
    due_date       DATE            NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
    CONSTRAINT chk_inv_subtotal CHECK (subtotal >= 0),
    CONSTRAINT chk_inv_discount CHECK (discount >= 0 AND discount <= subtotal),
    CONSTRAINT chk_inv_tax      CHECK (tax_amount >= 0),
    CONSTRAINT chk_inv_total    CHECK (total_amount >= 0),
    CONSTRAINT chk_inv_paid_at  CHECK (paid_at IS NULL OR paid_at >= issued_at)
);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);
CREATE INDEX idx_invoices_status  ON invoices(payment_status);
CREATE INDEX idx_invoices_issued  ON invoices(issued_at);


-- ── TABLE: insurance_claims ───────────────────────────────────────
CREATE TABLE insurance_claims (
    claim_id         SERIAL        PRIMARY KEY,
    invoice_id       INT           NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
    provider_name    VARCHAR(150)  NOT NULL,
    policy_number    VARCHAR(80)   NOT NULL,
    claim_amount     DECIMAL(12,2) NOT NULL,
    approved_amount  DECIMAL(12,2) DEFAULT NULL,
    claim_status     claim_status  NOT NULL DEFAULT 'submitted',
    submitted_on     DATE          NOT NULL DEFAULT CURRENT_DATE,
    resolved_on      DATE,
    rejection_reason TEXT,
    CONSTRAINT chk_claim_amount   CHECK (claim_amount > 0),
    CONSTRAINT chk_claim_approved CHECK (approved_amount IS NULL OR approved_amount >= 0),
    CONSTRAINT chk_claim_resolved CHECK (resolved_on IS NULL OR resolved_on >= submitted_on)
);
CREATE INDEX idx_claims_invoice ON insurance_claims(invoice_id);
CREATE INDEX idx_claims_status  ON insurance_claims(claim_status);


-- ── TABLE: ml_predictions ─────────────────────────────────────────
CREATE TABLE ml_predictions (
    prediction_id    SERIAL         PRIMARY KEY,
    appointment_id   INT            NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    model_name       VARCHAR(100)   NOT NULL,
    model_version    VARCHAR(20)    NOT NULL DEFAULT '1.0',
    prediction_score DECIMAL(5,4)   NOT NULL,
    prediction_label VARCHAR(50),
    feature_snapshot JSONB          NOT NULL DEFAULT '{}',
    predicted_at     TIMESTAMP      NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ml_score CHECK (prediction_score BETWEEN 0 AND 1)
);
CREATE INDEX idx_ml_appointment ON ml_predictions(appointment_id);
CREATE INDEX idx_ml_model       ON ml_predictions(model_name);
CREATE INDEX idx_ml_snapshot    ON ml_predictions USING gin(feature_snapshot);


-- ── TRIGGERS: auto-update updated_at ─────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_doctors_updated  BEFORE UPDATE ON doctors      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_appts_updated    BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── VIEWS ─────────────────────────────────────────────────────────
CREATE VIEW v_upcoming_appointments AS
SELECT
    a.appointment_id, a.scheduled_at, a.status, a.reason,
    a.no_show_probability, a.risk_level, a.recommended_action,
    p.patient_id,
    p.first_name || ' ' || p.last_name AS patient_name,
    p.phone                             AS patient_phone,
    d.doctor_id,
    d.first_name || ' ' || d.last_name AS doctor_name,
    d.specialisation
FROM appointments a
JOIN patients p ON p.patient_id = a.patient_id
JOIN doctors  d ON d.doctor_id  = a.doctor_id
WHERE a.scheduled_at >= NOW() AND a.status NOT IN ('cancelled','no_show')
ORDER BY a.scheduled_at;

CREATE VIEW v_monthly_revenue AS
SELECT
    DATE_TRUNC('month', issued_at)                                                    AS month,
    COUNT(*)                                                                           AS total_invoices,
    SUM(total_amount)                                                                  AS gross_revenue,
    SUM(CASE WHEN payment_status = 'paid'                    THEN total_amount ELSE 0 END) AS collected,
    SUM(CASE WHEN payment_status IN ('pending','overdue')    THEN total_amount ELSE 0 END) AS outstanding
FROM invoices
GROUP BY 1 ORDER BY 1 DESC;

CREATE VIEW v_treatment_stats AS
SELECT
    t.treatment_id, t.treatment_name, t.category,
    COUNT(at2.apt_treatment_id)             AS times_performed,
    SUM(at2.unit_cost * at2.quantity)       AS total_revenue
FROM treatments t
LEFT JOIN appointment_treatments at2 ON at2.treatment_id = t.treatment_id
GROUP BY t.treatment_id, t.treatment_name, t.category
ORDER BY times_performed DESC;


-- ================================================================
--  PART B: SEED DATA  (works for both PostgreSQL and SQLite)
-- ================================================================

-- ── Users (passwords are bcrypt hashes of the plain text shown) ──
-- admin123 | doctor123 | recept123 | patient123
INSERT INTO users (username, email, password_hash, role) VALUES
('admin',      'admin@smile.in',    '$2a$10$kqEYgDEulD9zgJ9/LQNFf.mqHQaOoa14QuGpD5hIrMi2h0ZfCxA7u', 'admin'),
('dr_priya',   'doctor@smile.in',   '$2a$10$4P4y.Brp3Z0EYz8FS8ktK.6u3uIIbl347lGxMbGgWo7yDm0GAY.Bu', 'doctor'),
('dr_arjun',   'arjun@smile.in',    '$2a$10$4P4y.Brp3Z0EYz8FS8ktK.6u3uIIbl347lGxMbGgWo7yDm0GAY.Bu', 'doctor'),
('kavya_rec',  'recept@smile.in',   '$2a$10$O8rusI7o4IFCev8I7/OJe.nRr4k2cptxnmnIQ2JtqAiXsTI3ZL9Y.', 'receptionist'),
('meera_p',    'meera@patient.in',  '$2a$10$hGjTi/JIie6quEA2RkQ9wOo6VSWV/8/gXHD3y2qfPo7vEU/9xG.Em', 'patient'),
('rahul_v',    'rahul@patient.in',  '$2a$10$hGjTi/JIie6quEA2RkQ9wOo6VSWV/8/gXHD3y2qfPo7vEU/9xG.Em', 'patient'),
('sunita_r',   'sunita@patient.in', '$2a$10$hGjTi/JIie6quEA2RkQ9wOo6VSWV/8/gXHD3y2qfPo7vEU/9xG.Em', 'patient');

-- ── Doctors ────────────────────────────────────────────────────────
INSERT INTO doctors (user_id, first_name, last_name, specialisation, license_number, phone, consultation_fee) VALUES
(2, 'Priya',  'Sharma', 'General Dentistry', 'MCI-DEN-2018-04521', '+91-9876543210', 600.00),
(3, 'Arjun',  'Nair',   'Orthodontics',      'MCI-DEN-2016-03812', '+91-9876543211', 900.00);

-- ── Doctor availability ────────────────────────────────────────────
INSERT INTO doctor_availability (doctor_id, day_of_week, slot_start, slot_end, max_appointments) VALUES
(1, 'monday',    '09:00', '13:00', 8),
(1, 'monday',    '15:00', '18:00', 6),
(1, 'wednesday', '09:00', '13:00', 8),
(1, 'friday',    '09:00', '17:00', 10),
(2, 'tuesday',   '10:00', '14:00', 8),
(2, 'thursday',  '10:00', '14:00', 8),
(2, 'saturday',  '09:00', '13:00', 6);

-- ── Patients ───────────────────────────────────────────────────────
INSERT INTO patients (user_id, first_name, last_name, date_of_birth, gender, phone, city, blood_group, allergies) VALUES
(5, 'Meera',  'Patel',  '1990-03-15', 'female', '+91-9123456701', 'Bengaluru', 'O+', 'Penicillin'),
(6, 'Rahul',  'Verma',  '1985-07-22', 'male',   '+91-9123456702', 'Bengaluru', 'B+', 'None'),
(7, 'Sunita', 'Rao',    '2000-11-08', 'female', '+91-9123456703', 'Bengaluru', 'A-', 'Latex');

-- ── Treatments ─────────────────────────────────────────────────────
INSERT INTO treatments (treatment_name, category, description, base_cost, duration_mins) VALUES
('Dental Cleaning & Scaling',  'preventive',   'Removal of plaque and tartar using ultrasonic scaler',    800.00,  45),
('Composite Filling',          'restorative',  'Tooth-coloured resin filling for cavities',              1200.00,  30),
('Root Canal Treatment',       'restorative',  'Removal of infected pulp; canal cleaning and filling',   5500.00,  90),
('Tooth Extraction (simple)',  'surgical',     'Removal of non-impacted tooth under local anaesthesia',   700.00,  30),
('Teeth Whitening (laser)',    'cosmetic',     'In-office laser whitening for 2-3 shade improvement',    3500.00,  60),
('Dental X-Ray (OPG)',         'diagnostic',   'Full-mouth orthopantomogram digital radiograph',           600.00,  15),
('Metal Braces (per arch)',    'orthodontic',  'Standard stainless steel braces, one arch',             18000.00,  60),
('Pit & Fissure Sealant',      'preventive',   'Protective sealant applied to molars to prevent decay',   400.00,  20),
('Porcelain Crown',            'restorative',  'Full ceramic crown fabricated and cemented',             7500.00,  60),
('Gum Flap Surgery',           'surgical',     'Periodontal surgery for advanced gum disease',           8000.00,  90);

-- ── Appointments ───────────────────────────────────────────────────
INSERT INTO appointments (patient_id, doctor_id, scheduled_at, duration_mins, status, reason, no_show_probability, risk_level) VALUES
(1, 1, '2026-05-20 09:00:00', 90, 'scheduled',  'Root canal — upper left first molar',   0.2350, 'Low'),
(2, 1, '2026-05-22 10:00:00', 30, 'confirmed',  'Filling follow-up',                     0.0670, 'Low'),
(3, 2, '2026-05-27 11:00:00', 60, 'scheduled',  'Braces fitting — upper arch',           0.0510, 'Low'),
(1, 1, '2026-04-10 10:00:00', 45, 'completed',  'Routine scaling and cleaning',          0.0820, 'Low'),
(2, 1, '2026-03-15 14:00:00', 30, 'completed',  'Composite filling — lower molar',       0.1140, 'Low'),
(3, 2, '2026-02-20 11:00:00', 60, 'completed',  'Braces consultation and OPG',           0.0430, 'Low');

-- ── Appointment treatments ─────────────────────────────────────────
INSERT INTO appointment_treatments (appointment_id, treatment_id, quantity, unit_cost) VALUES
(4, 1, 1, 800.00),   -- Meera: cleaning (completed)
(4, 6, 1, 600.00),   -- Meera: OPG
(5, 2, 2, 1200.00),  -- Rahul: 2 fillings (completed)
(5, 6, 1, 600.00),   -- Rahul: OPG
(6, 6, 1, 600.00),   -- Sunita: OPG for consultation (completed)
(1, 3, 1, 5500.00),  -- Meera: RCT (upcoming)
(2, 2, 1, 1200.00),  -- Rahul: filling follow-up (upcoming)
(3, 7, 1, 18000.00); -- Sunita: braces (upcoming)

-- ── Invoices ───────────────────────────────────────────────────────
INSERT INTO invoices (appointment_id, patient_id, subtotal, discount, tax_rate, tax_amount, total_amount, payment_status, payment_method, issued_at, paid_at) VALUES
(4, 1,  1400.00, 0.00, 0.00, 0.00,  1400.00, 'paid',    'upi',  NOW() - INTERVAL '40 days', NOW() - INTERVAL '38 days'),
(5, 2,  3000.00, 200.00, 0.00, 0.00, 2800.00, 'paid',   'card', NOW() - INTERVAL '40 days', NOW() - INTERVAL '36 days'),
(6, 3,   600.00, 0.00, 0.00, 0.00,   600.00, 'paid',    'cash', NOW() - INTERVAL '90 days', NOW() - INTERVAL '87 days'),
(1, 1,  5500.00, 0.00, 0.00, 0.00,  5500.00, 'pending', NULL,   NOW(),                      NULL),
(2, 2,  1200.00, 0.00, 0.00, 0.00,  1200.00, 'pending', NULL,   NOW(),                      NULL),
(3, 3, 18000.00, 0.00, 0.00, 0.00, 18000.00, 'pending', NULL,   NOW(),                      NULL);

-- ── Insurance claim ────────────────────────────────────────────────
INSERT INTO insurance_claims (invoice_id, provider_name, policy_number, claim_amount, approved_amount, claim_status, submitted_on, resolved_on) VALUES
(2, 'Star Health Insurance', 'SHI-POL-2024-88712', 2000.00, 2000.00, 'paid', '2026-03-17', '2026-03-28');

-- ── ML predictions ─────────────────────────────────────────────────
INSERT INTO ml_predictions (appointment_id, model_name, model_version, prediction_score, prediction_label, feature_snapshot) VALUES
(1, 'no_show_xgboost', '2.1', 0.2350, 'show',    '{"lead_time_days":9,"prior_no_shows":0,"age":36,"distance_km":4.2,"reminder_sent":0,"has_insurance":1,"day_of_week":"wednesday","treatment_category":"restorative"}'),
(2, 'no_show_xgboost', '2.1', 0.0670, 'show',    '{"lead_time_days":10,"prior_no_shows":0,"age":41,"distance_km":6.8,"reminder_sent":1,"has_insurance":1,"day_of_week":"friday","treatment_category":"restorative"}'),
(3, 'no_show_xgboost', '2.1', 0.0510, 'show',    '{"lead_time_days":14,"prior_no_shows":0,"age":26,"distance_km":2.1,"reminder_sent":1,"has_insurance":0,"day_of_week":"tuesday","treatment_category":"orthodontic"}');


-- ================================================================
--  PART C: SQLITE SCHEMA  (used by server.py — zero config)
--  Run with: python3 server.py  (auto-creates on first run)
-- ================================================================

/*
CREATE TABLE users (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'patient',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE patients (
    patient_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(user_id),
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    date_of_birth TEXT,
    gender        TEXT,
    phone         TEXT NOT NULL,
    address       TEXT,
    blood_group   TEXT,
    allergies     TEXT,
    medical_notes TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE doctors (
    doctor_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER REFERENCES users(user_id),
    first_name       TEXT    NOT NULL,
    last_name        TEXT    NOT NULL,
    specialisation   TEXT    NOT NULL,
    license_number   TEXT    NOT NULL UNIQUE,
    phone            TEXT    NOT NULL,
    consultation_fee REAL    DEFAULT 0,
    is_available     INTEGER DEFAULT 1,
    created_at       TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE treatments (
    treatment_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    treatment_name TEXT    NOT NULL UNIQUE,
    category       TEXT    NOT NULL,
    description    TEXT,
    base_cost      REAL    NOT NULL,
    duration_mins  INTEGER DEFAULT 30,
    is_active      INTEGER DEFAULT 1
);

CREATE TABLE appointments (
    appointment_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id          INTEGER NOT NULL REFERENCES patients(patient_id),
    doctor_id           INTEGER NOT NULL REFERENCES doctors(doctor_id),
    scheduled_at        TEXT    NOT NULL,
    duration_mins       INTEGER DEFAULT 30,
    status              TEXT    DEFAULT 'scheduled',
    reason              TEXT,
    notes               TEXT,
    no_show_probability REAL,
    risk_level          TEXT,
    recommended_action  TEXT,
    reminder_sent       INTEGER DEFAULT 0,
    created_at          TEXT    DEFAULT (datetime('now')),
    updated_at          TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE invoices (
    invoice_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id  INTEGER REFERENCES appointments(appointment_id),
    patient_id      INTEGER NOT NULL REFERENCES patients(patient_id),
    subtotal        REAL    NOT NULL,
    discount        REAL    DEFAULT 0,
    tax_amount      REAL    DEFAULT 0,
    total_amount    REAL    NOT NULL,
    payment_status  TEXT    DEFAULT 'pending',
    payment_method  TEXT,
    issued_at       TEXT    DEFAULT (datetime('now')),
    paid_at         TEXT
);

CREATE TABLE ml_predictions (
    prediction_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id   INTEGER REFERENCES appointments(appointment_id),
    model_name       TEXT,
    model_version    TEXT,
    prediction_score REAL,
    prediction_label TEXT,
    predicted_at     TEXT DEFAULT (datetime('now'))
);
*/


-- ================================================================
--  PART D: USEFUL QUERIES
-- ================================================================

-- All upcoming appointments with risk level
-- SELECT patient_name, doctor_name, scheduled_at, status, risk_level,
--        ROUND(no_show_probability * 100, 1) || '%' AS no_show_pct
-- FROM v_upcoming_appointments
-- ORDER BY no_show_probability DESC NULLS LAST;

-- High-risk appointments needing a phone call
-- SELECT * FROM v_upcoming_appointments
-- WHERE no_show_probability >= 0.60
-- ORDER BY scheduled_at;

-- Full invoice breakdown for a patient
-- SELECT i.invoice_id, i.total_amount, i.payment_status,
--        t.treatment_name, at2.quantity, at2.unit_cost
-- FROM invoices i
-- JOIN appointment_treatments at2 ON at2.appointment_id = i.appointment_id
-- JOIN treatments t ON t.treatment_id = at2.treatment_id
-- WHERE i.patient_id = 1;

-- Revenue by month
-- SELECT * FROM v_monthly_revenue LIMIT 12;

-- Doctor workload this week
-- SELECT d.first_name || ' ' || d.last_name AS doctor,
--        COUNT(*) AS appointments_this_week
-- FROM appointments a
-- JOIN doctors d ON d.doctor_id = a.doctor_id
-- WHERE a.scheduled_at BETWEEN DATE_TRUNC('week', NOW())
--   AND DATE_TRUNC('week', NOW()) + INTERVAL '7 days'
--   AND a.status NOT IN ('cancelled')
-- GROUP BY d.doctor_id, doctor
-- ORDER BY appointments_this_week DESC;

-- Top treatments by revenue
-- SELECT * FROM v_treatment_stats LIMIT 10;

-- Patient visit history
-- SELECT a.scheduled_at, a.status, a.reason,
--        d.first_name || ' ' || d.last_name AS doctor,
--        t.treatment_name, at2.unit_cost
-- FROM appointments a
-- JOIN doctors d ON d.doctor_id = a.doctor_id
-- LEFT JOIN appointment_treatments at2 ON at2.appointment_id = a.appointment_id
-- LEFT JOIN treatments t ON t.treatment_id = at2.treatment_id
-- WHERE a.patient_id = 1
-- ORDER BY a.scheduled_at DESC;

-- Outstanding invoices older than 30 days
-- SELECT i.invoice_id, p.first_name || ' ' || p.last_name AS patient,
--        i.total_amount, i.issued_at,
--        CURRENT_DATE - i.issued_at::DATE AS days_overdue
-- FROM invoices i
-- JOIN patients p ON p.patient_id = i.patient_id
-- WHERE i.payment_status IN ('pending', 'overdue')
--   AND i.issued_at < NOW() - INTERVAL '30 days'
-- ORDER BY days_overdue DESC;

-- ML prediction accuracy check (requires actual outcome)
-- SELECT
--   COUNT(*) FILTER (WHERE no_show_probability >= 0.35 AND status = 'no_show') AS true_positives,
--   COUNT(*) FILTER (WHERE no_show_probability < 0.35  AND status = 'no_show') AS false_negatives,
--   COUNT(*) FILTER (WHERE no_show_probability >= 0.35 AND status = 'completed') AS false_positives,
--   COUNT(*) FILTER (WHERE no_show_probability < 0.35  AND status = 'completed') AS true_negatives
-- FROM appointments
-- WHERE no_show_probability IS NOT NULL
--   AND status IN ('no_show','completed');

-- ================================================================
--  END OF FILE
-- ================================================================
