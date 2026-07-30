"""
SmileClinic DMS — All-in-one Python Server
==========================================
• Auth  : JWT-style tokens (HMAC-SHA256, no external lib)
• DB    : SQLite  (zero config, file-based)
• REST  : stdlib http.server — full CRUD for all entities
• ML    : scikit-learn no-show prediction (model loaded from .pkl)
• Static: serves the React SPA from ./static/

Run:  python3 server.py
Open: http://localhost:5000
"""

import http.server, json, sqlite3, hashlib, hmac, base64, time, threading, sys
import pathlib, os, re, struct, random, math
from urllib.parse import urlparse, parse_qs, unquote

# ── Config ────────────────────────────────────────────────────────────────────
PORT       = int(os.environ.get("PORT", 8080))
SECRET     = os.environ.get("JWT_SECRET", "smileclinic_dev_secret")
BASE       = pathlib.Path(__file__).parent
DB_PATH    = BASE / "database" / "clinic.db"
MODEL_PATH = BASE / "ml" / "models" / "no_show_model.pkl"
META_PATH  = BASE / "ml" / "models" / "model_meta.json"
STATIC_DIR = BASE / "frontend" / "static"

# ── ML setup ──────────────────────────────────────────────────────────────────
ML_MODEL = None
ML_META  = {}
try:
    import joblib, pandas as pd, numpy as np
    ML_MODEL = joblib.load(MODEL_PATH)
    with open(META_PATH) as f:
        ML_META = json.load(f)
    print(f"✅ ML model loaded — AUC {ML_META.get('test_metrics',{}).get('roc_auc','?')}")
except Exception as e:
    print(f"⚠️  ML model not loaded ({e}) — predictions will use fallback formula")

THRESHOLD = ML_META.get("optimal_threshold", 0.23)
FEATURES  = ML_META.get("features", [
    "lead_time_days","prior_no_shows","appointment_hour","age","distance_km",
    "treatment_cost","previous_appointments","month","reminder_sent",
    "has_insurance","is_follow_up","day_of_week","treatment_category","gender"
])

def ml_predict(features: dict) -> dict:
    """Run model or fall back to logistic formula."""
    prob = None
    if ML_MODEL is not None:
        try:
            import pandas as pd
            row = {f: features.get(f, 0) for f in FEATURES}
            df  = pd.DataFrame([row])
            prob = float(ML_MODEL.predict_proba(df)[0][1])
        except Exception as e:
            print(f"  ML inference error: {e}")

    if prob is None:
        # Fallback logistic formula (mirrors training)
        s  = -1.5
        s += 0.045  * features.get("lead_time_days", 10)
        s += 0.55   * features.get("prior_no_shows", 0)
        s += 0.0045 * max(0, 35 - features.get("age", 35))
        s += 0.030  * features.get("distance_km", 5)
        s -= 0.65   * features.get("reminder_sent", 0)
        s -= 0.00008* features.get("treatment_cost", 1000)
        s -= 0.40   * features.get("has_insurance", 0)
        s -= 0.30   * min(features.get("previous_appointments", 0), 8) / 8
        s += 0.25   * (1 - features.get("is_follow_up", 0))
        day_e = {"monday":0.15,"friday":0.20,"saturday":0.25,"tuesday":-0.05,"wednesday":-0.10,"thursday":-0.05}
        s += day_e.get(features.get("day_of_week","monday"), 0)
        h = features.get("appointment_hour", 10)
        if h <= 9: s += 0.20
        elif h >= 17: s += 0.15
        cat_e = {"cosmetic":0.25,"preventive":0.10,"restorative":-0.05,"surgical":-0.30,"diagnostic":0.05,"orthodontic":-0.10}
        s += cat_e.get(features.get("treatment_category","restorative"), 0)
        prob = max(0.01, min(0.99, 1 / (1 + math.exp(-s))))

    label = "no_show" if prob >= THRESHOLD else "show"
    risk  = "High" if prob >= 0.60 else ("Medium" if prob >= 0.35 else "Low")
    action = {
        "High":   "Call patient to confirm — consider double-booking",
        "Medium": "Send SMS reminder 24 h before appointment",
        "Low":    "Standard automated reminder is sufficient",
    }[risk]
    margin = abs(prob - THRESHOLD)
    confidence = "high" if margin >= 0.20 else ("medium" if margin >= 0.08 else "low")

    return {
        "no_show_probability": round(prob, 4),
        "risk_level": risk,
        "label": label,
        "confidence": confidence,
        "recommended_action": action,
        "model_version": ML_META.get("model_version", "2.1"),
        "threshold_used": THRESHOLD,
    }

# ── JWT (pure stdlib HMAC-SHA256) ─────────────────────────────────────────────
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def _b64url_dec(s: str) -> bytes:
    pad = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * (pad % 4))

def jwt_sign(payload: dict, exp_secs: int = 3600 * 8) -> str:
    header  = _b64url(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
    payload = dict(payload, exp=int(time.time()) + exp_secs, iat=int(time.time()))
    body    = _b64url(json.dumps(payload).encode())
    sig     = _b64url(hmac.new(SECRET.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"

def jwt_verify(token: str):
    try:
        h, b, s = token.split(".")
        expected = _b64url(hmac.new(SECRET.encode(), f"{h}.{b}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(s, expected):
            return None
        payload = json.loads(_b64url_dec(b))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None

def hash_pw(pw: str) -> str:
    return hashlib.sha256((pw + SECRET).encode()).hexdigest()

# ── Database ──────────────────────────────────────────────────────────────────
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

def get_db():
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con

def init_db():
    con = get_db()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'patient',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS patients (
        patient_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(user_id),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        date_of_birth TEXT,
        gender TEXT,
        phone TEXT NOT NULL,
        address TEXT,
        blood_group TEXT,
        allergies TEXT,
        medical_notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS doctors (
        doctor_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(user_id),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        specialisation TEXT NOT NULL,
        qualification TEXT DEFAULT 'BDS',
        license_number TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        consultation_fee REAL DEFAULT 0,
        is_available INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS treatments (
        treatment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        treatment_name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        description TEXT,
        base_cost REAL NOT NULL,
        duration_mins INTEGER DEFAULT 30,
        is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS appointments (
        appointment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(patient_id),
        doctor_id INTEGER NOT NULL REFERENCES doctors(doctor_id),
        scheduled_at TEXT NOT NULL,
        duration_mins INTEGER DEFAULT 30,
        status TEXT DEFAULT 'scheduled',
        reason TEXT,
        notes TEXT,
        no_show_probability REAL,
        risk_level TEXT,
        recommended_action TEXT,
        priority TEXT DEFAULT 'normal',
        reminder_sent INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invoices (
        invoice_id INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id INTEGER REFERENCES appointments(appointment_id),
        patient_id INTEGER NOT NULL REFERENCES patients(patient_id),
        subtotal REAL NOT NULL,
        discount REAL DEFAULT 0,
        tax_amount REAL DEFAULT 0,
        total_amount REAL NOT NULL,
        payment_status TEXT DEFAULT 'pending',
        payment_method TEXT,
        issued_at TEXT DEFAULT (datetime('now')),
        paid_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ml_predictions (
        prediction_id INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id INTEGER REFERENCES appointments(appointment_id),
        model_name TEXT,
        model_version TEXT,
        prediction_score REAL,
        prediction_label TEXT,
        predicted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prescriptions (
        prescription_id INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id INTEGER REFERENCES appointments(appointment_id),
        patient_id INTEGER NOT NULL REFERENCES patients(patient_id),
        doctor_id INTEGER NOT NULL REFERENCES doctors(doctor_id),
        diagnosis TEXT,
        medications TEXT NOT NULL,
        advice TEXT,
        issued_at TEXT DEFAULT (datetime('now'))
    );
    """)
    con.commit()
    # Add priority column to existing DBs (safe migration)
    try:
        con.execute("ALTER TABLE appointments ADD COLUMN priority TEXT DEFAULT 'normal'")
        con.commit()
    except Exception:
        pass  # column already exists

    try:
        con.execute("ALTER TABLE doctors ADD COLUMN qualification TEXT DEFAULT 'BDS'")
        con.commit()
    except Exception:
        pass  # column already exists


    try:
        con.execute("ALTER TABLE users ADD COLUMN raw_password TEXT")
        con.commit()
    except Exception:
        pass  # column already exists

    # Populate raw_password for seed accounts if null
    con.execute("UPDATE users SET raw_password='admin123' WHERE email='admin@smile.in' AND (raw_password IS NULL OR raw_password='')")
    con.execute("UPDATE users SET raw_password='doctor123' WHERE email='doctor@smile.in' AND (raw_password IS NULL OR raw_password='')")
    con.execute("UPDATE users SET raw_password='arjun123' WHERE email='arjun@smile.in' AND (raw_password IS NULL OR raw_password='')")
    con.execute("UPDATE users SET raw_password='recept123' WHERE email='recept@smile.in' AND (raw_password IS NULL OR raw_password='')")
    con.execute("UPDATE users SET raw_password='patient123' WHERE email='meera@patient.in' AND (raw_password IS NULL OR raw_password='')")
    con.execute("UPDATE users SET raw_password='patient123' WHERE email='rahul@patient.in' AND (raw_password IS NULL OR raw_password='')")
    con.execute("UPDATE users SET raw_password='patient123' WHERE role='patient' AND (raw_password IS NULL OR raw_password='')")
    con.commit()

    # Seed data if empty
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        users = [
            ("admin",      "admin@smile.in",    hash_pw("admin123"),   "admin123",   "admin"),
            ("dr_priya",   "doctor@smile.in",   hash_pw("doctor123"),  "doctor123",  "doctor"),
            ("dr_arjun",   "arjun@smile.in",    hash_pw("arjun123"),   "arjun123",   "doctor"),
            ("kavya_recep","recept@smile.in",   hash_pw("recept123"),  "recept123",  "receptionist"),
            ("meera_p",    "meera@patient.in",  hash_pw("patient123"), "patient123", "patient"),
            ("rahul_v",    "rahul@patient.in",  hash_pw("patient123"), "patient123", "patient"),
        ]
        con.executemany("INSERT INTO users(username,email,password_hash,raw_password,role) VALUES(?,?,?,?,?)", users)
        con.executemany("""INSERT INTO doctors(user_id,first_name,last_name,specialisation,license_number,phone,consultation_fee)
            VALUES(?,?,?,?,?,?,?)""", [
            (2,"Priya","Sharma","General Dentistry","MCI-DEN-2018-04521","+91-9876543210",600),
            (3,"Arjun","Nair","Orthodontics","MCI-DEN-2016-03812","+91-9876543211",900),
        ])
        con.executemany("""INSERT INTO patients(user_id,first_name,last_name,date_of_birth,gender,phone,blood_group,allergies)
            VALUES(?,?,?,?,?,?,?,?)""", [
            (5,"Meera","Patel","1990-03-15","female","+91-9123456701","O+","Penicillin"),
            (6,"Rahul","Verma","1985-07-22","male",  "+91-9123456702","B+","None"),
        ])
        treatments = [
            ("Dental Cleaning & Scaling","preventive","Scaling and polishing",800,45),
            ("Composite Filling","restorative","Tooth-coloured resin filling",1200,30),
            ("Root Canal Treatment","restorative","Removal of infected pulp",5500,90),
            ("Tooth Extraction","surgical","Simple extraction under local anaesthesia",700,30),
            ("Teeth Whitening","cosmetic","In-office laser whitening",3500,60),
            ("Dental X-Ray (OPG)","diagnostic","Full-mouth radiograph",600,15),
            ("Metal Braces","orthodontic","Standard stainless steel braces",18000,60),
            ("Porcelain Crown","restorative","Full ceramic crown",7500,60),
        ]
        con.executemany("INSERT INTO treatments(treatment_name,category,description,base_cost,duration_mins) VALUES(?,?,?,?,?)", treatments)
        appointments_data = [
            (1,1,"2026-05-20 09:00","scheduled","Root canal — upper left molar",90),
            (2,1,"2026-05-22 10:00","confirmed","Filling follow-up",30),
            (1,2,"2026-05-27 11:00","scheduled","Braces consultation",60),
            (2,1,"2026-04-10 14:00","completed","Routine cleaning",45),
        ]
        for p,d,s,st,r,dur in appointments_data:
            con.execute("""INSERT INTO appointments(patient_id,doctor_id,scheduled_at,status,reason,duration_mins)
                VALUES(?,?,?,?,?,?)""",(p,d,s,st,r,dur))
        invoices_data = [
            (1,1,1,1400,0,0,1400,"paid","UPI"),
            (2,1,2,2800,200,0,2600,"paid","Card"),
            (3,2,1,600,0,0,600,"pending",None),
        ]
        for appt_id,pat_id,_x,sub,disc,tax,tot,ps,pm in invoices_data:
            con.execute("INSERT INTO invoices(appointment_id,patient_id,subtotal,discount,tax_amount,total_amount,payment_status,payment_method) VALUES(?,?,?,?,?,?,?,?)",
                (appt_id,pat_id,sub,disc,tax,tot,ps,pm))
        con.commit()
        print("✅ Database seeded with demo data")

    # Seed prescriptions if none exist
    if con.execute("SELECT COUNT(*) FROM prescriptions").fetchone()[0] == 0:
        rx_data = [
            (3, 1, 2, "Acute Pulpitis — Upper Left Molar", json.dumps([
                {"name": "Amoxicillin 500mg", "dosage": "1 capsule", "frequency": "Thrice daily (after meals)", "duration": "5 days", "instructions": "Complete full antibiotic course"},
                {"name": "Paracetamol 650mg", "dosage": "1 tablet", "frequency": "Twice daily (SOS for pain)", "duration": "3 days", "instructions": "Take after food"},
                {"name": "Chlorhexidine 0.2% Mouthwash", "dosage": "10 ml", "frequency": "Twice daily", "duration": "7 days", "instructions": "Rinse vigorously for 60 seconds"}
            ]), "Avoid hot/cold drinks. Maintain soft diet. Follow up for root canal step 2 next week."),
            (2, 2, 1, "Dental Plaque & Mild Gingivitis", json.dumps([
                {"name": "Metronidazole 400mg", "dosage": "1 tablet", "frequency": "Twice daily", "duration": "5 days", "instructions": "Take with meals"},
                {"name": "Sensodyne Rapid Relief Toothpaste", "dosage": "Pea size", "frequency": "Twice daily", "duration": "14 days", "instructions": "Use extra soft toothbrush"}
            ]), "Perform warm saline mouth rinse 3 times daily. Floss daily at bedtime.")
        ]
        for appt, pat, doc, diag, meds, adv in rx_data:
            # Check if appointment exists
            has_appt = con.execute("SELECT 1 FROM appointments WHERE appointment_id=?", (appt,)).fetchone()
            appt_val = appt if has_appt else None
            con.execute("""INSERT INTO prescriptions(appointment_id,patient_id,doctor_id,diagnosis,medications,advice)
                VALUES(?,?,?,?,?,?)""", (appt_val, pat, doc, diag, meds, adv))
        con.commit()
        print("✅ Demo digital prescriptions seeded")

    con.close()

# ── Helper ─────────────────────────────────────────────────────────────────────
def rows_to_list(rows):
    return [dict(r) for r in rows]

def success(data, code=200):
    return code, {"success": True, "data": data}

def error(msg, code=400, err_code="ERROR"):
    return code, {"success": False, "error": {"code": err_code, "message": msg}}

# ── Request handler ────────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence default Apache-style logs

    def get_auth(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return jwt_verify(auth[7:])
        return None

    def read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except Exception:
            return {}

    def send_json(self, code, body):
        data = json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(data))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path):
        """Serve files from ./static directory."""
        if path == "/" or path == "":
            path = "/index.html"
        file_path = STATIC_DIR / path.lstrip("/")
        if not file_path.exists():
            file_path = STATIC_DIR / "index.html"  # SPA fallback
        if not file_path.exists():
            self.send_response(404); self.end_headers(); return
        ext = file_path.suffix.lower()
        ctype = {".html":"text/html",".js":"application/javascript",
                 ".css":"text/css",".json":"application/json",
                 ".png":"image/png",".ico":"image/x-icon"}.get(ext,"text/plain")
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", len(data))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/")
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if not path.startswith("/api"):
            self.serve_static(path)
            return
        self.route("GET", path, params, {})

    def do_POST(self):
        parsed = urlparse(self.path)
        body   = self.read_body()
        self.route("POST", parsed.path.rstrip("/"), {}, body)

    def do_PUT(self):
        parsed = urlparse(self.path)
        body   = self.read_body()
        self.route("PUT", parsed.path.rstrip("/"), {}, body)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        body   = self.read_body()
        self.route("PATCH", parsed.path.rstrip("/"), {}, body)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        self.route("DELETE", parsed.path.rstrip("/"), {}, {})

    def route(self, method, path, params, body):
        user  = self.get_auth()
        code, resp = self.dispatch(method, path, params, body, user)
        self.send_json(code, resp)

    def dispatch(self, method, path, params, body, user):
        con = get_db()
        try:
            return self._dispatch(method, path, params, body, user, con)
        except Exception as e:
            import traceback; traceback.print_exc()
            return error(str(e), 500, "INTERNAL_ERROR")
        finally:
            con.close()

    def _dispatch(self, method, path, params, body, user, con):
        # ── Health ────────────────────────────────────────────────────────
        if path == "/api/health":
            return success({
                "status": "healthy", "db": "sqlite",
                "ml": {"loaded": ML_MODEL is not None, "version": ML_META.get("model_version","N/A")},
                "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            })

        # ── Auth ──────────────────────────────────────────────────────────
        if path == "/api/auth/login" and method == "POST":
            row = con.execute("SELECT * FROM users WHERE email=? AND is_active=1",
                              (body.get("email",""),)).fetchone()
            if not row or row["password_hash"] != hash_pw(body.get("password","")):
                return error("Invalid email or password", 401, "UNAUTHORIZED")
            con.execute("UPDATE users SET created_at=created_at WHERE user_id=?", (row["user_id"],))
            token = jwt_sign({"userId": row["user_id"], "role": row["role"], "email": row["email"]})
            return success({"token": token, "user": {
                "userId": row["user_id"], "user_id": row["user_id"], "username": row["username"],
                "email": row["email"], "role": row["role"]
            }})

        if path == "/api/auth/register" and method == "POST":
            if not body.get("email") or not body.get("password") or not body.get("username"):
                return error("email, username and password are required")
            if con.execute("SELECT 1 FROM users WHERE email=?", (body["email"],)).fetchone():
                return error("Email already registered", 409, "CONFLICT")
            ph = hash_pw(body["password"])
            cur = con.execute("INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,?)",
                (body["username"], body["email"], ph, body.get("role","patient")))
            con.commit()
            token = jwt_sign({"userId": cur.lastrowid, "role": body.get("role","patient"), "email": body["email"]})
            new_id = cur.lastrowid
            return success({"token": token, "userId": new_id, "user_id": new_id,
                            "user": {"userId": new_id, "user_id": new_id, "username": body.get("username",""),
                                     "email": body["email"], "role": body.get("role","patient")}}, 201)

        if path == "/api/auth/me" and method == "GET":
            if not user: return error("Unauthorized", 401, "UNAUTHORIZED")
            row = con.execute("SELECT user_id,username,email,role FROM users WHERE user_id=?",
                              (user["userId"],)).fetchone()
            if not row: return success(None)
            res_user = dict(row)
            res_user["userId"] = row["user_id"]
            res_user["user_id"] = row["user_id"]
            return success(res_user)

        if path == "/api/patients/me" and method == "GET":
            if not user: return error("Unauthorized", 401, "UNAUTHORIZED")
            row = con.execute("""SELECT p.*, COALESCE(u.email,'') as email FROM patients p
                JOIN users u ON u.user_id=p.user_id WHERE p.user_id=?""", (user["userId"],)).fetchone()
            return success(dict(row) if row else None)

        # ── Guard remaining routes ─────────────────────────────────────────
        if not user:
            return error("Authentication required", 401, "UNAUTHORIZED")

        # ── Patients ──────────────────────────────────────────────────────
        if path == "/api/patients":
            if method == "GET":
                q = f"%{params.get('search','')}%"
                rows = con.execute("""SELECT p.*, COALESCE(u.email,'') as email, COALESCE(u.raw_password,'patient123') as password FROM patients p
                    LEFT JOIN users u ON u.user_id=p.user_id
                    WHERE p.first_name LIKE ? OR p.last_name LIKE ? OR p.phone LIKE ?
                    ORDER BY p.last_name""", (q,q,q)).fetchall()
                return success(rows_to_list(rows))
            if method == "POST":
                if user["role"] not in ("admin","receptionist"):
                    return error("Forbidden", 403, "FORBIDDEN")
                b = body
                import uuid, random
                unique_id = uuid.uuid4().hex[:8]
                fname_clean = (b.get("first_name","p") or "p").lower().replace(" ","")
                email = b.get("email","").strip() or f"{fname_clean}_{unique_id}@clinic.local"
                username = f"{fname_clean}_{unique_id}"
                
                # Auto-generate random password if empty
                raw_pwd = b.get("password","").strip()
                if not raw_pwd:
                    raw_pwd = f"Smile{random.randint(1000, 9999)}"
                
                # keep trying until unique (extremely rare collision)
                for attempt in range(5):
                    try:
                        cur = con.execute("INSERT INTO users(username,email,password_hash,raw_password,role) VALUES(?,?,?,?,?)",
                            (username, email, hash_pw(raw_pwd), raw_pwd, "patient"))
                        uid = cur.lastrowid
                        break
                    except Exception:
                        unique_id = uuid.uuid4().hex[:8]
                        email = b.get("email","").strip() or f"{fname_clean}_{unique_id}@clinic.local"
                        username = f"{fname_clean}_{unique_id}"
                else:
                    return error("Could not create unique user account", 500, "INTERNAL_ERROR")
                cur2 = con.execute("""INSERT INTO patients(user_id,first_name,last_name,date_of_birth,gender,phone,blood_group,allergies,medical_notes)
                    VALUES(?,?,?,?,?,?,?,?,?)""",
                    (uid, b.get("first_name",""), b.get("last_name",""), b.get("date_of_birth"),
                     b.get("gender"), b.get("phone",""), b.get("blood_group"), b.get("allergies"), b.get("medical_notes")))
                con.commit()
                row = dict(con.execute("SELECT p.*, COALESCE(u.email,'') as email, COALESCE(u.raw_password,'patient123') as password FROM patients p LEFT JOIN users u ON u.user_id=p.user_id WHERE p.patient_id=?", (cur2.lastrowid,)).fetchone())
                row["raw_password"] = raw_pwd
                row["login_email"] = email
                return success(row, 201)

        pat_m = re.match(r"^/api/patients/(\d+)$", path)
        if pat_m:
            pid = int(pat_m.group(1))
            if method == "GET":
                row = con.execute("SELECT p.*, COALESCE(u.email,'') as email, COALESCE(u.raw_password,'patient123') as password FROM patients p LEFT JOIN users u ON u.user_id=p.user_id WHERE p.patient_id=?", (pid,)).fetchone()
                return success(dict(row)) if row else error("Patient not found", 404, "NOT_FOUND")
            if method in ("PUT","PATCH"):
                fields = {k: body[k] for k in ("first_name","last_name","phone","address","blood_group","allergies","medical_notes","gender") if k in body}
                if fields:
                    sets = ", ".join(f"{k}=?" for k in fields)
                    con.execute(f"UPDATE patients SET {sets}, updated_at=datetime('now') WHERE patient_id=?",
                                (*fields.values(), pid))
                    con.commit()
                row = con.execute("SELECT p.*, COALESCE(u.email,'') as email, COALESCE(u.raw_password,'patient123') as password FROM patients p LEFT JOIN users u ON u.user_id=p.user_id WHERE p.patient_id=?", (pid,)).fetchone()
                return success(dict(row)) if row else error("Not found", 404, "NOT_FOUND")
            if method == "DELETE":
                if user["role"] != "admin": return error("Forbidden", 403, "FORBIDDEN")
                con.execute("DELETE FROM patients WHERE patient_id=?", (pid,))
                con.commit()
                return success({"deleted": pid})

        # ── Patient password change ─────────────────────────────────────────
        pat_pw = re.match(r"^/api/patients/(\d+)/password$", path)
        if pat_pw and method == "PATCH":
            if user["role"] != "admin":
                return error("Forbidden", 403, "FORBIDDEN")
            pid = int(pat_pw.group(1))
            new_pw = body.get("new_password", "")
            if len(new_pw) < 6:
                return error("Password must be at least 6 characters")
            pat = con.execute("SELECT * FROM patients WHERE patient_id=?", (pid,)).fetchone()
            if not pat:
                return error("Patient not found", 404, "NOT_FOUND")
            
            uid = pat["user_id"]
            if not uid:
                import uuid
                fname_clean = (pat["first_name"] or "patient").lower().replace(" ", "")
                email = pat.get("phone","") or f"{fname_clean}_{uuid.uuid4().hex[:6]}@patient.local"
                username = f"{fname_clean}_{uuid.uuid4().hex[:6]}"
                ucur = con.execute("INSERT INTO users(username,email,password_hash,raw_password,role) VALUES(?,?,?,?,?)",
                    (username, email, hash_pw(new_pw), new_pw, "patient"))
                uid = ucur.lastrowid
                con.execute("UPDATE patients SET user_id=? WHERE patient_id=?", (uid, pid))
            else:
                con.execute("UPDATE users SET password_hash=?, raw_password=? WHERE user_id=?", (hash_pw(new_pw), new_pw, uid))
            
            con.commit()
            return success({"message": "Patient password updated successfully"})

        # ── Doctors ───────────────────────────────────────────────────────
        if path == "/api/doctors":
            if method == "GET":
                rows = con.execute("SELECT d.*, COALESCE(u.email,'') as email, COALESCE(u.raw_password,'doctor123') as password FROM doctors d LEFT JOIN users u ON u.user_id=d.user_id ORDER BY d.last_name").fetchall()
                return success(rows_to_list(rows))
            if method == "POST":
                if user["role"] != "admin": return error("Forbidden", 403, "FORBIDDEN")
                b = body

                provided_uid = b.get("user_id")
                if provided_uid and int(provided_uid) > 0:
                    existing = con.execute("SELECT user_id FROM users WHERE user_id=?", (int(provided_uid),)).fetchone()
                    uid = existing["user_id"] if existing else None
                else:
                    uid = None

                if not uid:
                    import uuid
                    email = b.get("email","").strip()
                    if not email:
                        email = f"dr_{b.get('first_name','doc').lower()}_{uuid.uuid4().hex[:6]}@clinic.local"
                    password = b.get("password","")
                    if not password:
                        password = uuid.uuid4().hex[:10]
                    fname = (b.get("first_name","dr") or "dr").lower().replace(" ","")
                    username = f"dr_{fname}_{uuid.uuid4().hex[:5]}"
                    existing_email = con.execute("SELECT user_id FROM users WHERE email=?", (email,)).fetchone()
                    if existing_email:
                        uid = existing_email["user_id"]
                    else:
                        ucur = con.execute(
                            "INSERT INTO users(username,email,password_hash,raw_password,role) VALUES(?,?,?,?,?)",
                            (username, email, hash_pw(password), password, "doctor"))
                        con.commit()
                        uid = ucur.lastrowid

                lic = b.get("license_number","").strip() or f"LIC-{int(time.time())}"
                qual = b.get("qualification","").strip() or "BDS, MDS"
                cur = con.execute(
                    "INSERT INTO doctors(user_id,first_name,last_name,specialisation,qualification,license_number,phone,consultation_fee) VALUES(?,?,?,?,?,?,?,?)",
                    (uid, b.get("first_name",""), b.get("last_name",""),
                     b.get("specialisation","General Dentistry"),
                     qual,
                     lic, b.get("phone",""), float(b.get("consultation_fee",0) or 0)))
                con.commit()
                row = con.execute(
                    "SELECT d.*,u.email FROM doctors d JOIN users u ON u.user_id=d.user_id WHERE d.doctor_id=?",
                    (cur.lastrowid,)).fetchone()
                return success(dict(row), 201)

        doc_m = re.match(r"^/api/doctors/(\d+)$", path)
        if doc_m:
            did = int(doc_m.group(1))
            if method == "GET":
                row = con.execute("SELECT d.*,u.email FROM doctors d JOIN users u ON u.user_id=d.user_id WHERE d.doctor_id=?", (did,)).fetchone()
                return success(dict(row)) if row else error("Doctor not found", 404, "NOT_FOUND")
            if method in ("PUT","PATCH"):
                fields = {k: body[k] for k in ("first_name","last_name","phone","consultation_fee","is_available","specialisation","qualification") if k in body}
                if fields:
                    sets = ", ".join(f"{k}=?" for k in fields)
                    con.execute(f"UPDATE doctors SET {sets} WHERE doctor_id=?", (*fields.values(), did))
                    con.commit()
                row = con.execute("SELECT * FROM doctors WHERE doctor_id=?", (did,)).fetchone()
                return success(dict(row))
            if method == "DELETE":
                if user["role"] != "admin":
                    return error("Forbidden", 403, "FORBIDDEN")
                doc = con.execute("SELECT * FROM doctors WHERE doctor_id=?", (did,)).fetchone()
                if not doc:
                    return error("Doctor not found", 404, "NOT_FOUND")
                # Check if doctor has future appointments
                future = con.execute("SELECT COUNT(*) FROM appointments WHERE doctor_id=? AND status IN ('scheduled','confirmed')", (did,)).fetchone()[0]
                if future > 0:
                    return error(f"Cannot delete — doctor has {future} upcoming appointment(s). Cancel them first.", 409, "CONFLICT")
                con.execute("DELETE FROM doctors WHERE doctor_id=?", (did,))
                con.commit()
                return success({"deleted": did})

        # ── Doctor password change ─────────────────────────────────────────
        doc_pw = re.match(r"^/api/doctors/(\d+)/password$", path)
        if doc_pw and method == "PATCH":
            if user["role"] != "admin":
                return error("Forbidden", 403, "FORBIDDEN")
            did  = int(doc_pw.group(1))
            new_pw = body.get("new_password","")
            if len(new_pw) < 6:
                return error("Password must be at least 6 characters")
            doc = con.execute("SELECT user_id FROM doctors WHERE doctor_id=?", (did,)).fetchone()
            if not doc:
                return error("Doctor not found", 404, "NOT_FOUND")
            con.execute("UPDATE users SET password_hash=?, raw_password=? WHERE user_id=?", (hash_pw(new_pw), new_pw, doc["user_id"]))
            con.commit()
            return success({"message": "Password updated successfully"})

        # ── Treatments ────────────────────────────────────────────────────
        if path == "/api/treatments":
            if method == "GET":
                rows = con.execute("SELECT * FROM treatments WHERE is_active=1 ORDER BY treatment_name").fetchall()
                return success(rows_to_list(rows))
            if method == "POST":
                b = body
                cur = con.execute("INSERT INTO treatments(treatment_name,category,description,base_cost,duration_mins) VALUES(?,?,?,?,?)",
                    (b.get("treatment_name",""), b.get("category",""), b.get("description",""), b.get("base_cost",0), b.get("duration_mins",30)))
                con.commit()
                row = con.execute("SELECT * FROM treatments WHERE treatment_id=?", (cur.lastrowid,)).fetchone()
                return success(dict(row), 201)

        # ── Appointments ──────────────────────────────────────────────────
        if path == "/api/appointments":
            if method == "GET":
                conditions, args = [], []
                status_filter = params.get("status","")
                if status_filter:
                    conditions.append("a.status=?")
                    args.append(status_filter)
                patient_id = params.get("patient_id")
                if patient_id:
                    conditions.append("a.patient_id=?")
                    args.append(int(patient_id))
                doctor_id = params.get("doctor_id")
                if doctor_id:
                    conditions.append("a.doctor_id=?")
                    args.append(int(doctor_id))
                # Doctors only see their own appointments
                if user["role"] == "doctor":
                    doc_row = con.execute("SELECT doctor_id FROM doctors WHERE user_id=?", (user["userId"],)).fetchone()
                    if doc_row:
                        conditions.append("a.doctor_id=?")
                        args.append(doc_row["doctor_id"])
                    else:
                        conditions.append("1=0")
                # Patients only see their own appointments
                if user["role"] == "patient":
                    pat_row = con.execute("SELECT patient_id FROM patients WHERE user_id=?", (user["userId"],)).fetchone()
                    if pat_row:
                        conditions.append("a.patient_id=?")
                        args.append(pat_row["patient_id"])
                    else:
                        conditions.append("1=0")
                where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
                rows = con.execute(f"""
                    SELECT a.*,
                        p.first_name||' '||p.last_name AS patient_name, p.phone AS patient_phone,
                        d.first_name||' '||d.last_name AS doctor_name, d.specialisation
                    FROM appointments a
                    JOIN patients p ON p.patient_id=a.patient_id
                    JOIN doctors  d ON d.doctor_id=a.doctor_id
                    {where}
                    ORDER BY a.scheduled_at DESC LIMIT 200""", args).fetchall()
                return success(rows_to_list(rows))

            if method == "POST":
                if user["role"] == "doctor":
                    return error("Doctors cannot schedule appointments. Only receptionists or admins can schedule.", 403, "FORBIDDEN")
                b = body
                if not b.get("patient_id") or not b.get("doctor_id") or not b.get("scheduled_at"):
                    return error("patient_id, doctor_id and scheduled_at are required")
                # Check if doctor is available
                doc_check = con.execute("SELECT first_name, last_name, is_available FROM doctors WHERE doctor_id=?", (b["doctor_id"],)).fetchone()
                if not doc_check:
                    return error("Selected doctor not found", 404, "NOT_FOUND")
                if not doc_check["is_available"]:
                    return error(f"Dr. {doc_check['first_name']} {doc_check['last_name']} is currently unavailable/off duty and cannot be scheduled.", 400, "DOCTOR_UNAVAILABLE")
                # Save appointment
                cur = con.execute("""INSERT INTO appointments(patient_id,doctor_id,scheduled_at,duration_mins,status,reason,priority)
                    VALUES(?,?,?,?,?,?,?)""",
                    (b["patient_id"], b["doctor_id"], b["scheduled_at"],
                     int(b.get("duration_mins",30) or 30),
                     b.get("status","scheduled"),
                     b.get("reason",""),
                     b.get("priority","normal")))
                con.commit()
                appt_id = cur.lastrowid

                # Trigger ML risk prediction synchronously for this new appointment
                pred = predict_no_show_risk(b["patient_id"], b["doctor_id"], b["scheduled_at"], con)
                con.execute("""UPDATE appointments
                    SET no_show_probability=?, risk_level=?, recommended_action=?
                    WHERE appointment_id=?""",
                    (pred["no_show_probability"], pred["risk_level"], pred["recommended_action"], appt_id))
                con.commit()

                row = con.execute("""SELECT a.*, p.first_name||' '||p.last_name AS patient_name,
                    d.first_name||' '||d.last_name AS doctor_name
                    FROM appointments a JOIN patients p ON p.patient_id=a.patient_id
                    JOIN doctors d ON d.doctor_id=a.doctor_id
                    WHERE a.appointment_id=?""", (appt_id,)).fetchone()
                result = dict(row)
                result.update(pred)
                return success(result, 201)

        appt_cancel_m = re.match(r"^/api/appointments/(\d+)/cancel$", path)
        if appt_cancel_m and method == "POST":
            aid = int(appt_cancel_m.group(1))
            if user["role"] not in ("admin", "receptionist"):
                return error("Forbidden", 403, "FORBIDDEN")
            con.execute("UPDATE appointments SET status='cancelled', updated_at=datetime('now') WHERE appointment_id=?", (aid,))
            con.commit()
            row = con.execute("SELECT * FROM appointments WHERE appointment_id=?", (aid,)).fetchone()
            return success(dict(row))

        appt_m = re.match(r"^/api/appointments/(\d+)$", path)
        if appt_m:
            aid = int(appt_m.group(1))
            if method == "GET":
                row = con.execute("""SELECT a.*, p.first_name||' '||p.last_name AS patient_name,
                    d.first_name||' '||d.last_name AS doctor_name
                    FROM appointments a JOIN patients p ON p.patient_id=a.patient_id
                    JOIN doctors d ON d.doctor_id=a.doctor_id WHERE a.appointment_id=?""", (aid,)).fetchone()
                return success(dict(row)) if row else error("Not found", 404, "NOT_FOUND")
            if method in ("PUT","PATCH"):
                if user["role"] == "patient":
                    return error("Patients cannot edit clinical records or appointment details", 403, "FORBIDDEN")
                # Check doctor ownership & status modification
                if user["role"] == "doctor":
                    if "status" in body and body["status"] in ("confirmed", "cancelled"):
                        return error("Doctors cannot confirm or cancel appointments. Only receptionists/admin can manage appointment statuses.", 403, "FORBIDDEN")
                    doc_row = con.execute("SELECT doctor_id FROM doctors WHERE user_id=?", (user["userId"],)).fetchone()
                    owns = con.execute("SELECT 1 FROM appointments WHERE appointment_id=? AND doctor_id=?",
                                      (aid, doc_row["doctor_id"] if doc_row else -1)).fetchone()
                    if not owns:
                        return error("You can only update your own appointments", 403, "FORBIDDEN")
                fields = {k: body[k] for k in ("status","notes","reason","scheduled_at","reminder_sent","priority") if k in body}
                if fields:
                    sets = ", ".join(f"{k}=?" for k in fields)
                    con.execute(f"UPDATE appointments SET {sets}, updated_at=datetime('now') WHERE appointment_id=?",
                                (*fields.values(), aid))
                    con.commit()
                row = con.execute("SELECT * FROM appointments WHERE appointment_id=?", (aid,)).fetchone()
                return success(dict(row))
            if method == "DELETE":
                if user["role"] != "admin":
                    return error("Forbidden", 403, "FORBIDDEN")
                con.execute("DELETE FROM invoices WHERE appointment_id=?", (aid,))
                con.execute("DELETE FROM appointments WHERE appointment_id=?", (aid,))
                con.commit()
                return success({"deleted": aid})

        # ── Invoices ──────────────────────────────────────────────────────
        if path == "/api/invoices":
            if method == "GET":
                if user["role"] == "patient":
                    pat_row = con.execute("SELECT patient_id FROM patients WHERE user_id=?", (user["userId"],)).fetchone()
                    if pat_row:
                        rows = con.execute("""SELECT i.*, p.first_name||' '||p.last_name AS patient_name
                            FROM invoices i JOIN patients p ON p.patient_id=i.patient_id
                            WHERE i.patient_id=?
                            ORDER BY i.issued_at DESC""", (pat_row["patient_id"],)).fetchall()
                        return success(rows_to_list(rows))
                    return success([])
                rows = con.execute("""SELECT i.*, p.first_name||' '||p.last_name AS patient_name
                    FROM invoices i JOIN patients p ON p.patient_id=i.patient_id
                    ORDER BY i.issued_at DESC""").fetchall()
                return success(rows_to_list(rows))
            if method == "POST":
                b = body
                cur = con.execute("""INSERT INTO invoices(appointment_id,patient_id,subtotal,discount,tax_amount,total_amount,payment_status,payment_method)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (b.get("appointment_id"), b["patient_id"], b.get("subtotal",0), b.get("discount",0),
                     b.get("tax_amount",0), b.get("total_amount", b.get("subtotal",0)),
                     b.get("payment_status","pending"), b.get("payment_method")))
                con.commit()
                return success({"invoice_id": cur.lastrowid}, 201)

        inv_pay = re.match(r"^/api/invoices/(\d+)/pay$", path)
        if inv_pay and method == "PATCH":
            iid = int(inv_pay.group(1))
            con.execute("UPDATE invoices SET payment_status='paid', payment_method=?, paid_at=datetime('now') WHERE invoice_id=?",
                        (body.get("payment_method","cash"), iid))
            con.commit()
            row = con.execute("SELECT * FROM invoices WHERE invoice_id=?", (iid,)).fetchone()
            return success(dict(row))

        # ── Prescriptions ─────────────────────────────────────────────────
        if path == "/api/prescriptions":
            if method == "GET":
                conditions, args = [], []
                if user["role"] == "patient":
                    pat_row = con.execute("SELECT patient_id FROM patients WHERE user_id=?", (user["userId"],)).fetchone()
                    if pat_row:
                        conditions.append("pr.patient_id=?")
                        args.append(pat_row["patient_id"])
                    else:
                        conditions.append("1=0")
                elif user["role"] == "doctor":
                    doc_row = con.execute("SELECT doctor_id FROM doctors WHERE user_id=?", (user["userId"],)).fetchone()
                    if doc_row:
                        conditions.append("pr.doctor_id=?")
                        args.append(doc_row["doctor_id"])
                else:
                    if params.get("patient_id"):
                        conditions.append("pr.patient_id=?")
                        args.append(int(params["patient_id"]))
                    if params.get("doctor_id"):
                        conditions.append("pr.doctor_id=?")
                        args.append(int(params["doctor_id"]))

                where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
                rows = con.execute(f"""
                    SELECT pr.*,
                        p.first_name||' '||p.last_name AS patient_name, p.phone AS patient_phone, p.gender AS patient_gender, p.date_of_birth AS patient_dob,
                        d.first_name||' '||d.last_name AS doctor_name, d.specialisation AS doctor_specialisation, d.license_number AS doctor_license, d.phone AS doctor_phone,
                        a.scheduled_at AS appointment_date, a.reason AS appointment_reason
                    FROM prescriptions pr
                    JOIN patients p ON p.patient_id=pr.patient_id
                    JOIN doctors d ON d.doctor_id=pr.doctor_id
                    LEFT JOIN appointments a ON a.appointment_id=pr.appointment_id
                    {where}
                    ORDER BY pr.issued_at DESC""", args).fetchall()
                return success(rows_to_list(rows))

            if method == "POST":
                if user["role"] not in ("admin", "doctor", "receptionist"):
                    return error("Forbidden", 403, "FORBIDDEN")
                b = body
                patient_id = b.get("patient_id")
                doctor_id = b.get("doctor_id")
                if not doctor_id and user["role"] == "doctor":
                    doc_row = con.execute("SELECT doctor_id FROM doctors WHERE user_id=?", (user["userId"],)).fetchone()
                    if doc_row:
                        doctor_id = doc_row["doctor_id"]
                if not patient_id or not doctor_id or not b.get("medications"):
                    return error("patient_id, doctor_id and medications are required", 400, "BAD_REQUEST")

                meds = b["medications"]
                meds_str = json.dumps(meds) if isinstance(meds, (list, dict)) else str(meds)

                cur = con.execute("""INSERT INTO prescriptions(appointment_id,patient_id,doctor_id,diagnosis,medications,advice)
                    VALUES(?,?,?,?,?,?)""",
                    (b.get("appointment_id"), patient_id, doctor_id, b.get("diagnosis",""), meds_str, b.get("advice","")))
                con.commit()
                rx_id = cur.lastrowid
                row = con.execute("""SELECT pr.*,
                    p.first_name||' '||p.last_name AS patient_name, p.phone AS patient_phone,
                    d.first_name||' '||d.last_name AS doctor_name, d.specialisation AS doctor_specialisation, d.license_number AS doctor_license
                    FROM prescriptions pr
                    JOIN patients p ON p.patient_id=pr.patient_id
                    JOIN doctors d ON d.doctor_id=pr.doctor_id
                    WHERE pr.prescription_id=?""", (rx_id,)).fetchone()
                return success(dict(row), 201)

        rx_m = re.match(r"^/api/prescriptions/(\d+)$", path)
        if rx_m and method == "GET":
            rx_id = int(rx_m.group(1))
            row = con.execute("""SELECT pr.*,
                p.first_name||' '||p.last_name AS patient_name, p.phone AS patient_phone, p.gender AS patient_gender, p.date_of_birth AS patient_dob, p.allergies AS patient_allergies, p.blood_group AS patient_blood_group,
                d.first_name||' '||d.last_name AS doctor_name, d.specialisation AS doctor_specialisation, d.license_number AS doctor_license, d.phone AS doctor_phone,
                a.scheduled_at AS appointment_date, a.reason AS appointment_reason
                FROM prescriptions pr
                JOIN patients p ON p.patient_id=pr.patient_id
                JOIN doctors d ON d.doctor_id=pr.doctor_id
                LEFT JOIN appointments a ON a.appointment_id=pr.appointment_id
                WHERE pr.prescription_id=?""", (rx_id,)).fetchone()
            if not row: return error("Prescription not found", 404, "NOT_FOUND")
            return success(dict(row))
        if inv_pay and method == "PATCH":
            iid = int(inv_pay.group(1))
            con.execute("UPDATE invoices SET payment_status='paid', payment_method=?, paid_at=datetime('now') WHERE invoice_id=?",
                        (body.get("payment_method","cash"), iid))
            con.commit()
            row = con.execute("SELECT * FROM invoices WHERE invoice_id=?", (iid,)).fetchone()
            return success(dict(row))

        # ── ML endpoints ──────────────────────────────────────────────────
        if path == "/api/ml/health":
            return success({"loaded": ML_MODEL is not None, "version": ML_META.get("model_version","N/A"),
                            "metrics": ML_META.get("test_metrics",{}), "threshold": THRESHOLD})

        if path == "/api/ml/risk-summary":
            rows = con.execute("""SELECT
                COUNT(CASE WHEN no_show_probability < 0.35 THEN 1 END)             AS low_risk,
                COUNT(CASE WHEN no_show_probability >= 0.35 AND no_show_probability < 0.60 THEN 1 END) AS medium_risk,
                COUNT(CASE WHEN no_show_probability >= 0.60 THEN 1 END)             AS high_risk,
                COUNT(CASE WHEN no_show_probability IS NULL THEN 1 END)             AS unscored
                FROM appointments WHERE status IN ('scheduled','confirmed')""").fetchone()
            return success(dict(rows))

        if path == "/api/ml/predict/manual" and method == "POST":
            pred = ml_predict(body)
            return success(pred)

        ml_appt = re.match(r"^/api/ml/predict/(\d+)$", path)
        if ml_appt and method == "POST":
            aid  = int(ml_appt.group(1))
            row  = con.execute("SELECT * FROM appointments WHERE appointment_id=?", (aid,)).fetchone()
            if not row: return error("Appointment not found", 404, "NOT_FOUND")
            pred = ml_predict(body or {})
            con.execute("UPDATE appointments SET no_show_probability=?,risk_level=? WHERE appointment_id=?",
                        (pred["no_show_probability"], pred["risk_level"], aid))
            con.commit()
            return success(pred)

        if path == "/api/ml/appointments":
            rows = con.execute("""SELECT a.appointment_id, a.scheduled_at, a.status,
                a.no_show_probability, a.risk_level, a.recommended_action,
                p.first_name||' '||p.last_name AS patient_name,
                d.first_name||' '||d.last_name AS doctor_name, a.reason
                FROM appointments a
                JOIN patients p ON p.patient_id=a.patient_id
                JOIN doctors  d ON d.doctor_id =a.doctor_id
                WHERE a.status IN ('scheduled','confirmed')
                ORDER BY a.scheduled_at""").fetchall()
            return success(rows_to_list(rows))

        if path == "/api/stats/dashboard":
            stats = {}
            stats["patients_today"] = con.execute("SELECT COUNT(*) FROM appointments WHERE date(scheduled_at)=date('now')").fetchone()[0]
            stats["appointments_week"] = con.execute("SELECT COUNT(*) FROM appointments WHERE scheduled_at >= date('now','-7 days')").fetchone()[0]
            stats["pending_bills"] = con.execute("SELECT COALESCE(SUM(total_amount),0) FROM invoices WHERE payment_status IN ('pending','overdue')").fetchone()[0]
            stats["total_patients"] = con.execute("SELECT COUNT(*) FROM patients").fetchone()[0]
            stats["total_doctors"]  = con.execute("SELECT COUNT(*) FROM doctors").fetchone()[0]
            stats["total_revenue"]  = con.execute("SELECT COALESCE(SUM(total_amount),0) FROM invoices WHERE payment_status='paid'").fetchone()[0]
            risk = con.execute("""SELECT
                COUNT(CASE WHEN no_show_probability >= 0.60 THEN 1 END) AS high,
                COUNT(CASE WHEN no_show_probability >= 0.35 AND no_show_probability < 0.60 THEN 1 END) AS medium,
                COUNT(CASE WHEN no_show_probability < 0.35 THEN 1 END) AS low
                FROM appointments WHERE status IN ('scheduled','confirmed')""").fetchone()
            stats["risk"] = dict(risk)
            return success(stats)

        return error(f"Route not found: {method} {path}", 404, "NOT_FOUND")

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    if any(arg in sys.argv for arg in ("--export-csv", "-export-csv", "export-csv")):
        import export_csv
        export_csv.export_data()
        sys.exit(0)

    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\n{'='*52}")
    print(f"  SmileClinic DMS — All-in-one Server")
    print(f"{'='*52}")
    print(f"  API  →  http://localhost:{PORT}/api")
    print(f"  UI   →  http://localhost:{PORT}")
    print(f"  DB   →  SQLite ({DB_PATH})")
    print(f"  ML   →  {'Loaded (AUC '+str(ML_META.get('test_metrics',{}).get('roc_auc','N/A'))+')' if ML_MODEL else 'Fallback formula'}")
    print(f"{'='*52}")
    print(f"\n  Demo logins:")
    print(f"    admin@smile.in    / admin123")
    print(f"    doctor@smile.in   / doctor123   (Dr. Priya Sharma)")
    print(f"    arjun@smile.in    / arjun123    (Dr. Arjun Nair)")
    print(f"    recept@smile.in   / recept123")
    print(f"\n  Press Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
