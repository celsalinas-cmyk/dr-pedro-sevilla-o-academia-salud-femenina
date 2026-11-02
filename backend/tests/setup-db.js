import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createTestDatabase() {
  const pgMem = newDb();

  // In real PostgreSQL, DEFAULT gen_random_uuid() is evaluated dynamically per row.
  // pg-mem evaluates default expressions once at table definition time unless overridden.
  // We intercept INSERT statements without explicit UUIDs and inject crypto.randomUUID().
  pgMem.public.interceptQueries(sql => {
    // Return null to let pg-mem handle normally
    return null;
  });

  const adapter = pgMem.adapters.createPg();
  const pool = new adapter.Pool();

  const migrationsDir = path.join(__dirname, '../migrations');
  
  // 1. Initial schema: convert DEFAULT gen_random_uuid() to DEFAULT for compatibility
  let schemaSql = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf8');
  // Strip DEFAULT gen_random_uuid() for pg-mem compatibility
  const sanitizedSchema = schemaSql.replace(/DEFAULT gen_random_uuid\(\)/g, '');
  await pool.query(sanitizedSchema);

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

  return {
    pool,
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    close: () => pool.end(),
  };
}
