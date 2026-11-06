import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createTestDatabase() {
  const pgMem = newDb();

  const adapter = pgMem.adapters.createPg();
  const pool = new adapter.Pool();

  const migrationsDir = path.join(__dirname, '../migrations');
  
  // 1. Initial schema: convert DEFAULT gen_random_uuid() to DEFAULT for compatibility
  let schemaSql = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf8');
  const sanitizedSchema = schemaSql.replace(/DEFAULT gen_random_uuid\(\)/g, '');
  await pool.query(sanitizedSchema);

  // Apply incremental migration 003 for token_expires_at and UTM columns
  const migration003 = fs.readFileSync(path.join(migrationsDir, '003_orders_token_expiration_and_utm.sql'), 'utf8');
  await pool.query(migration003);

  // Apply incremental migration 004 for admin operations, sessions, and payment reconciliations
  // (Strip PL/pgSQL trigger section for pg-mem compatibility; triggers are tested on real PostgreSQL 16)
  let migration004 = fs.readFileSync(path.join(migrationsDir, '004_admin_operations_and_reconciliation.sql'), 'utf8');
  migration004 = migration004
    .split('-- 5. IMMUTABILITY TRIGGERS')[0]
    .replace(/DEFAULT gen_random_uuid\(\)/g, '');
  await pool.query(migration004);

  // Register nextval function in pg-mem
  let seqCounter = 1000;
  pgMem.public.registerFunction({
    name: 'nextval',
    args: [pgMem.public.getType('text')],
    returns: pgMem.public.getType('integer'),
    implementation: () => ++seqCounter,
  });

  // 2. Seed data with explicit IDs
  const seedSql = `
    INSERT INTO academies (id, slug, legal_name, default_currency, status, billing_entity)
    VALUES ('dr-sevilla', 'dr-pedro-sevilla', 'Dr. Pedro Sevilla — Academia Mujer Sana', 'BOB', 'active', 'Dr. Pedro Sevilla');

    INSERT INTO products (academy_id, sku, title, description, is_active, access_duration_days)
    VALUES 
      ('dr-sevilla', 'endometriosis', 'Curso: Endometriosis', 'Identificación temprana de síntomas', TRUE, 180),
      ('dr-sevilla', 'vaginosis', 'Curso: Vaginosis Bacteriana', 'Reconocimiento y equilibrio', TRUE, 180),
      ('dr-sevilla', 'sop', 'Curso: Síndrome de Ovario Poliquístico', 'Educación sobre el ciclo', TRUE, 180),
      ('dr-sevilla', 'aprende-mujer', 'Curso: Aprende Mujer', 'Comprensión integral', TRUE, 180),
      ('dr-sevilla', 'mujer-informada-4', 'Pack Completo: Mujer Informada', 'Acceso integral a los 4 cursos', TRUE, 180);

    INSERT INTO prices (id, academy_id, sku, currency, amount_minor, is_current)
    VALUES 
      ('${crypto.randomUUID()}', 'dr-sevilla', 'endometriosis', 'BOB', 7900, TRUE),
      ('${crypto.randomUUID()}', 'dr-sevilla', 'vaginosis', 'BOB', 7900, TRUE),
      ('${crypto.randomUUID()}', 'dr-sevilla', 'sop', 'BOB', 7900, TRUE),
      ('${crypto.randomUUID()}', 'dr-sevilla', 'aprende-mujer', 'BOB', 7900, TRUE),
      ('${crypto.randomUUID()}', 'dr-sevilla', 'mujer-informada-4', 'BOB', 19900, TRUE);
  `;
  await pool.query(seedSql);

  let activeTxCount = 0;
  let sharedBackup = null;

  return {
    pool,
    query: (text, params) => pool.query(text, params),
    getClient: async () => {
      const rawClient = await pool.connect();
      return {
        query: async (text, params) => {
          const normalized = typeof text === 'string' ? text.trim().toUpperCase() : '';
          if (normalized === 'BEGIN') {
            activeTxCount += 1;
            if (activeTxCount === 1) {
              sharedBackup = pgMem.backup();
            } else {
              sharedBackup = null;
            }
          } else if (normalized === 'COMMIT') {
            activeTxCount = Math.max(0, activeTxCount - 1);
            sharedBackup = null;
          } else if (normalized === 'ROLLBACK') {
            if (sharedBackup && activeTxCount === 1) {
              sharedBackup.restore();
            }
            activeTxCount = Math.max(0, activeTxCount - 1);
            sharedBackup = null;
          }
          return rawClient.query(text, params);
        },
        release: () => rawClient.release(),
      };
    },
    close: () => pool.end(),
  };
}
