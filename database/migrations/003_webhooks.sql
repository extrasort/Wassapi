-- Webhooks table for customizable notifications
-- Run this SQL in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  
  -- Webhook configuration
  webhook_url TEXT NOT NULL,
  webhook_type TEXT NOT NULL DEFAULT 'otp', -- 'otp', 'announcement', 'all'
  is_active BOOLEAN DEFAULT true,
  
  -- Custom payload configuration (JSON)
  custom_payload JSONB DEFAULT '{}'::jsonb,
  
  -- Success/failure webhook URLs (optional overrides)
  success_webhook_url TEXT,
  failure_webhook_url TEXT,
  
  -- Headers for webhook requests (JSON)
  headers JSONB DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  
  -- Retry configuration
  retry_on_failure BOOLEAN DEFAULT true,
  max_retries INTEGER DEFAULT 3,
  retry_delay_seconds INTEGER DEFAULT 5,
  
  -- Statistics
  total_calls INTEGER DEFAULT 0,
  success_calls INTEGER DEFAULT 0,
  failed_calls INTEGER DEFAULT 0,
  last_called_at TIMESTAMP WITH TIME ZONE,
  last_success_at TIMESTAMP WITH TIME ZONE,
  last_failure_at TIMESTAMP WITH TIME ZONE,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id, session_id, webhook_type)
);

-- Webhook call logs
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  
  -- Call details
  event_type TEXT NOT NULL, -- 'otp_sent', 'otp_failed', 'announcement_sent', etc.
  payload JSONB NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  success BOOLEAN DEFAULT false,
  error_message TEXT,
  
  -- Retry information
  attempt_number INTEGER DEFAULT 1,
  is_retry BOOLEAN DEFAULT false,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_session_id ON webhooks(session_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_type ON webhooks(webhook_type);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id ON webhook_logs(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_user_id ON webhook_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at);

-- Function to update webhook statistics
CREATE OR REPLACE FUNCTION update_webhook_stats(p_webhook_id UUID, p_success BOOLEAN)
RETURNS void AS $$
BEGIN
  UPDATE webhooks
  SET 
    total_calls = total_calls + 1,
    success_calls = CASE WHEN p_success THEN success_calls + 1 ELSE success_calls END,
    failed_calls = CASE WHEN NOT p_success THEN failed_calls + 1 ELSE failed_calls END,
    last_called_at = NOW(),
    last_success_at = CASE WHEN p_success THEN NOW() ELSE last_success_at END,
    last_failure_at = CASE WHEN NOT p_success THEN NOW() ELSE last_failure_at END,
    updated_at = NOW()
  WHERE id = p_webhook_id;
END;
$$ LANGUAGE plpgsql;

