#!/usr/bin/env python3
"""
SmileClinic DMS — Command-Line CSV Exporter
Usage:
  python3 export_csv.py
  python3 export_csv.py --out my_exports_folder
"""

import sqlite3
import csv
import os
import sys
import zipfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / "database" / "clinic.db"
DEFAULT_OUT_DIR = BASE_DIR / "exports"

def export_data(db_path=DEFAULT_DB_PATH, out_dir=DEFAULT_OUT_DIR):
    if not os.path.exists(db_path):
        print(f"❌ Error: Database file not found at '{db_path}'")
        sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    # Get list of all user tables
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    tables = [row["name"] for row in cur.fetchall()]

    print("=" * 60)
    print("🏥 SmileClinic DMS — CSV Data Exporter")
    print("=" * 60)
    print(f"📁 Database: {db_path}")
    print(f"📂 Output Directory: {out_dir}\n")

    generated_files = []

    # 1. Export standard database tables
    print("📦 Exporting Raw Database Tables...")
    for tbl in sorted(tables):
        cur.execute(f"SELECT * FROM {tbl}")
        rows = cur.fetchall()
        csv_filepath = os.path.join(out_dir, f"{tbl}.csv")
        
        if rows:
            headers = rows[0].keys()
            with open(csv_filepath, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(headers)
                for r in rows:
                    writer.writerow([r[h] for h in headers])
            count = len(rows)
        else:
            with open(csv_filepath, 'w', newline='', encoding='utf-8') as f:
                f.write("# Empty table\n")
            count = 0

        print(f"  ✅ {tbl.ljust(20)} → {count} rows → {os.path.basename(csv_filepath)}")
        generated_files.append(csv_filepath)

    print("\n📊 Generating Enriched & Human-Readable CSV Reports...")

    # 2. Enriched Patients View
    cur.execute("""
        SELECT 
            p.patient_id,
            p.first_name,
            p.last_name,
            u.email AS login_email,
            u.raw_password AS login_password,
            p.phone,
            p.date_of_birth,
            p.gender,
            p.blood_group,
            p.allergies,
            p.address,
            p.medical_notes,
            p.created_at
        FROM patients p
        LEFT JOIN users u ON u.user_id = p.user_id
        ORDER BY p.patient_id ASC
    """)
    rows = cur.fetchall()
    if rows:
        fn = os.path.join(out_dir, "patients_enriched.csv")
        with open(fn, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(rows[0].keys())
            for r in rows:
                w.writerow([r[k] for k in rows[0].keys()])
        print(f"  ⭐ patients_enriched.csv  → {len(rows)} rows (with login email & passwords)")
        generated_files.append(fn)

    # 3. Enriched Appointments View
    cur.execute("""
        SELECT 
            a.appointment_id,
            p.first_name || ' ' || p.last_name AS patient_name,
            p.phone AS patient_phone,
            d.first_name || ' ' || d.last_name AS doctor_name,
            d.specialisation AS doctor_specialty,
            a.scheduled_at,
            a.duration_mins,
            a.status,
            a.priority,
            a.reason,
            a.notes AS consultation_notes,
            a.risk_level,
            a.no_show_probability
        FROM appointments a
        LEFT JOIN patients p ON p.patient_id = a.patient_id
        LEFT JOIN doctors d ON d.doctor_id = a.doctor_id
        ORDER BY a.scheduled_at DESC
    """)
    rows = cur.fetchall()
    if rows:
        fn = os.path.join(out_dir, "appointments_enriched.csv")
        with open(fn, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(rows[0].keys())
            for r in rows:
                w.writerow([r[k] for k in rows[0].keys()])
        print(f"  ⭐ appointments_enriched.csv → {len(rows)} rows (with patient & doctor details)")
        generated_files.append(fn)

    # 4. Enriched Prescriptions View
    cur.execute("""
        SELECT 
            pr.prescription_id,
            pr.appointment_id,
            p.first_name || ' ' || p.last_name AS patient_name,
            d.first_name || ' ' || d.last_name AS doctor_name,
            pr.diagnosis,
            pr.medications,
            pr.advice,
            pr.issued_at
        FROM prescriptions pr
        LEFT JOIN patients p ON p.patient_id = pr.patient_id
        LEFT JOIN doctors d ON d.doctor_id = pr.doctor_id
        ORDER BY pr.issued_at DESC
    """)
    rows = cur.fetchall()
    if rows:
        fn = os.path.join(out_dir, "prescriptions_enriched.csv")
        with open(fn, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(rows[0].keys())
            for r in rows:
                w.writerow([r[k] for k in rows[0].keys()])
        print(f"  ⭐ prescriptions_enriched.csv → {len(rows)} rows (with patient & doctor details)")
        generated_files.append(fn)

    # 5. Enriched Invoices View
    cur.execute("""
        SELECT 
            i.invoice_id,
            'INV-' || printf('%05d', i.invoice_id) AS invoice_number,
            p.first_name || ' ' || p.last_name AS patient_name,
            i.subtotal,
            i.discount AS discount_amount,
            i.tax_amount,
            i.total_amount,
            i.payment_status,
            i.payment_method,
            i.issued_at,
            i.paid_at
        FROM invoices i
        LEFT JOIN patients p ON p.patient_id = i.patient_id
        ORDER BY i.issued_at DESC
    """)
    rows = cur.fetchall()
    if rows:
        fn = os.path.join(out_dir, "invoices_enriched.csv")
        with open(fn, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(rows[0].keys())
            for r in rows:
                w.writerow([r[k] for k in rows[0].keys()])
        print(f"  ⭐ invoices_enriched.csv  → {len(rows)} rows (with billing totals & payment status)")
        generated_files.append(fn)

    # 6. Create Zip Archive of all CSVs
    zip_filename = os.path.join(out_dir, "smileclinic_all_csvs.zip")
    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for fpath in generated_files:
            zipf.write(fpath, os.path.basename(fpath))
    
    print("\n" + "=" * 60)
    print(f"🎉 EXPORT COMPLETE! All files written to:\n   👉 {os.path.abspath(out_dir)}")
    print(f"📦 Master Zip Archive Created:\n   👉 {os.path.abspath(zip_filename)}")
    print("=" * 60)

if __name__ == "__main__":
    out = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] in ("-o", "--out") else DEFAULT_OUT_DIR
    export_data(out_dir=Path(out))
