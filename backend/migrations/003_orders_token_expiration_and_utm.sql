-- 003_orders_token_expiration_and_utm.sql
-- NOVARUM Commerce Engine - Incremental Migration
-- Adds token_expires_at (dual token validity) and UTM tracking columns to orders table
-- Fully transactional, preserves pre-existing orders, and re-executable without errors

ALTER TABLE orders 
    ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS utm_source VARCHAR(64),
    ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(64),
    ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(64),
    ADD COLUMN IF NOT EXISTS utm_content VARCHAR(64);

-- Backfill token_expires_at for pre-existing legacy orders (expires_at + 30 days)
UPDATE orders 
SET token_expires_at = COALESCE(expires_at + INTERVAL '30 days', NOW() + INTERVAL '30 days')
WHERE token_expires_at IS NULL;

-- Enforce NOT NULL constraint safely after backfill
ALTER TABLE orders 
    ALTER COLUMN token_expires_at SET NOT NULL;
