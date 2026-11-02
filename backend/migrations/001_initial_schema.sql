-- 001_initial_schema.sql
-- NOVARUM Commerce Engine - Gate 2-A1 Schema
-- Multi-tenant B2C Architecture with strict composite academy_id isolation
-- Transactional & Re-executable (Idempotent DDL)

-- 1. ACADEMIES
CREATE TABLE IF NOT EXISTS academies (
    id VARCHAR(64) PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    legal_name VARCHAR(255) NOT NULL,
    default_currency VARCHAR(3) NOT NULL DEFAULT 'BOB',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    billing_entity VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sequence for monotonic, collision-free order numbering per academy
CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 1001 INCREMENT BY 1;

-- 2. PRODUCTS (Composite PK: academy_id, sku)
CREATE TABLE IF NOT EXISTS products (
    academy_id VARCHAR(64) NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    sku VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    access_duration_days INTEGER DEFAULT 180,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (academy_id, sku)
);

-- 3. PRICES (Composite FK: academy_id, sku -> products)
CREATE TABLE IF NOT EXISTS prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    sku VARCHAR(64) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'BOB',
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to TIMESTAMPTZ,
    FOREIGN KEY (academy_id, sku) REFERENCES products(academy_id, sku) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prices_current_sku 
ON prices (academy_id, sku) 
WHERE is_current = TRUE;

-- 4. LEADS (Scoped unique per academy_id, email_normalized)
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    email_normalized VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_leads_academy_email UNIQUE (academy_id, email_normalized),
    CONSTRAINT uq_leads_academy_lead_id UNIQUE (academy_id, id)
);

-- 5. CONSENTS (Composite FK: academy_id, lead_id -> leads)
CREATE TABLE IF NOT EXISTS consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    lead_id UUID NOT NULL,
    privacy_version VARCHAR(32) NOT NULL,
    terms_accepted BOOLEAN NOT NULL DEFAULT TRUE,
    terms_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (academy_id, lead_id) REFERENCES leads(academy_id, id) ON DELETE CASCADE
);

-- 6. ORDERS (Strict composite FK: academy_id, lead_id -> leads; unique per academy_id, idempotency_key)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    order_number VARCHAR(64) NOT NULL,
    opaque_token VARCHAR(128) NOT NULL UNIQUE,
    lead_id UUID NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'BOB',
    total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor > 0),
    status VARCHAR(32) NOT NULL DEFAULT 'pending_payment',
    idempotency_key UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    utm_source VARCHAR(64),
    utm_medium VARCHAR(64),
    utm_campaign VARCHAR(64),
    utm_content VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_orders_academy_idempotency UNIQUE (academy_id, idempotency_key),
    CONSTRAINT uq_orders_academy_number UNIQUE (academy_id, order_number),
    CONSTRAINT uq_orders_academy_order_id UNIQUE (academy_id, id),
    FOREIGN KEY (academy_id, lead_id) REFERENCES leads(academy_id, id) ON DELETE RESTRICT
);

-- 7. ORDER_ITEMS (Composite FKs: (academy_id, order_id) -> orders, (academy_id, sku) -> products)
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    order_id UUID NOT NULL,
    sku VARCHAR(64) NOT NULL,
    unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor > 0),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    FOREIGN KEY (academy_id, order_id) REFERENCES orders(academy_id, id) ON DELETE CASCADE,
    FOREIGN KEY (academy_id, sku) REFERENCES products(academy_id, sku) ON DELETE RESTRICT
);

-- 8. ORDER_EVENTS (Composite FK: (academy_id, order_id) -> orders)
CREATE TABLE IF NOT EXISTS order_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    order_id UUID NOT NULL,
    previous_status VARCHAR(32),
    new_status VARCHAR(32) NOT NULL,
    reason TEXT,
    operator_id VARCHAR(64),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (academy_id, order_id) REFERENCES orders(academy_id, id) ON DELETE CASCADE
);
