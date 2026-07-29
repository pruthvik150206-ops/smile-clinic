"""
train.py
─────────────────────────────────────────────────────────────────
No-Show Prediction Pipeline
Dental Clinic DMS  |  ML Module v1.0

Pipeline
─────────
1. Load & validate data
2. Feature engineering  (ordinal encoding, scaling)
3. Train/val/test split  (70/15/15, stratified)
4. Model comparison     (Logistic Regression, Random Forest, GBM)
5. Hyperparameter tuning (GridSearchCV on winner)
6. Probability calibration  (Platt scaling)
7. Threshold optimisation   (F1-maximising)
8. Full evaluation report   (ROC-AUC, PR-AUC, confusion matrix)
9. Save artifacts           (model.pkl, preprocessor.pkl, meta.json)
"""

import json, warnings
import numpy  as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
from pathlib  import Path
from datetime import datetime

from sklearn.model_selection    import train_test_split, GridSearchCV, StratifiedKFold
from sklearn.pipeline           import Pipeline
from sklearn.compose            import ColumnTransformer
from sklearn.preprocessing      import StandardScaler, OrdinalEncoder
from sklearn.linear_model       import LogisticRegression
from sklearn.ensemble           import RandomForestClassifier, GradientBoostingClassifier
from sklearn.calibration        import CalibratedClassifierCV
from sklearn.metrics            import (
    roc_auc_score, average_precision_score,
    classification_report, confusion_matrix,
    roc_curve, precision_recall_curve, f1_score
)
import joblib

warnings.filterwarnings('ignore')
np.random.seed(42)

ROOT     = Path(__file__).parent
DATA_DIR = ROOT.parent / 'data'
MODEL_DIR= ROOT
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# ══════════════════════════════════════════════════════════
#  1. LOAD DATA
# ══════════════════════════════════════════════════════════
print("\n" + "═"*60)
print("  DENTAL CLINIC — NO-SHOW PREDICTION TRAINING PIPELINE")
print("═"*60)

df = pd.read_csv(DATA_DIR / 'appointments.csv')
print(f"\n📂  Loaded {len(df):,} rows,  {df.shape[1]} columns")
print(f"    No-show rate: {df['no_show'].mean()*100:.1f}%")

# ── Feature definitions ──────────────────────────────────
NUMERIC_FEATURES = [
    'lead_time_days', 'prior_no_shows', 'appointment_hour',
    'age', 'distance_km', 'treatment_cost',
    'previous_appointments', 'month',
]
BINARY_FEATURES = ['reminder_sent', 'has_insurance', 'is_follow_up']
CATEGORICAL_FEATURES = [
    'day_of_week', 'treatment_category', 'gender'
]
TARGET = 'no_show'

X = df[NUMERIC_FEATURES + BINARY_FEATURES + CATEGORICAL_FEATURES]
y = df[TARGET]

# ══════════════════════════════════════════════════════════
#  2. TRAIN / VAL / TEST SPLIT
# ══════════════════════════════════════════════════════════
X_tmp,  X_test,  y_tmp,  y_test  = train_test_split(X, y, test_size=0.15, stratify=y, random_state=42)
X_train, X_val,  y_train, y_val  = train_test_split(X_tmp, y_tmp, test_size=0.176, stratify=y_tmp, random_state=42)
# 0.176 of 0.85 ≈ 0.15 of total → 70 / 15 / 15 split

print(f"\n📊  Split  →  Train: {len(X_train):,}  |  Val: {len(X_val):,}  |  Test: {len(X_test):,}")

# ══════════════════════════════════════════════════════════
#  3. PREPROCESSOR
# ══════════════════════════════════════════════════════════
DAY_ORDER = ['monday','tuesday','wednesday','thursday','friday','saturday']
CAT_ORDER = ['preventive','diagnostic','restorative','orthodontic','cosmetic','surgical']
GEN_ORDER = ['female','male','other']

preprocessor = ColumnTransformer(transformers=[
    ('num', StandardScaler(),                NUMERIC_FEATURES + BINARY_FEATURES),
    ('cat', OrdinalEncoder(
        categories=[DAY_ORDER, CAT_ORDER, GEN_ORDER],
        handle_unknown='use_encoded_value',
        unknown_value=-1
    ),                                        CATEGORICAL_FEATURES),
], remainder='drop')

# ══════════════════════════════════════════════════════════
#  4. MODEL COMPARISON
# ══════════════════════════════════════════════════════════
candidates = {
    'Logistic Regression': LogisticRegression(max_iter=1000, class_weight='balanced', random_state=42),
    'Random Forest':       RandomForestClassifier(n_estimators=200, class_weight='balanced', n_jobs=-1, random_state=42),
    'Gradient Boosting':   GradientBoostingClassifier(n_estimators=200, learning_rate=0.08, max_depth=4, random_state=42),
}

print("\n\n🔬  Model comparison on validation set")
print("─"*60)
print(f"  {'Model':<24}  {'ROC-AUC':>9}  {'PR-AUC':>8}  {'F1':>7}")
print("─"*60)

results = {}
for name, clf in candidates.items():
    pipe = Pipeline([('pre', preprocessor), ('clf', clf)])
    pipe.fit(X_train, y_train)
    proba = pipe.predict_proba(X_val)[:,1]
    roc   = roc_auc_score(y_val, proba)
    pr    = average_precision_score(y_val, proba)
    pred  = (proba >= 0.35).astype(int)        # lower threshold for recall
    f1    = f1_score(y_val, pred)
    results[name] = {'pipe': pipe, 'roc': roc, 'pr': pr, 'f1': f1}
    print(f"  {name:<24}  {roc:>9.4f}  {pr:>8.4f}  {f1:>7.4f}")

print("─"*60)

best_name = max(results, key=lambda k: results[k]['roc'])
print(f"\n🏆  Winner: {best_name}  (ROC-AUC = {results[best_name]['roc']:.4f})")

# ══════════════════════════════════════════════════════════
#  5. HYPERPARAMETER TUNING (on winner)
# ══════════════════════════════════════════════════════════
print(f"\n⚙️   Tuning {best_name}…")

if best_name == 'Gradient Boosting':
    param_grid = {
        'clf__n_estimators':   [150, 200, 250],
        'clf__learning_rate':  [0.06, 0.08, 0.10],
        'clf__max_depth':      [3, 4, 5],
        'clf__subsample':      [0.8, 1.0],
    }
    base_clf = GradientBoostingClassifier(random_state=42)
elif best_name == 'Random Forest':
    param_grid = {
        'clf__n_estimators': [200, 300],
        'clf__max_depth':    [None, 10, 20],
        'clf__min_samples_split': [2, 5],
    }
    base_clf = RandomForestClassifier(class_weight='balanced', n_jobs=-1, random_state=42)
else:
    param_grid = {
        'clf__C':        [0.01, 0.1, 1, 10],
        'clf__penalty':  ['l1','l2'],
        'clf__solver':   ['liblinear'],
    }
    base_clf = LogisticRegression(max_iter=1000, class_weight='balanced', random_state=42)

tuned_pipe = Pipeline([('pre', preprocessor), ('clf', base_clf)])
cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
grid = GridSearchCV(tuned_pipe, param_grid, cv=cv, scoring='roc_auc', n_jobs=-1, verbose=0)
grid.fit(X_train, y_train)

best_pipe = grid.best_estimator_
print(f"    Best params : {grid.best_params_}")
print(f"    CV ROC-AUC  : {grid.best_score_:.4f}")

# ══════════════════════════════════════════════════════════
#  6. PROBABILITY CALIBRATION
# ══════════════════════════════════════════════════════════
print("\n🎯  Calibrating probabilities (Platt scaling)…")
calibrated = CalibratedClassifierCV(best_pipe, method='sigmoid', cv=5)
calibrated.fit(X_train, y_train)

# ══════════════════════════════════════════════════════════
#  7. THRESHOLD OPTIMISATION
# ══════════════════════════════════════════════════════════
val_proba    = calibrated.predict_proba(X_val)[:,1]
thresholds   = np.arange(0.15, 0.65, 0.01)
f1_scores    = [f1_score(y_val, (val_proba >= t).astype(int)) for t in thresholds]
best_thresh  = float(thresholds[np.argmax(f1_scores)])
print(f"    Optimal threshold: {best_thresh:.2f}  (F1 = {max(f1_scores):.4f})")

# ══════════════════════════════════════════════════════════
#  8. FINAL EVALUATION ON TEST SET
# ══════════════════════════════════════════════════════════
print("\n\n📈  Final evaluation on held-out TEST set")
print("─"*60)

test_proba = calibrated.predict_proba(X_test)[:,1]
test_pred  = (test_proba >= best_thresh).astype(int)

roc_auc = roc_auc_score(y_test, test_proba)
pr_auc  = average_precision_score(y_test, test_proba)
f1      = f1_score(y_test, test_pred)

print(f"  ROC-AUC score : {roc_auc:.4f}")
print(f"  PR-AUC score  : {pr_auc:.4f}")
print(f"  F1 score      : {f1:.4f}")
print(f"  Threshold used: {best_thresh:.2f}\n")
print("  Classification report:")
report = classification_report(y_test, test_pred, target_names=['Show','No-show'])
print(report)

cm = confusion_matrix(y_test, test_pred)
print(f"  Confusion matrix:\n    TN={cm[0,0]}  FP={cm[0,1]}\n    FN={cm[1,0]}  TP={cm[1,1]}")

# ── Feature importances (if tree-based) ─────────────────
try:
    inner_clf  = best_pipe.named_steps['clf']
    feat_names = NUMERIC_FEATURES + BINARY_FEATURES + CATEGORICAL_FEATURES
    importances= pd.Series(inner_clf.feature_importances_, index=feat_names).sort_values(ascending=False)
    print(f"\n  Top-5 features:")
    for feat, imp in importances.head(5).items():
        bar = '█' * int(imp * 100)
        print(f"    {feat:<28} {imp:.4f}  {bar}")
except AttributeError:
    pass

# ══════════════════════════════════════════════════════════
#  9. SAVE ARTIFACTS
# ══════════════════════════════════════════════════════════
joblib.dump(calibrated, MODEL_DIR / 'no_show_model.pkl')
joblib.dump(preprocessor, MODEL_DIR / 'preprocessor.pkl')

meta = {
    'model_name':        'no_show_xgboost',
    'model_version':     '2.1',
    'algorithm':         best_name,
    'trained_at':        datetime.utcnow().isoformat(),
    'n_train_samples':   len(X_train),
    'features':          NUMERIC_FEATURES + BINARY_FEATURES + CATEGORICAL_FEATURES,
    'numeric_features':  NUMERIC_FEATURES,
    'binary_features':   BINARY_FEATURES,
    'categorical_features': CATEGORICAL_FEATURES,
    'optimal_threshold': best_thresh,
    'test_metrics': {
        'roc_auc': round(roc_auc, 4),
        'pr_auc':  round(pr_auc,  4),
        'f1':      round(f1,      4),
    },
    'class_labels': {0: 'show', 1: 'no_show'},
}
with open(MODEL_DIR / 'model_meta.json', 'w') as f:
    json.dump(meta, f, indent=2)

print(f"\n\n✅  Artifacts saved:")
print(f"    models/no_show_model.pkl")
print(f"    models/preprocessor.pkl")
print(f"    models/model_meta.json")
print("\n" + "═"*60 + "\n")

# ══════════════════════════════════════════════════════════
#  PLOTS (saved to models/)
# ══════════════════════════════════════════════════════════
fig, axes = plt.subplots(1, 3, figsize=(16, 4))
fig.suptitle('No-Show Prediction — Model Evaluation', fontsize=14, fontweight='bold', y=1.02)

# ROC curve
fpr, tpr, _ = roc_curve(y_test, test_proba)
axes[0].plot(fpr, tpr, color='#2D6A4F', lw=2, label=f'AUC = {roc_auc:.3f}')
axes[0].plot([0,1],[0,1],'--',color='#9E9790',lw=1)
axes[0].fill_between(fpr, tpr, alpha=0.08, color='#2D6A4F')
axes[0].set_xlabel('False Positive Rate'); axes[0].set_ylabel('True Positive Rate')
axes[0].set_title('ROC Curve'); axes[0].legend()

# Precision-Recall curve
prec, rec, _ = precision_recall_curve(y_test, test_proba)
axes[1].plot(rec, prec, color='#52B788', lw=2, label=f'AP = {pr_auc:.3f}')
axes[1].fill_between(rec, prec, alpha=0.08, color='#52B788')
axes[1].set_xlabel('Recall'); axes[1].set_ylabel('Precision')
axes[1].set_title('Precision-Recall Curve'); axes[1].legend()

# Confusion matrix heatmap
sns.heatmap(cm, annot=True, fmt='d', ax=axes[2],
            cmap='Greens', xticklabels=['Show','No-show'], yticklabels=['Show','No-show'],
            linewidths=1, linecolor='white')
axes[2].set_title('Confusion Matrix (Test Set)')
axes[2].set_ylabel('Actual'); axes[2].set_xlabel('Predicted')

plt.tight_layout()
plt.savefig(MODEL_DIR / 'evaluation_plots.png', dpi=150, bbox_inches='tight')
plt.close()
print("📊  Saved evaluation_plots.png")
