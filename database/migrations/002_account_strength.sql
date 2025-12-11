-- Account Strength Metrics and Strengthening Service
-- Run this SQL in your Supabase SQL Editor

-- Account strength metrics table
CREATE TABLE IF NOT EXISTS account_strength_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Metrics
  account_age_days INTEGER DEFAULT 0,
  total_messages_sent INTEGER DEFAULT 0,
  total_messages_received INTEGER DEFAULT 0,
  unique_contacts_count INTEGER DEFAULT 0,
  avg_messages_per_day DECIMAL(10, 2) DEFAULT 0,
  max_messages_per_hour INTEGER DEFAULT 0,
  engagement_rate DECIMAL(5, 2) DEFAULT 0, -- percentage of sent messages that got replies
  last_message_sent_at TIMESTAMP WITH TIME ZONE,
  last_message_received_at TIMESTAMP WITH TIME ZONE,
  profile_complete BOOLEAN DEFAULT false,
  
  -- Risk factors
  consecutive_failed_sends INTEGER DEFAULT 0,
  spam_report_count INTEGER DEFAULT 0,
  unusual_activity_flags INTEGER DEFAULT 0,
  
  -- Calculated score (0-100)
  strength_score INTEGER DEFAULT 0,
  ban_risk_level TEXT DEFAULT 'low', -- 'low', 'medium', 'high', 'critical'
  
  -- Last calculated
  calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(session_id)
);

-- Strengthening service logs
CREATE TABLE IF NOT EXISTS strengthening_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  service_type TEXT NOT NULL, -- 'profile_update', 'message_simulation', 'contact_sync', 'status_update', 'idle_period'
  service_status TEXT DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  service_details JSONB,
  cost_iqd DECIMAL(10, 2) DEFAULT 0,
  
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_account_strength_metrics_session_id ON account_strength_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_account_strength_metrics_user_id ON account_strength_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_strengthening_logs_session_id ON strengthening_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_strengthening_logs_user_id ON strengthening_logs(user_id);

-- Function to update account strength metrics
CREATE OR REPLACE FUNCTION update_account_strength_metrics(p_session_id TEXT)
RETURNS void AS $$
DECLARE
  v_account_age_days INTEGER;
  v_total_sent INTEGER;
  v_total_received INTEGER;
  v_unique_contacts INTEGER;
  v_avg_per_day DECIMAL(10, 2);
  v_max_per_hour INTEGER;
  v_engagement_rate DECIMAL(5, 2);
  v_strength_score INTEGER;
  v_ban_risk TEXT;
  v_profile_complete BOOLEAN;
  v_session_created TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get account age
  SELECT created_at INTO v_session_created
  FROM whatsapp_sessions
  WHERE session_id = p_session_id;
  
  v_account_age_days := COALESCE(EXTRACT(DAY FROM NOW() - v_session_created)::INTEGER, 0);
  
  -- Count messages (using automation_logs as proxy)
  SELECT 
    COUNT(*) FILTER (WHERE type IN ('otp', 'announcement', 'api_message')),
    COUNT(DISTINCT recipient)
  INTO v_total_sent, v_unique_contacts
  FROM automation_logs
  WHERE session_id = p_session_id AND status = 'sent';
  
  -- Calculate averages (simplified - would need more detailed tracking)
  v_avg_per_day := CASE 
    WHEN v_account_age_days > 0 THEN v_total_sent::DECIMAL / v_account_age_days 
    ELSE 0 
  END;
  
  -- Get max messages per hour from recent activity (last 24 hours)
  SELECT COALESCE(MAX(hourly_count), 10) INTO v_max_per_hour
  FROM (
    SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as hourly_count
    FROM automation_logs
    WHERE session_id = p_session_id 
      AND status = 'sent'
      AND created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY DATE_TRUNC('hour', created_at)
  ) AS hourly_stats;
  
  -- Calculate engagement rate from messages with replies (simplified - would need message tracking)
  -- For now, use a baseline based on account age and message volume
  v_engagement_rate := CASE
    WHEN v_account_age_days > 7 AND v_total_sent > 5 THEN 25.0
    WHEN v_account_age_days > 3 AND v_total_sent > 2 THEN 15.0
    ELSE 5.0
  END;
  
  v_profile_complete := true; -- Assume complete for now
  
  -- Calculate strength score (0-100) with improved formula
  v_strength_score := LEAST(100, GREATEST(0,
    -- Account age contributes up to 20 points (15 days = max)
    LEAST(20, v_account_age_days * 1.33) +
    -- Message volume contributes up to 30 points (20 messages = max)
    LEAST(30, (v_total_sent / 20.0) * 30) +
    -- Unique contacts contribute up to 25 points (10 contacts = max)
    LEAST(25, (v_unique_contacts / 10.0) * 25) +
    -- Message consistency contributes up to 15 points (avg 1+ msg/day = max)
    LEAST(15, v_avg_per_day * 15) +
    -- Engagement contributes up to 10 points (if we have engagement data)
    (v_engagement_rate / 100.0) * 10
  ));
  
  -- Determine ban risk level
  v_ban_risk := CASE
    WHEN v_strength_score >= 80 THEN 'low'
    WHEN v_strength_score >= 60 THEN 'medium'
    WHEN v_strength_score >= 40 THEN 'high'
    ELSE 'critical'
  END;
  
  -- Upsert metrics
  INSERT INTO account_strength_metrics (
    session_id,
    user_id,
    account_age_days,
    total_messages_sent,
    total_messages_received,
    unique_contacts_count,
    avg_messages_per_day,
    max_messages_per_hour,
    engagement_rate,
    profile_complete,
    strength_score,
    ban_risk_level,
    calculated_at,
    updated_at
  )
  SELECT
    p_session_id,
    user_id,
    v_account_age_days,
    v_total_sent,
    0, -- v_total_received (would need tracking)
    v_unique_contacts,
    v_avg_per_day,
    v_max_per_hour,
    v_engagement_rate,
    v_profile_complete,
    v_strength_score,
    v_ban_risk,
    NOW(),
    NOW()
  FROM whatsapp_sessions
  WHERE session_id = p_session_id
  ON CONFLICT (session_id) DO UPDATE SET
    account_age_days = EXCLUDED.account_age_days,
    total_messages_sent = EXCLUDED.total_messages_sent,
    total_messages_received = EXCLUDED.total_messages_received,
    unique_contacts_count = EXCLUDED.unique_contacts_count,
    avg_messages_per_day = EXCLUDED.avg_messages_per_day,
    max_messages_per_hour = EXCLUDED.max_messages_per_hour,
    engagement_rate = EXCLUDED.engagement_rate,
    profile_complete = EXCLUDED.profile_complete,
    strength_score = EXCLUDED.strength_score,
    ban_risk_level = EXCLUDED.ban_risk_level,
    calculated_at = NOW(),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

