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
  
  const client = await customDb.getClient();
  try {
    // Acquire PostgreSQL transactional advisory lock to prevent race conditions between runners
    // Key hash for 'novarum_commerce_migrations'
    await client.query('SELECT pg_advisory_lock(847291048)');

    // Migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    for (const file of files) {
      if (file.endsWith('.sql')) {
        const isApplied = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [file]
        );

        if (isApplied.rows.length === 0) {
          console.log(`[Migrations] Executing ${file}...`);
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query(
              'INSERT INTO schema_migrations (version) VALUES ($1)',
              [file]
            );
            await client.query('COMMIT');
            console.log(`[Migrations] Successfully applied ${file}.`);
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        } else {
          console.log(`[Migrations] Skipping already applied ${file}.`);
        }
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(847291048)');
    } catch (_) {}
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      console.log('[Migrations] All migrations completed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migrations] Migration failed:', err);
      process.exit(1);
    });
}
