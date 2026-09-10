let createClient;
try {
  createClient = require('../backend/node_modules/@supabase/supabase-js').createClient;
} catch (e) {
  createClient = require('@supabase/supabase-js').createClient;
}
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const supabaseUrl = process.env.SUPABASE_URL || 'https://iyqkzdhhkkmhrebsfril.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5cWt6ZGhoa2ttaHJlYnNmcmlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTMwNDI0MCwiZXhwIjoyMTAwODgwMjQwfQ.l47JeuD6hKtElQ92DAGd8I_js3aGiWZUE-fw2Q88e0A';

const supabase = createClient(supabaseUrl, supabaseKey);
const exportDir = path.join(__dirname, '../database/supabase_export');
const sqliteDbPath = path.join(__dirname, '../database/clinic.db');

if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

const tables = [
  'users',
  'patients',
  'doctors',
  'appointments',
  'treatments',
  'invoices',
  'prescriptions',
  'ml_predictions'
];

async function extractAndSync() {
  console.log('🚀 Connecting to Supabase at:', supabaseUrl);
  const summary = {};

  for (const table of tables) {
    try {
      console.log(`📥 Fetching data for table: "${table}"...`);
      const { data, error } = await supabase.from(table).select('*');
      
      if (error) {
        console.error(`⚠️ Could not fetch table "${table}":`, error.message);
        summary[table] = { status: 'ERROR', message: error.message };
        continue;
      }

      const rows = data || [];
      const filePath = path.join(exportDir, `${table}.json`);
      fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
      console.log(`✅ Saved ${rows.length} rows to ${filePath}`);
      summary[table] = { status: 'SUCCESS', count: rows.length };

      // Optional: Sync to local SQLite database/clinic.db
      if (rows.length > 0) {
        try {
          for (const row of rows) {
            // Escape single quotes for SQLite insertion
            const keys = Object.keys(row);
            const values = keys.map(k => {
              const val = row[k];
              if (val === null || val === undefined) return 'NULL';
              if (typeof val === 'number' || typeof val === 'boolean') return val;
              return `'${String(val).replace(/'/g, "''")}'`;
            });

            const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${values.join(', ')});`;
            execSync(`sqlite3 "${sqliteDbPath}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 3000 });
          }
          console.log(`🔄 Synced ${rows.length} rows into local clinic.db`);
        } catch (sqliteErr) {
          console.log(`(Note: SQLite sync for ${table}: ${sqliteErr.message})`);
        }
      }

    } catch (err) {
      console.error(`❌ Unexpected error on table "${table}":`, err.message);
      summary[table] = { status: 'ERROR', message: err.message };
    }
  }

  console.log('\n📊 Extraction Summary:');
  console.table(summary);
  return summary;
}

if (require.main === module) {
  extractAndSync();
}

module.exports = extractAndSync;
