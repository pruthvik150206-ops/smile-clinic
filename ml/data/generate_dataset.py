"""
generate_dataset.py
────────────────────
Generates a synthetic dataset of 5,000 dental appointment records
for training a no-show prediction model.

Feature engineering rationale
──────────────────────────────
Evidence-based features drawn from healthcare no-show research:

| Feature                | Why it matters                                      |
|------------------------|-----------------------------------------------------|
| lead_time_days         | Longer gaps → higher no-show                        |
| prior_no_shows         | Past behaviour is the strongest predictor           |
| day_of_week            | Monday/Friday have higher no-show rates             |
| appointment_hour       | Early morning slots see more no-shows               |
| age                    | Younger adults (18-35) no-show more                 |
| distance_km            | Farther away → more likely to skip                  |
| reminder_sent          | Reminders cut no-show rate ~30%                     |
| treatment_cost         | Higher cost → patient more motivated to show        |
| treatment_category     | Cosmetic vs preventive vs urgent differ             |
| previous_appointments  | New patients are riskier                            |
| gender                 | Minor effect, included for completeness             |
| insurance              | Insured patients show up more reliably              |
"""

import numpy as np
import pandas as pd
from pathlib import Path

np.random.seed(42)
N = 5000

# ── Base features ───────────────────────────────────────────────────────────
lead_time_days       = np.random.exponential(scale=12, size=N).clip(0, 60).astype(int)
prior_no_shows       = np.random.choice([0,1,2,3,4], size=N, p=[0.55,0.22,0.12,0.07,0.04])
day_of_week          = np.random.choice(['monday','tuesday','wednesday','thursday','friday','saturday'], size=N,
                                         p=[0.18,0.17,0.18,0.17,0.18,0.12])
appointment_hour     = np.random.choice(range(8,19), size=N,
                                         p=[0.12,0.12,0.11,0.10,0.09,0.09,0.08,0.08,0.07,0.07,0.07])
age                  = np.random.normal(loc=38, scale=14, size=N).clip(18, 80).astype(int)
distance_km          = np.random.exponential(scale=6, size=N).clip(0.5, 40)
reminder_sent        = np.random.choice([0,1], size=N, p=[0.35,0.65])
treatment_cost       = np.random.choice([400,600,700,800,1200,3500,5500,7500,8000,18000], size=N,
                                         p=[0.08,0.12,0.10,0.15,0.18,0.08,0.12,0.07,0.06,0.04])
treatment_category   = np.random.choice(['preventive','restorative','cosmetic','surgical','diagnostic','orthodontic'],
                                         size=N, p=[0.25,0.30,0.10,0.12,0.13,0.10])
previous_appointments= np.random.choice(range(0,15), size=N,
                                         p=[0.12,0.15,0.13,0.11,0.10,0.08,0.07,0.06,0.05,0.04,0.03,0.02,0.02,0.01,0.01])
gender               = np.random.choice(['male','female','other'], size=N, p=[0.47,0.50,0.03])
has_insurance        = np.random.choice([0,1], size=N, p=[0.45,0.55])
month                = np.random.choice(range(1,13), size=N)
is_follow_up         = np.random.choice([0,1], size=N, p=[0.60,0.40])

# ── Realistic no-show probability (logistic function of features) ────────────
def compute_logit(row):
    score = -1.5                                         # base intercept
    score += 0.045  * row['lead_time_days']              # longer wait → more no-show
    score += 0.55   * row['prior_no_shows']              # strongest predictor
    score += 0.0045 * max(0, 35 - row['age'])            # younger → riskier
    score += 0.030  * row['distance_km']                 # farther → riskier
    score -= 0.65   * row['reminder_sent']               # reminder helps a lot
    score -= 0.00008* row['treatment_cost']              # high cost → shows up
    score -= 0.40   * row['has_insurance']               # insured → shows up
    score -= 0.30   * min(row['previous_appointments'],8)/ 8  # loyal patient
    score += 0.25   * (1 - row['is_follow_up'])          # new appt riskier
    # day effect
    day_effect = {'monday':0.15,'friday':0.20,'saturday':0.25,
                  'tuesday':-0.05,'wednesday':-0.10,'thursday':-0.05}
    score += day_effect.get(row['day_of_week'], 0)
    # hour effect: early morning & late afternoon riskier
    if   row['appointment_hour'] <= 9:  score += 0.20
    elif row['appointment_hour'] >= 17: score += 0.15
    # treatment category
    cat_effect = {'cosmetic':0.25,'preventive':0.10,'restorative':-0.05,
                  'surgical':-0.30,'diagnostic':0.05,'orthodontic':-0.10}
    score += cat_effect.get(row['treatment_category'], 0)
    return score

df = pd.DataFrame({
    'lead_time_days':        lead_time_days,
    'prior_no_shows':        prior_no_shows,
    'day_of_week':           day_of_week,
    'appointment_hour':      appointment_hour,
    'age':                   age,
    'distance_km':           distance_km.round(2),
    'reminder_sent':         reminder_sent,
    'treatment_cost':        treatment_cost,
    'treatment_category':    treatment_category,
    'previous_appointments': previous_appointments,
    'gender':                gender,
    'has_insurance':         has_insurance,
    'month':                 month,
    'is_follow_up':          is_follow_up,
})

logits   = df.apply(compute_logit, axis=1)
probs    = 1 / (1 + np.exp(-logits))
noise    = np.random.normal(0, 0.04, size=N)            # small real-world noise
probs    = (probs + noise).clip(0.01, 0.99)
labels   = (np.random.uniform(size=N) < probs).astype(int)

df['no_show_probability'] = probs.round(4)
df['no_show']             = labels

# ── Save ────────────────────────────────────────────────────────────────────
out = Path(__file__).parent / 'appointments.csv'
df.to_csv(out, index=False)

total   = len(df)
noshows = df['no_show'].sum()
print(f"✅  Dataset saved  →  {out}")
print(f"    Rows          :  {total:,}")
print(f"    No-shows      :  {noshows:,}  ({noshows/total*100:.1f}%)")
print(f"    Shows         :  {total-noshows:,}  ({(total-noshows)/total*100:.1f}%)")
print(f"\n    Feature means :")
print(df[['lead_time_days','prior_no_shows','age','distance_km']].mean().round(2).to_string(header=False))
