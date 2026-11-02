-- 002_seed_dr_sevilla.sql
-- Seed data for MVP tenant: dr-sevilla exclusively
-- Idempotent & Re-executable

-- 1. Insert Academy
INSERT INTO academies (id, slug, legal_name, default_currency, status, billing_entity)
VALUES (
    'dr-sevilla',
    'dr-pedro-sevilla',
    'Dr. Pedro Sevilla — Academia Mujer Sana',
    'BOB',
    'active',
    'Dr. Pedro Sevilla'
) ON CONFLICT (id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name,
    billing_entity = EXCLUDED.billing_entity,
    status = EXCLUDED.status;

-- 2. Insert Products for dr-sevilla
INSERT INTO products (academy_id, sku, title, description, is_active, access_duration_days)
VALUES 
    ('dr-sevilla', 'endometriosis', 'Curso: Endometriosis', 'Identificación temprana de síntomas, diagnóstico oportuno y comprensión integral del dolor pélvico.', TRUE, 180),
    ('dr-sevilla', 'vaginosis', 'Curso: Vaginosis Bacteriana', 'Reconocimiento y equilibrio de la microbiota bacteriana habitual, prevención y criterios de consulta médica.', TRUE, 180),
    ('dr-sevilla', 'sop', 'Curso: Síndrome de Ovario Poliquístico (SOP)', 'Educación sobre el ciclo menstrual, manifestaciones metabólicas, hábitos saludables y seguimiento ginecológico.', TRUE, 180),
    ('dr-sevilla', 'aprende-mujer', 'Curso: Aprende Mujer — Ecosistema Vaginal', 'Comprensión integral de la microbiota vaginal, el rol protector de los lactobacilos y cuidados diarios.', TRUE, 180),
    ('dr-sevilla', 'mujer-informada-4', 'Pack Completo: Mujer Informada (4 Cursos)', 'Acceso integral a los 4 cursos de salud femenina: Endometriosis, Vaginosis, SOP y Aprende Mujer.', TRUE, 180)
ON CONFLICT (academy_id, sku) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active;

-- 3. Insert Prices (Server-side single source of truth)
-- Re-executable: check before insert using CTE / NOT EXISTS
INSERT INTO prices (academy_id, sku, currency, amount_minor, is_current)
SELECT 'dr-sevilla', 'endometriosis', 'BOB', 7900, TRUE
WHERE NOT EXISTS (SELECT 1 FROM prices WHERE academy_id = 'dr-sevilla' AND sku = 'endometriosis' AND is_current = TRUE);

INSERT INTO prices (academy_id, sku, currency, amount_minor, is_current)
SELECT 'dr-sevilla', 'vaginosis', 'BOB', 7900, TRUE
WHERE NOT EXISTS (SELECT 1 FROM prices WHERE academy_id = 'dr-sevilla' AND sku = 'vaginosis' AND is_current = TRUE);

INSERT INTO prices (academy_id, sku, currency, amount_minor, is_current)
SELECT 'dr-sevilla', 'sop', 'BOB', 7900, TRUE
WHERE NOT EXISTS (SELECT 1 FROM prices WHERE academy_id = 'dr-sevilla' AND sku = 'sop' AND is_current = TRUE);

INSERT INTO prices (academy_id, sku, currency, amount_minor, is_current)
SELECT 'dr-sevilla', 'aprende-mujer', 'BOB', 7900, TRUE
WHERE NOT EXISTS (SELECT 1 FROM prices WHERE academy_id = 'dr-sevilla' AND sku = 'aprende-mujer' AND is_current = TRUE);

INSERT INTO prices (academy_id, sku, currency, amount_minor, is_current)
SELECT 'dr-sevilla', 'mujer-informada-4', 'BOB', 19900, TRUE
WHERE NOT EXISTS (SELECT 1 FROM prices WHERE academy_id = 'dr-sevilla' AND sku = 'mujer-informada-4' AND is_current = TRUE);
