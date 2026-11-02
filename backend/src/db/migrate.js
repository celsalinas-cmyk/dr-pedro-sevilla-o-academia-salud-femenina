import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(customDb = db) {
  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir).sort();

  console.log(`[Migrations] Found ${files.length} migration files.`);
  
  for (const file of files) {
    if (file.endsWith('.sql')) {
      console.log(`[Migrations] Executing ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await customDb.query(sql);
      console.log(`[Migrations] Completed ${file}.`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      console.log('[Migrations] All migrations executed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migrations] Migration failed:', err);
      process.exit(1);
    });
}
