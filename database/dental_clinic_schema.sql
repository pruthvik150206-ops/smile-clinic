-- ============================================================
--  DENTAL CLINIC DATABASE MANAGEMENT SYSTEM
--  Full Schema  |  PostgreSQL 15+
--  Normalized to 3NF
-- ============================================================

-- ─────────────────────────────────────────────
--  EXTENSIONS
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid() if needed

-- ─────────────────────────────────────────────
--  ENUM TYPES
-- ─────────────────────────────────────────────
CREATE TYPE user_role          AS ENUM ('admin', 'doctor', 'receptionist', 'patient');
CREATE TYPE gender_type        AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
CREATE TYPE payment_status     AS ENUM ('pending', 'paid', 'partially_paid', 'overdue', 'waived');
CREATE TYPE payment_method     AS ENUM ('cash', 'card', 'upi', 'insurance', 'bank_transfer');
CREATE TYPE claim_status       AS ENUM ('submitted', 'under_review', 'approved', 'rejected', 'paid');
CREATE TYPE day_of_week        AS ENUM ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
CREATE TYPE treatment_category AS ENUM ('preventive', 'restorative', 'cosmetic', 'orthodontic', 'surgical', 'diagnostic');


-- ============================================================
--  TABLE 1: users
--  Central auth table; role-based. Profiles live in
--  separate tables to avoid partial/transitive deps (3NF).
-- ============================================================
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


-- ============================================================
--  TABLE 2: patients
--  One patient profile per user (1:1 with users for role=patient).
--  Medical data separated from auth data — satisfies 3NF.
-- ============================================================
CREATE TABLE patients (
    patient_id    SERIAL          PRIMARY KEY,
    user_id       INT             NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    first_name    VARCHAR(80)     NOT NULL,
    last_name     VARCHAR(80)     NOT NULL,
    date_of_birth DATE            NOT NULL,
    gender        gender_type     NOT NULL,
    phone         VARCHAR(20)     NOT NULL,
    address       TEXT,
    city          VARCHAR(80),
    pincode       VARCHAR(10),
    blood_group   VARCHAR(5),
    allergies     TEXT,                        -- free-text; structured in medical_history table if needed
    medical_notes TEXT,
    emergency_contact_name  VARCHAR(100),
    emergency_contact_phone VARCHAR(20),
    created_at    TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP       NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_patients_dob   CHECK (date_of_birth < CURRENT_DATE),
    CONSTRAINT chk_patients_phone CHECK (phone ~ '^[0-9+\-() ]{7,20}$')
);

CREATE INDEX idx_patients_user_id   ON patients(user_id);
CREATE INDEX idx_patients_last_name ON patients(last_name);
CREATE INDEX idx_patients_phone     ON patients(phone);


-- ============================================================
--  TABLE 3: doctors
--  One doctor profile per user (1:1 with users for role=doctor).
--  Specialisation, license, fee are doctor-specific — 3NF clean.
-- ============================================================
CREATE TABLE doctors (
    doctor_id        SERIAL          PRIMARY KEY,
    user_id          INT             NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    first_name       VARCHAR(80)     NOT NULL,
    last_name        VARCHAR(80)     NOT NULL,
    specialisation   VARCHAR(100)    NOT NULL,
    license_number   VARCHAR(50)     NOT NULL UNIQUE,
    phone            VARCHAR(20)     NOT NULL,
    consultation_fee DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
    bio              TEXT,
    is_available     BOOLEAN         NOT NULL DEFAULT TRUE,
    joined_date      DATE            NOT NULL DEFAULT CURRENT_DATE,
    created_at       TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP       NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_doctors_fee CHECK (consultation_fee >= 0)
);

CREATE INDEX idx_doctors_user_id       ON doctors(user_id);
CREATE INDEX idx_doctors_specialisation ON doctors(specialisation);


-- ============================================================
--  TABLE 4: doctor_availability
--  Separated from doctors — day/time slots are multi-valued
--  and do not functionally depend on doctor attributes (3NF).
-- ============================================================
CREATE TABLE doctor_availability (
    availability_id SERIAL       PRIMARY KEY,
    doctor_id       INT          NOT NULL REFERENCES doctors(doctor_id) ON DELETE CASCADE,
    day_of_week     day_of_week  NOT NULL,
    slot_start      TIME         NOT NULL,
    slot_end        TIME         NOT NULL,
    max_appointments INT         NOT NULL DEFAULT 10,

    CONSTRAINT chk_avail_time    CHECK (slot_end > slot_start),
    CONSTRAINT uq_avail_slot     UNIQUE (doctor_id, day_of_week, slot_start)
);

CREATE INDEX idx_avail_doctor ON doctor_availability(doctor_id);


-- ============================================================
--  TABLE 5: treatments
--  Treatment catalogue — independent entity.
--  base_cost & description depend only on treatment_id (3NF).
-- ============================================================
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


-- ============================================================
--  TABLE 6: appointments
--  Core scheduling entity. Links patient ↔ doctor.
--  Stores ML no-show probability score as a denormalized
--  cache (updated by ML service).
-- ============================================================
CREATE TABLE appointments (
    appointment_id      SERIAL              PRIMARY KEY,
    patient_id          INT                 NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    doctor_id           INT                 NOT NULL REFERENCES doctors(doctor_id)   ON DELETE RESTRICT,
    scheduled_at        TIMESTAMP           NOT NULL,
    duration_mins       INT                 NOT NULL DEFAULT 30,
    status              appointment_status  NOT NULL DEFAULT 'scheduled',
    reason              TEXT,
    notes               TEXT,                         -- doctor's post-visit notes
    no_show_probability DECIMAL(5,4)        DEFAULT NULL,  -- ML score 0.0000 – 1.0000
    reminder_sent       BOOLEAN             NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP           NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP           NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_appt_scheduled  CHECK (scheduled_at > created_at - INTERVAL '1 minute'),
    CONSTRAINT chk_appt_duration   CHECK (duration_mins > 0),
    CONSTRAINT chk_appt_no_show    CHECK (no_show_probability IS NULL OR
                                          no_show_probability BETWEEN 0 AND 1)
);

CREATE INDEX idx_appts_patient     ON appointments(patient_id);
CREATE INDEX idx_appts_doctor      ON appointments(doctor_id);
CREATE INDEX idx_appts_scheduled   ON appointments(scheduled_at);
CREATE INDEX idx_appts_status      ON appointments(status);


-- ============================================================
--  TABLE 7: appointment_treatments  (bridge / junction table)
--  Resolves M:N between appointments and treatments.
--  unit_cost may differ from treatment.base_cost (discounts,
--  custom pricing) — depends only on this row's PK (3NF).
-- ============================================================
CREATE TABLE appointment_treatments (
    apt_treatment_id SERIAL         PRIMARY KEY,
    appointment_id   INT            NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    treatment_id     INT            NOT NULL REFERENCES treatments(treatment_id)     ON DELETE RESTRICT,
    quantity         INT            NOT NULL DEFAULT 1,
    unit_cost        DECIMAL(10,2)  NOT NULL,
    notes            TEXT,

    CONSTRAINT uq_apt_treatment  UNIQUE (appointment_id, treatment_id),
    CONSTRAINT chk_at_qty        CHECK (quantity > 0),
    CONSTRAINT chk_at_cost       CHECK (unit_cost >= 0)
);

CREATE INDEX idx_apt_treatments_appt      ON appointment_treatments(appointment_id);
CREATE INDEX idx_apt_treatments_treatment ON appointment_treatments(treatment_id);


-- ============================================================
--  TABLE 8: invoices
--  One invoice per appointment. Financial summary.
--  Subtotal, tax, discount are computed at generation time
--  and stored for audit immutability.
-- ============================================================
CREATE TABLE invoices (
    invoice_id     SERIAL          PRIMARY KEY,
    appointment_id INT             NOT NULL UNIQUE REFERENCES appointments(appointment_id) ON DELETE RESTRICT,
    patient_id     INT             NOT NULL REFERENCES patients(patient_id)    ON DELETE RESTRICT,
    subtotal       DECIMAL(12,2)   NOT NULL,
    discount       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    tax_rate       DECIMAL(5,4)    NOT NULL DEFAULT 0.18,   -- 18% GST default
    tax_amount     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    total_amount   DECIMAL(12,2)   NOT NULL,
    payment_status payment_status  NOT NULL DEFAULT 'pending',
    payment_method payment_method,
    notes          TEXT,
    issued_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
    paid_at        TIMESTAMP,
    due_date       DATE            NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days'),

    CONSTRAINT chk_inv_subtotal  CHECK (subtotal >= 0),
    CONSTRAINT chk_inv_discount  CHECK (discount >= 0 AND discount <= subtotal),
    CONSTRAINT chk_inv_tax       CHECK (tax_amount >= 0),
    CONSTRAINT chk_inv_total     CHECK (total_amount >= 0),
    CONSTRAINT chk_inv_paid_at   CHECK (paid_at IS NULL OR paid_at >= issued_at)
);

CREATE INDEX idx_invoices_patient ON invoices(patient_id);
CREATE INDEX idx_invoices_status  ON invoices(payment_status);
CREATE INDEX idx_invoices_issued  ON invoices(issued_at);


-- ============================================================
--  TABLE 9: insurance_claims
--  Separated from invoices — claim attributes (provider,
--  policy, status) depend only on claim_id, not on invoice (3NF).
--  One invoice may have multiple claims (primary + secondary).
-- ============================================================
CREATE TABLE insurance_claims (
    claim_id       SERIAL        PRIMARY KEY,
    invoice_id     INT           NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
    provider_name  VARCHAR(150)  NOT NULL,
    policy_number  VARCHAR(80)   NOT NULL,
    claim_amount   DECIMAL(12,2) NOT NULL,
    approved_amount DECIMAL(12,2) DEFAULT NULL,
    claim_status   claim_status  NOT NULL DEFAULT 'submitted',
    submitted_on   DATE          NOT NULL DEFAULT CURRENT_DATE,
    resolved_on    DATE,
    rejection_reason TEXT,

    CONSTRAINT chk_claim_amount    CHECK (claim_amount > 0),
    CONSTRAINT chk_claim_approved  CHECK (approved_amount IS NULL OR approved_amount >= 0),
    CONSTRAINT chk_claim_resolved  CHECK (resolved_on IS NULL OR resolved_on >= submitted_on)
);

CREATE INDEX idx_claims_invoice ON insurance_claims(invoice_id);
CREATE INDEX idx_claims_status  ON insurance_claims(claim_status);


-- ============================================================
--  TABLE 10: ml_predictions
--  Stores every model inference — appointment-level.
--  feature_snapshot (JSONB) preserves the exact feature
--  vector used, enabling model auditing and retraining.
-- ============================================================
CREATE TABLE ml_predictions (
    prediction_id    SERIAL         PRIMARY KEY,
    appointment_id   INT            NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    model_name       VARCHAR(100)   NOT NULL,
    model_version    VARCHAR(20)    NOT NULL DEFAULT '1.0',
    prediction_score DECIMAL(5,4)   NOT NULL,
    prediction_label VARCHAR(50),                          -- e.g. 'no_show', 'show'
    feature_snapshot JSONB          NOT NULL DEFAULT '{}',
    predicted_at     TIMESTAMP      NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_ml_score CHECK (prediction_score BETWEEN 0 AND 1)
);

CREATE INDEX idx_ml_appointment ON ml_predictions(appointment_id);
CREATE INDEX idx_ml_model       ON ml_predictions(model_name);
CREATE INDEX idx_ml_snapshot    ON ml_predictions USING gin(feature_snapshot);


-- ============================================================
--  TRIGGERS: auto-update updated_at columns
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_doctors_updated  BEFORE UPDATE ON doctors  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_appts_updated    BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
--  VIEWS
-- ============================================================

-- Upcoming appointments with patient and doctor names
CREATE VIEW v_upcoming_appointments AS
SELECT
    a.appointment_id,
    a.scheduled_at,
    a.status,
    a.reason,
    a.no_show_probability,
    p.patient_id,
    p.first_name || ' ' || p.last_name  AS patient_name,
    p.phone                              AS patient_phone,
    d.doctor_id,
    d.first_name || ' ' || d.last_name  AS doctor_name,
    d.specialisation
FROM appointments a
JOIN patients p ON p.patient_id = a.patient_id
JOIN doctors  d ON d.doctor_id  = a.doctor_id
WHERE a.scheduled_at >= NOW()
  AND a.status NOT IN ('cancelled', 'no_show')
ORDER BY a.scheduled_at;

-- Revenue summary per month
CREATE VIEW v_monthly_revenue AS
SELECT
    DATE_TRUNC('month', issued_at)  AS month,
    COUNT(*)                         AS total_invoices,
    SUM(total_amount)                AS gross_revenue,
    SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) AS collected,
    SUM(CASE WHEN payment_status IN ('pending','overdue') THEN total_amount ELSE 0 END) AS outstanding
FROM invoices
GROUP BY 1
ORDER BY 1 DESC;

-- Most performed treatments
CREATE VIEW v_treatment_stats AS
SELECT
    t.treatment_id,
    t.treatment_name,
    t.category,
    COUNT(at2.apt_treatment_id)  AS times_performed,
    SUM(at2.unit_cost * at2.quantity) AS total_revenue
FROM treatments t
LEFT JOIN appointment_treatments at2 ON at2.treatment_id = t.treatment_id
GROUP BY t.treatment_id, t.treatment_name, t.category
ORDER BY times_performed DESC;


-- ============================================================
--  SAMPLE DATA
-- ============================================================

-- ─── users ───────────────────────────────────────────────────
INSERT INTO users (username, email, password_hash, role) VALUES
('admin_raj',      'raj.admin@smileclinic.in',    '$2b$12$admin_hash_placeholder_1',  'admin'),
('dr_priya',       'priya.sharma@smileclinic.in', '$2b$12$doctor_hash_placeholder_1', 'doctor'),
('dr_arjun',       'arjun.nair@smileclinic.in',   '$2b$12$doctor_hash_placeholder_2', 'doctor'),
('patient_meera',  'meera.patel@email.com',        '$2b$12$patient_hash_placeholder_1','patient'),
('patient_rahul',  'rahul.verma@email.com',        '$2b$12$patient_hash_placeholder_2','patient'),
('patient_sunita', 'sunita.rao@email.com',         '$2b$12$patient_hash_placeholder_3','patient'),
('receptionist_k', 'kavya@smileclinic.in',         '$2b$12$recept_hash_placeholder_1', 'receptionist');

-- ─── doctors ──────────────────────────────────────────────────
INSERT INTO doctors (user_id, first_name, last_name, specialisation, license_number, phone, consultation_fee) VALUES
(2, 'Priya',  'Sharma', 'General Dentistry',  'MCI-DEN-2018-04521', '+91-9876543210', 600.00),
(3, 'Arjun',  'Nair',   'Orthodontics',       'MCI-DEN-2016-03812', '+91-9876543211', 900.00);

-- ─── doctor_availability ──────────────────────────────────────
INSERT INTO doctor_availability (doctor_id, day_of_week, slot_start, slot_end) VALUES
(1, 'monday',    '09:00', '13:00'),
(1, 'monday',    '15:00', '18:00'),
(1, 'wednesday', '09:00', '13:00'),
(1, 'friday',    '09:00', '17:00'),
(2, 'tuesday',   '10:00', '14:00'),
(2, 'thursday',  '10:00', '14:00'),
(2, 'saturday',  '09:00', '13:00');

-- ─── patients ─────────────────────────────────────────────────
INSERT INTO patients (user_id, first_name, last_name, date_of_birth, gender, phone, address, city, pincode, blood_group, allergies) VALUES
(4, 'Meera',  'Patel',  '1990-03-15', 'female', '+91-9123456701', '12 MG Road',    'Bengaluru', '560001', 'O+', 'Penicillin'),
(5, 'Rahul',  'Verma',  '1985-07-22', 'male',   '+91-9123456702', '34 Brigade Rd', 'Bengaluru', '560025', 'B+', NULL),
(6, 'Sunita', 'Rao',    '2000-11-08', 'female', '+91-9123456703', '7 Indiranagar',  'Bengaluru', '560038', 'A-', 'Latex');

-- ─── treatments ───────────────────────────────────────────────
INSERT INTO treatments (treatment_name, category, description, base_cost, duration_mins) VALUES
('Dental Cleaning & Scaling',  'preventive',   'Removal of plaque and tartar using ultrasonic scaler',    800.00,  45),
('Composite Filling',          'restorative',  'Tooth-coloured resin filling for cavities',               1200.00, 30),
('Root Canal Treatment',       'restorative',  'Removal of infected pulp; canal cleaning and filling',    5500.00, 90),
('Tooth Extraction (simple)',  'surgical',     'Removal of a non-impacted tooth under local anaesthesia', 700.00,  30),
('Teeth Whitening (laser)',    'cosmetic',     'In-office laser whitening for 2–3 shade improvement',     3500.00, 60),
('Dental X-Ray (OPG)',         'diagnostic',   'Full-mouth orthopantomogram digital radiograph',           600.00,  15),
('Metal Braces (per arch)',    'orthodontic',  'Standard stainless steel braces, one arch',              18000.00, 60),
('Pit & Fissure Sealant',      'preventive',   'Protective sealant applied to molars to prevent decay',   400.00,  20),
('Porcelain Crown',            'restorative',  'Full ceramic crown fabricated and cemented',              7500.00, 60),
('Gum Flap Surgery',           'surgical',     'Periodontal surgery for advanced gum disease',            8000.00, 90);

-- ─── appointments ─────────────────────────────────────────────
INSERT INTO appointments (patient_id, doctor_id, scheduled_at, duration_mins, status, reason, no_show_probability) VALUES
(1, 1, '2026-05-10 10:00:00', 45,  'completed',  'Routine cleaning and checkup',            0.0820),
(2, 1, '2026-05-12 11:30:00', 30,  'completed',  'Sensitivity in lower right molar',        0.1140),
(3, 2, '2026-05-13 10:30:00', 60,  'completed',  'Braces consultation and OPG',             0.0430),
(1, 1, '2026-05-20 09:00:00', 90,  'scheduled',  'Root canal – upper left first molar',     0.2350),
(2, 1, '2026-05-22 10:00:00', 30,  'scheduled',  'Filling follow-up',                       0.0670),
(3, 2, '2026-05-27 11:00:00', 60,  'scheduled',  'Braces fitting – upper arch',             0.0510);

-- ─── appointment_treatments ───────────────────────────────────
INSERT INTO appointment_treatments (appointment_id, treatment_id, quantity, unit_cost) VALUES
(1, 1, 1, 800.00),   -- Meera: cleaning
(1, 6, 1, 600.00),   -- Meera: OPG x-ray
(2, 2, 2, 1200.00),  -- Rahul: 2 fillings
(2, 6, 1, 600.00),   -- Rahul: OPG
(3, 6, 1, 600.00),   -- Sunita: OPG for consultation
(4, 3, 1, 5500.00),  -- Meera: RCT (upcoming)
(5, 2, 1, 1200.00),  -- Rahul: filling follow-up
(6, 7, 1, 18000.00); -- Sunita: upper arch braces

-- ─── invoices ─────────────────────────────────────────────────
INSERT INTO invoices (appointment_id, patient_id, subtotal, discount, tax_rate, tax_amount, total_amount, payment_status, payment_method, paid_at) VALUES
(1, 1,  1400.00, 0.00,   0.00, 0.00,   1400.00, 'paid',    'upi',      '2026-05-10 11:00:00'),
(2, 2,  3000.00, 200.00, 0.00, 0.00,   2800.00, 'paid',    'card',     '2026-05-12 12:30:00'),
(3, 3,   600.00, 0.00,   0.00, 0.00,    600.00, 'paid',    'cash',     '2026-05-13 11:45:00');

-- ─── insurance_claims ─────────────────────────────────────────
INSERT INTO insurance_claims (invoice_id, provider_name, policy_number, claim_amount, claim_status, submitted_on) VALUES
(2, 'Star Health Insurance', 'SHI-POL-2024-88712', 2000.00, 'approved',   '2026-05-13'),
(2, 'Star Health Insurance', 'SHI-POL-2024-88712',  800.00, 'paid',       '2026-05-13');

-- ─── ml_predictions ───────────────────────────────────────────
INSERT INTO ml_predictions (appointment_id, model_name, model_version, prediction_score, prediction_label, feature_snapshot) VALUES
(1, 'no_show_xgboost', '2.1', 0.0820, 'show',    '{"day_of_week":"saturday","hour":10,"lead_time_days":3,"prior_no_shows":0,"age":36,"distance_km":4.2}'),
(2, 'no_show_xgboost', '2.1', 0.1140, 'show',    '{"day_of_week":"monday","hour":11,"lead_time_days":5,"prior_no_shows":0,"age":41,"distance_km":6.8}'),
(3, 'no_show_xgboost', '2.1', 0.0430, 'show',    '{"day_of_week":"tuesday","hour":10,"lead_time_days":2,"prior_no_shows":0,"age":26,"distance_km":2.1}'),
(4, 'no_show_xgboost', '2.1', 0.2350, 'show',    '{"day_of_week":"wednesday","hour":9,"lead_time_days":15,"prior_no_shows":0,"age":36,"distance_km":4.2}'),
(5, 'no_show_xgboost', '2.1', 0.0670, 'show',    '{"day_of_week":"friday","hour":10,"lead_time_days":10,"prior_no_shows":0,"age":41,"distance_km":6.8}'),
(6, 'no_show_xgboost', '2.1', 0.0510, 'show',    '{"day_of_week":"tuesday","hour":11,"lead_time_days":14,"prior_no_shows":0,"age":26,"distance_km":2.1}');


-- ============================================================
--  USEFUL QUERIES (for reference)
-- ============================================================

-- All upcoming appointments with high no-show risk (>20%)
-- SELECT * FROM v_upcoming_appointments WHERE no_show_probability > 0.20;

-- Full invoice breakdown for a patient
-- SELECT i.invoice_id, i.total_amount, i.payment_status,
--        t.treatment_name, at2.quantity, at2.unit_cost
-- FROM invoices i
-- JOIN appointment_treatments at2 ON at2.appointment_id = i.appointment_id
-- JOIN treatments t ON t.treatment_id = at2.treatment_id
-- WHERE i.patient_id = 1;

-- Doctor workload this week
-- SELECT d.first_name || ' ' || d.last_name AS doctor,
--        COUNT(*) AS appointments_this_week
-- FROM appointments a
-- JOIN doctors d ON d.doctor_id = a.doctor_id
-- WHERE a.scheduled_at BETWEEN DATE_TRUNC('week', NOW()) AND DATE_TRUNC('week', NOW()) + INTERVAL '7 days'
--   AND a.status NOT IN ('cancelled')
-- GROUP BY d.doctor_id, doctor;

-- Monthly revenue
-- SELECT * FROM v_monthly_revenue LIMIT 12;

-- ============================================================
--  END OF SCHEMA
-- ============================================================
