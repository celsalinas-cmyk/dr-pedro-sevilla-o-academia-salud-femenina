-- 005_social_inquiries_followup.sql
-- NOVARUM Social Commerce & Enrollment Engine - Gate 2-A3-B1 Incremental Migration
-- Multi-Academy Omnichannel Social Inquiries (Mini CRM) & Append-Only Follow-up Audit Trail
-- Designed for 'dr-sevilla' (Academia Mujer Sana) and future academies (e.g., 'techpro')

-- 1. SOCIAL_INQUIRIES (Omnichannel prospect follow-up queue scoped by academy_id)
CREATE TABLE IF NOT EXISTS social_inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL REFERENCES academies(id) ON DELETE RESTRICT,
    channel VARCHAR(32) NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'tiktok', 'facebook', 'web')),
    interested_sku VARCHAR(64) NOT NULL,
    contact_name VARCHAR(128) NOT NULL,
    contact_handle VARCHAR(128),
    email_normalized VARCHAR(255),
    phone VARCHAR(32),
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    assigned_operator_id VARCHAR(64),
    followup_status VARCHAR(32) NOT NULL DEFAULT 'new_inquiry' CHECK (
        followup_status IN (
            'new_inquiry',
            'contacted',
            'checkout_link_sent',
            'order_created',
            'paid_verified',
            'enrolled',
            'closed_no_conversion'
        )
    ),
    last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_action VARCHAR(255),
    next_action_at TIMESTAMPTZ,
    linked_order_id UUID,
    order_linked_by_operator_id VARCHAR(64),
    order_linked_at TIMESTAMPTZ,
    idempotency_key VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    created_by_operator_id VARCHAR(64) NOT NULL,
    updated_by_operator_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (academy_id, id),
    FOREIGN KEY (academy_id, interested_sku) REFERENCES products(academy_id, sku) ON DELETE RESTRICT,
    FOREIGN KEY (academy_id, assigned_operator_id) REFERENCES admin_operators(academy_id, operator_id) ON DELETE RESTRICT,
    FOREIGN KEY (academy_id, linked_order_id) REFERENCES orders(academy_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_social_inquiries_academy_idempotency
ON social_inquiries (academy_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_social_inquiries_queue
ON social_inquiries (academy_id, followup_status, next_action_at ASC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_inquiries_operator
ON social_inquiries (academy_id, assigned_operator_id, followup_status);

CREATE INDEX IF NOT EXISTS idx_social_inquiries_linked_order
ON social_inquiries (academy_id, linked_order_id)
WHERE linked_order_id IS NOT NULL;

-- 2. SOCIAL_INQUIRY_EVENTS (Immutable append-only audit trail for prospect follow-up & order linkage)
CREATE TABLE IF NOT EXISTS social_inquiry_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_id VARCHAR(64) NOT NULL,
    inquiry_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    previous_followup_status VARCHAR(32),
    new_followup_status VARCHAR(32) NOT NULL,
    operator_id VARCHAR(64) NOT NULL,
    notes VARCHAR(500),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (academy_id, inquiry_id) REFERENCES social_inquiries(academy_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_social_inquiry_events_inquiry
ON social_inquiry_events (academy_id, inquiry_id, created_at ASC);

-- 3. IMMUTABILITY TRIGGER ON SOCIAL_INQUIRY_EVENTS
CREATE OR REPLACE FUNCTION prevent_social_inquiry_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SOCIAL_INQUIRY_EVENTS_IMMUTABLE: social_inquiry_events table is strictly append-only (% prohibited)', TG_OP
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_inquiry_events_immutable ON social_inquiry_events;
CREATE TRIGGER trg_social_inquiry_events_immutable
BEFORE UPDATE OR DELETE ON social_inquiry_events
FOR EACH ROW
EXECUTE FUNCTION prevent_social_inquiry_events_mutation();
