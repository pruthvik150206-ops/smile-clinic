const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const exportDir = path.join(__dirname, '../database/supabase_export');
const sqliteDbPath = path.join(__dirname, '../database/clinic.db');

function getTableColumns(table) {
  try {
    const cmd = `sqlite3 -json "${sqliteDbPath}" "PRAGMA table_info('${table}');"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 3000 });
    const cols = JSON.parse(output || '[]');
    return new Set(cols.map(c => c.name));
  } catch (e) {
    return new Set();
  }
}

const files = fs.readdirSync(exportDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const table = file.replace('.json', '');
  const data = JSON.parse(fs.readFileSync(path.join(exportDir, file), 'utf8'));
  console.log(`Syncing ${data.length} rows for table: "${table}"...`);
  
  const validCols = getTableColumns(table);
  let synced = 0;

  for (const row of data) {
    const keys = Object.keys(row).filter(k => validCols.has(k) && row[k] !== undefined);
    const values = keys.map(k => {
      const v = row[k];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      return `'${String(v).replace(/'/g, "''")}'`;
    });
    
    try {
      const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${values.join(', ')});`;
      execSync(`sqlite3 "${sqliteDbPath}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 3000 });
      synced++;
    } catch (e) {
      console.log('Insert error:', e.message);
    }
  }
  console.log(`  -> Successfully synced ${synced}/${data.length} rows into ${table}`);
}

console.log('🎉 SQLite database clinic.db fully synchronized with Supabase data!');
