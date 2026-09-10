const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let createClient;
try {
  createClient = require('../backend/node_modules/@supabase/supabase-js').createClient;
} catch (e) {
  createClient = require('@supabase/supabase-js').createClient;
}

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

async function pollAndExtract() {
  console.log(`📡 Monitoring Supabase resumption status at: ${supabaseUrl}...`);
  let isResumed = false;
  let attempts = 0;

  while (!isResumed && attempts < 60) {
    attempts++;
    try {
      // Test simple ping query
      const { data, error } = await supabase.from('users').select('count', { count: 'exact', head: true });
      if (!error) {
        isResumed = true;
        console.log(`\n🎉 SUPABASE IS FULLY RESUMED & ONLINE! Starting data extraction...`);
        break;
      }
      console.log(`[Attempt ${attempts}/60] Supabase still resuming... (${error.message.slice(0, 60)})`);
    } catch (err) {
      console.log(`[Attempt ${attempts}/60] Waiting for Supabase web server to start...`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  if (!isResumed) {
    console.log('⚠️ Timed out waiting for Supabase. Please check Supabase Dashboard status.');
    return;
  }

  // Extract all data
  const summary = {};
  for (const table of tables) {
    try {
      console.log(`📥 Downloading table: "${table}"...`);
      const { data, error } = await supabase.from(table).select('*');
      if (error) {
        console.error(`❌ Table "${table}":`, error.message);
        summary[table] = { status: 'ERROR', message: error.message };
      } else {
        const rows = data || [];
        const filePath = path.join(exportDir, `${table}.json`);
        fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
        console.log(`✅ Saved ${rows.length} rows to ${filePath}`);
        summary[table] = { status: 'SUCCESS', count: rows.length };
      }
    } catch (err) {
      summary[table] = { status: 'ERROR', message: err.message };
    }
  }

  console.log('\n📊 Extraction Summary:');
  console.table(summary);
  console.log('\n✨ Extraction completed successfully!');
}

pollAndExtract();
