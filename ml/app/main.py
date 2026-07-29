"""
app/main.py
────────────────────────────────────────────────────────
Dental Clinic ML Service  |  FastAPI  |  Port 8001

Endpoints
──────────
GET  /health              — liveness + model metadata
POST /predict/no-show     — single appointment prediction
POST /predict/batch       — batch predictions (up to 100)
GET  /model/info          — model performance metrics
GET  /model/features      — feature importance description
POST /predict/explain     — LIME-style feature contribution
"""

import json, os, time
from pathlib import Path
from typing  import List, Optional
import numpy  as np
import joblib

# FastAPI may not be installed in the sandbox; we fall back to a minimal
# stdlib http.server so the file is still runnable and testable.
try:
    from fastapi            import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses  import JSONResponse
    from pydantic           import BaseModel, Field, validator
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

# ── Paths ─────────────────────────────────────────────────
BASE     = Path(__file__).parent.parent
MODEL_DIR= BASE / 'models'

# ── Load artifacts ────────────────────────────────────────
def load_artifacts():
    model = joblib.load(MODEL_DIR / 'no_show_model.pkl')
    with open(MODEL_DIR / 'model_meta.json') as f:
        meta = json.load(f)
    return model, meta

MODEL, META = load_artifacts()
THRESHOLD   = META['optimal_threshold']

print(f"✅  Model loaded: {META['model_name']} v{META['model_version']}")
print(f"    ROC-AUC: {META['test_metrics']['roc_auc']} | Threshold: {THRESHOLD}")


# ══════════════════════════════════════════════════════════
#  SCHEMAS
# ══════════════════════════════════════════════════════════
if HAS_FASTAPI:
    class AppointmentFeatures(BaseModel):
        # Required
        lead_time_days:        int   = Field(..., ge=0, le=365, description="Days between booking and appointment")
        prior_no_shows:        int   = Field(..., ge=0, le=20,  description="Patient's historical no-show count")
        appointment_hour:      int   = Field(..., ge=0, le=23,  description="Hour of appointment (24h)")
        age:                   int   = Field(..., ge=1, le=120, description="Patient age")
        distance_km:           float = Field(..., ge=0,         description="Distance from clinic in km")
        treatment_cost:        float = Field(..., ge=0,         description="Treatment cost in INR")
        previous_appointments: int   = Field(..., ge=0,         description="Total prior appointments")
        month:                 int   = Field(..., ge=1, le=12,  description="Month of appointment (1-12)")
        reminder_sent:         int   = Field(..., ge=0, le=1,   description="Whether SMS/email reminder was sent")
        has_insurance:         int   = Field(..., ge=0, le=1,   description="Patient has insurance")
        is_follow_up:          int   = Field(..., ge=0, le=1,   description="Is this a follow-up appointment")
        day_of_week:           str   = Field(..., description="Day name: monday … saturday")
        treatment_category:    str   = Field(..., description="preventive|restorative|cosmetic|surgical|diagnostic|orthodontic")
        gender:                str   = Field(..., description="male|female|other")

        # Optional metadata (passed through, not used in model)
        patient_id:    Optional[int] = None
        appointment_id:Optional[int] = None

        @validator('day_of_week')
        def validate_day(cls, v):
            valid = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
            if v.lower() not in valid:
                raise ValueError(f'day_of_week must be one of {valid}')
            return v.lower()

        @validator('treatment_category')
        def validate_category(cls, v):
            valid = ['preventive','restorative','cosmetic','surgical','diagnostic','orthodontic']
            if v.lower() not in valid:
                raise ValueError(f'treatment_category must be one of {valid}')
            return v.lower()

        @validator('gender')
        def validate_gender(cls, v):
            valid = ['male','female','other']
            if v.lower() not in valid:
                raise ValueError(f'gender must be one of {valid}')
            return v.lower()

    class BatchRequest(BaseModel):
        appointments: List[AppointmentFeatures] = Field(..., max_items=100)

    class PredictionResponse(BaseModel):
        patient_id:          Optional[int]
        appointment_id:      Optional[int]
        no_show_probability: float
        risk_level:          str   # Low | Medium | High
        label:               str   # show | no_show
        confidence:          str   # high | medium | low
        recommended_action:  str
        model_version:       str
        threshold_used:      float


# ══════════════════════════════════════════════════════════
#  PREDICTION LOGIC  (framework-agnostic)
# ══════════════════════════════════════════════════════════
FEATURE_ORDER = META['features']

def features_to_df(data: dict):
    import pandas as pd
    row = {f: data.get(f) for f in FEATURE_ORDER}
    return pd.DataFrame([row])

def predict_single(data: dict) -> dict:
    import pandas as pd
    df  = features_to_df(data)
    prob = float(MODEL.predict_proba(df)[0][1])
    label= 'no_show' if prob >= THRESHOLD else 'show'

    # Risk bucketing
    if   prob >= 0.60: risk = 'High';   action = 'Call patient to confirm; double-book slot'
    elif prob >= 0.35: risk = 'Medium'; action = 'Send SMS reminder 24h before'
    else:              risk = 'Low';    action = 'Standard reminder sufficient'

    # Confidence: how far from threshold
    margin = abs(prob - THRESHOLD)
    if   margin >= 0.20: confidence = 'high'
    elif margin >= 0.08: confidence = 'medium'
    else:                confidence = 'low'

    return {
        'patient_id':          data.get('patient_id'),
        'appointment_id':      data.get('appointment_id'),
        'no_show_probability': round(prob, 4),
        'risk_level':          risk,
        'label':               label,
        'confidence':          confidence,
        'recommended_action':  action,
        'model_version':       META['model_version'],
        'threshold_used':      THRESHOLD,
    }

def explain_prediction(data: dict) -> dict:
    """Approximate feature contributions via leave-one-out perturbation."""
    import pandas as pd
    base_prob = float(MODEL.predict_proba(features_to_df(data))[0][1])
    contribs  = {}
    for feat in FEATURE_ORDER:
        perturbed = dict(data)
        # Replace feature with median/mode from training stats
        defaults = {
            'lead_time_days':11,'prior_no_shows':1,'appointment_hour':11,
            'age':38,'distance_km':5.8,'treatment_cost':1200,
            'previous_appointments':3,'month':6,'reminder_sent':1,
            'has_insurance':1,'is_follow_up':1,
            'day_of_week':'wednesday','treatment_category':'restorative','gender':'female',
        }
        perturbed[feat] = defaults.get(feat, 0)
        p = float(MODEL.predict_proba(features_to_df(perturbed))[0][1])
        contribs[feat] = round(base_prob - p, 4)   # positive = increases risk

    top_risk    = sorted(contribs.items(), key=lambda x: -x[1])[:5]
    top_protect = sorted(contribs.items(), key=lambda x:  x[1])[:3]
    return {
        'base_probability':  round(base_prob, 4),
        'risk_factors':      [{'feature': k, 'contribution': v} for k,v in top_risk],
        'protective_factors':[{'feature': k, 'contribution': v} for k,v in top_protect],
        'all_contributions': contribs,
    }


# ══════════════════════════════════════════════════════════
#  FASTAPI APP
# ══════════════════════════════════════════════════════════
if HAS_FASTAPI:
    app = FastAPI(
        title="Dental Clinic ML Service",
        description="No-show prediction API for SmileClinic DMS",
        version=META['model_version'],
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],   # tighten to your backend URL in production
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Middleware: request timing ───────────────────────
    @app.middleware("http")
    async def add_timing(request: Request, call_next):
        t0  = time.time()
        res = await call_next(request)
        res.headers["X-Process-Time-Ms"] = str(round((time.time()-t0)*1000, 1))
        return res

    # ── Routes ───────────────────────────────────────────
    @app.get("/health", tags=["System"])
    def health():
        return {
            "status":  "healthy",
            "service": "dental-ml",
            "model":   META['model_name'],
            "version": META['model_version'],
            "metrics": META['test_metrics'],
            "threshold": THRESHOLD,
        }

    @app.get("/model/info", tags=["Model"])
    def model_info():
        return {
            "model_name":    META['model_name'],
            "algorithm":     META['algorithm'],
            "trained_at":    META['trained_at'],
            "n_train":       META['n_train_samples'],
            "features":      META['features'],
            "metrics":       META['test_metrics'],
            "threshold":     THRESHOLD,
        }

    @app.get("/model/features", tags=["Model"])
    def feature_guide():
        return {
            "features": [
                {"name":"lead_time_days",        "type":"int",   "range":"0–365", "description":"Days from booking to appointment. Longer = higher risk."},
                {"name":"prior_no_shows",         "type":"int",   "range":"0–20",  "description":"Historical no-shows. Strongest single predictor."},
                {"name":"appointment_hour",       "type":"int",   "range":"0–23",  "description":"Early morning (≤9) and late (≥17) slots are riskier."},
                {"name":"age",                    "type":"int",   "range":"1–120", "description":"Younger adults (18-35) no-show more."},
                {"name":"distance_km",            "type":"float", "range":"0+",    "description":"Distance from clinic. Farther = higher risk."},
                {"name":"treatment_cost",         "type":"float", "range":"0+",    "description":"Higher cost motivates attendance."},
                {"name":"previous_appointments",  "type":"int",   "range":"0+",    "description":"Loyal patients show up more."},
                {"name":"reminder_sent",          "type":"int",   "range":"0/1",   "description":"SMS/email reminder reduces risk ~30%."},
                {"name":"has_insurance",          "type":"int",   "range":"0/1",   "description":"Insured patients are more reliable."},
                {"name":"is_follow_up",           "type":"int",   "range":"0/1",   "description":"Follow-up appointments have lower risk."},
                {"name":"day_of_week",            "type":"str",   "values":"monday…saturday","description":"Saturday and Friday are highest risk."},
                {"name":"treatment_category",     "type":"str",   "values":"preventive|restorative|cosmetic|surgical|diagnostic|orthodontic","description":"Surgical = lowest risk; cosmetic = highest."},
                {"name":"gender",                 "type":"str",   "values":"male|female|other","description":"Minor effect."},
            ]
        }

    @app.post("/predict/no-show", response_model=PredictionResponse, tags=["Predictions"])
    def predict_no_show(payload: AppointmentFeatures):
        try:
            return predict_single(payload.dict())
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/predict/batch", tags=["Predictions"])
    def predict_batch(payload: BatchRequest):
        results = []
        errors  = []
        for i, appt in enumerate(payload.appointments):
            try:
                results.append(predict_single(appt.dict()))
            except Exception as e:
                errors.append({"index": i, "error": str(e)})
        return {
            "total":   len(payload.appointments),
            "success": len(results),
            "errors":  errors,
            "results": results,
        }

    @app.post("/predict/explain", tags=["Predictions"])
    def predict_explain(payload: AppointmentFeatures):
        try:
            pred    = predict_single(payload.dict())
            explain = explain_prediction(payload.dict())
            return {**pred, "explanation": explain}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))


# ══════════════════════════════════════════════════════════
#  STDLIB FALLBACK (no FastAPI installed)
# ══════════════════════════════════════════════════════════
else:
    import json
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import urlparse

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a): pass  # suppress default logging

        def send_json(self, data, code=200):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin",  "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            if path == '/health':
                self.send_json({"status":"healthy","model":META['model_name'],"version":META['model_version'],"metrics":META['test_metrics']})
            elif path == '/model/info':
                self.send_json(META)
            else:
                self.send_json({"error":"Not found"}, 404)

        def do_POST(self):
            path = urlparse(self.path).path
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            if path == '/predict/no-show':
                self.send_json(predict_single(body))
            elif path == '/predict/batch':
                appts = body.get('appointments', [])
                results = [predict_single(a) for a in appts]
                self.send_json({"total":len(appts),"success":len(results),"results":results})
            elif path == '/predict/explain':
                pred    = predict_single(body)
                explain = explain_prediction(body)
                self.send_json({**pred, "explanation": explain})
            else:
                self.send_json({"error":"Not found"}, 404)

    def run(host='0.0.0.0', port=8001):
        server = HTTPServer((host, port), Handler)
        print(f"\n🚀  ML Service running on http://{host}:{port}")
        print(f"    Docs: Not available (FastAPI not installed)")
        print(f"    Endpoints: GET /health | POST /predict/no-show | POST /predict/batch")
        server.serve_forever()


if __name__ == '__main__':
    port = int(os.environ.get('ML_PORT', 8001))
    if HAS_FASTAPI:
        import uvicorn
        uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
    else:
        run(port=port)
