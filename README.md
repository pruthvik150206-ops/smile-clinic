# SmileClinic DMS — Dental Clinic Management System

## Project Structure
```
SmileClinic/
├── server.py                  ← All-in-one runner (START HERE)
├── frontend/
│   └── static/
│       └── index.html         ← Full React SPA (single file)
├── backend/                   ← Node.js / Express (production)
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── server.js
│       ├── config/database.js
│       ├── controllers/       ← auth, patient, doctor, appointment, billing, treatment, ml
│       ├── middleware/        ← auth, errorHandler, validate
│       ├── models/            ← user, patient, doctor, appointment
│       ├── routes/            ← all REST routes
│       ├── services/          ← mlService.js
│       └── utils/             ← jwt, logger, response
├── ml/                        ← Python scikit-learn
│   ├── requirements.txt
│   ├── data/generate_dataset.py
│   ├── models/
│   │   ├── train.py
│   │   ├── no_show_model.pkl  ← Pre-trained model (ready to use)
│   │   └── model_meta.json
│   └── app/main.py            ← FastAPI ML microservice
└── database/
    ├── smileclinic_complete_schema.sql  ← Full schema + seed data
    └── dental_clinic_schema.sql         ← PostgreSQL schema only
```

---

## Option A — Quickest (Python only, zero npm)

```bash
pip install scikit-learn pandas joblib numpy
python3 server.py
```

Open http://localhost:5000

---

## Option B — Full Stack (Node + Python + PostgreSQL)

### 1. Database
```bash
createdb dental_clinic
psql -U postgres -d dental_clinic -f database/smileclinic_complete_schema.sql
```

### 2. Backend (Node.js)
```bash
cd backend
npm install
cp .env.example .env        # fill in DB_PASSWORD and JWT_SECRET
npm run dev
```

### 3. ML Service (Python)
```bash
cd ml
pip install -r requirements.txt
# Model is pre-trained. Just start the API:
uvicorn app.main:app --port 8001 --reload
# Or retrain from scratch:
python3 data/generate_dataset.py
python3 models/train.py
```

### 4. Frontend
Serve `frontend/static/index.html` from any web server, or open directly in browser.

---

## Demo Logins

| Role         | Email               | Password   |
|--------------|---------------------|------------|
| Admin        | admin@smile.in      | admin123   |
| Doctor       | doctor@smile.in     | doctor123  |
| Receptionist | recept@smile.in     | recept123  |
| Patient      | meera@patient.in    | patient123 |

---

## API Endpoints

| Method | Path                       | Description                    |
|--------|----------------------------|-------------------------------|
| POST   | /api/auth/login            | Login → JWT token              |
| POST   | /api/auth/register         | Register new user              |
| GET    | /api/auth/me               | Current user info              |
| GET    | /api/patients              | List all patients              |
| POST   | /api/patients              | Add patient                    |
| GET    | /api/patients/:id          | Get patient                    |
| PATCH  | /api/patients/:id          | Update patient                 |
| DELETE | /api/patients/:id          | Delete patient (admin only)    |
| GET    | /api/doctors               | List doctors                   |
| POST   | /api/doctors               | Add doctor (admin only)        |
| GET    | /api/appointments          | List appointments              |
| POST   | /api/appointments          | Create + auto ML score         |
| PATCH  | /api/appointments/:id      | Update / confirm / cancel      |
| GET    | /api/treatments            | List treatments                |
| GET    | /api/invoices              | List invoices                  |
| POST   | /api/invoices              | Create invoice                 |
| PATCH  | /api/invoices/:id/pay      | Mark invoice paid              |
| GET    | /api/ml/health             | ML model status                |
| POST   | /api/ml/predict/manual     | Manual no-show prediction      |
| GET    | /api/ml/risk-summary       | Risk counts for dashboard      |
| GET    | /api/stats/dashboard       | Dashboard statistics           |
| GET    | /api/health                | Server health check            |

---

Built across 5 parts: Architecture → Database → Backend → Frontend → ML
