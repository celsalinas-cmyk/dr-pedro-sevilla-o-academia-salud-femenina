-- 004_admin_operations_and_reconciliation.sql
-- NOVARUM Commerce Engine - Gate 2-A3-A1 Incremental Migration
-- Nominal Operator Auth, Revocable Sessions, Permanent Payment Reconciliations, and Immutable Audit Triggers
-- Fully transactional, preserves pre-existing orders/events, and re-executable without errors

-- 1. ADMIN_OPERATORS (Nominal operator bootstrap per academy, no enterprise user CRUD)
CREATE TABLE IF NOT EXISTS admin_operators (
    academy_id VARCHAR(64) NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    operator_id VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('academic_operator', 'finance_verifier', 'academy_admin')),
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (academy_id, operator_id)
);

-- 2. ADMIN_SESSIONS (Server-backed revocable sessions with max 8h TTL and CSRF binding)
CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    operator_id VARCHAR(64) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    csrf_token VARCHAR(64) NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoke_reason VARCHAR(128),
    FOREIGN KEY (academy_id, operator_id) REFERENCES admin_operators(academy_id, operator_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_operator
ON admin_sessions (academy_id, operator_id);

-- 3. PAYMENT_RECONCILIATIONS (Permanent reconciliation identity & evidence per bank deposit)
CREATE TABLE IF NOT EXISTS payment_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    order_id UUID NOT NULL,
    reallocated_from_order_id UUID,
    recipient_account_id VARCHAR(64) NOT NULL,
    verified_amount_minor INTEGER NOT NULL CHECK (verified_amount_minor > 0),
    verified_currency VARCHAR(3) NOT NULL DEFAULT 'BOB',
    bank_credit_at TIMESTAMPTZ NOT NULL,
    reconciliation_mode VARCHAR(32) NOT NULL CHECK (reconciliation_mode IN ('standard_reference', 'manual_resolution')),
    bank_reference VARCHAR(64),
    reconciliation_evidence TEXT NOT NULL,
    settlement_status VARCHAR(32) NOT NULL CHECK (settlement_status IN ('applied', 'reversed_mistaken_match', 'refunded_or_annulled')),
    verified_by_operator_id VARCHAR(64) NOT NULL,
    reversed_by_operator_id VARCHAR(64),
    reversal_reason TEXT,
    reversal_compensation_ref VARCHAR(128),
    reversed_at TIMESTAMPTZ,
    reallocated_by_operator_id VARCHAR(64),
    reallocation_reason TEXT,
    reallocated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (academy_id, order_id) REFERENCES orders(academy_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (academy_id, reallocated_from_order_id) REFERENCES orders(academy_id, id) ON DELETE RESTRICT
);

-- Unconditional reservation of bank_reference across ALL settlement_status values
-- ('applied', 'reversed_mistaken_match', 'refunded_or_annulled')
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reconciliations_bank_ref
ON payment_reconciliations (academy_id, recipient_account_id, bank_reference)
WHERE bank_reference IS NOT NULL;

-- At most one active ('applied') reconciliation per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reconciliations_active_order
ON payment_reconciliations (academy_id, order_id)
WHERE settlement_status = 'applied';

CREATE INDEX IF NOT EXISTS idx_payment_reconciliations_academy_order
ON payment_reconciliations (academy_id, order_id);

-- 4. OPERATIONAL INDEXES FOR ORDER QUEUES & AUDIT LOGS
CREATE INDEX IF NOT EXISTS idx_orders_academy_status_created
ON orders (academy_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_events_academy_order_created
ON order_events (academy_id, order_id, created_at ASC);

-- 5. IMMUTABILITY TRIGGERS (Append-only order_events & no-delete payment_reconciliations)
CREATE OR REPLACE FUNCTION prevent_order_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ORDER_EVENTS_IMMUTABLE: order_events table is strictly append-only (% prohibited)', TG_OP
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_events_immutable ON order_events;
CREATE TRIGGER trg_order_events_immutable
BEFORE UPDATE OR DELETE ON order_events
FOR EACH ROW
EXECUTE FUNCTION prevent_order_events_mutation();

CREATE OR REPLACE FUNCTION prevent_payment_reconciliations_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'PAYMENT_RECONCILIATIONS_IMMUTABLE: payment_reconciliations records cannot be deleted'
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_reconciliations_no_delete ON payment_reconciliations;
CREATE TRIGGER trg_payment_reconciliations_no_delete
BEFORE DELETE ON payment_reconciliations
FOR EACH ROW
EXECUTE FUNCTION prevent_payment_reconciliations_delete();
