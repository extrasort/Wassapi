-- Improved Account Strength Metrics
-- This migration adds more accurate metrics for measuring WhatsApp account health
-- Run this SQL in your Supabase SQL Editor

-- Add new columns to account_strength_metrics table
ALTER TABLE account_strength_metrics 
ADD COLUMN IF NOT EXISTS connection_uptime_hours INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS reconnection_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_connection_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS connection_stability_score INTEGER DEFAULT 0, -- 0-100
ADD COLUMN IF NOT EXISTS profile_picture_exists BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS profile_name_length INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS account_verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS business_account BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS total_chats_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS active_chats_count INTEGER DEFAULT 0, -- chats with messages in last 7 days
ADD COLUMN IF NOT EXISTS message_delivery_rate DECIMAL(5, 2) DEFAULT 100.0, -- percentage
ADD COLUMN IF NOT EXISTS message_read_rate DECIMAL(5, 2) DEFAULT 0.0, -- percentage
ADD COLUMN IF NOT EXISTS failed_message_rate DECIMAL(5, 2) DEFAULT 0.0, -- percentage
ADD COLUMN IF NOT EXISTS block_rate DECIMAL(5, 2) DEFAULT 0.0, -- percentage of contacts that blocked
ADD COLUMN IF NOT EXISTS avg_response_time_hours DECIMAL(10, 2) DEFAULT 0, -- average time to respond
ADD COLUMN IF NOT EXISTS message_distribution_score INTEGER DEFAULT 0, -- 0-100, based on time distribution
ADD COLUMN IF NOT EXISTS burst_detection_count INTEGER DEFAULT 0, -- number of message bursts detected
ADD COLUMN IF NOT EXISTS spam_keyword_count INTEGER DEFAULT 0, -- messages with spam keywords
ADD COLUMN IF NOT EXISTS rate_limit_warnings INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS account_restrictions INTEGER DEFAULT 0, -- number of restrictions received
ADD COLUMN IF NOT EXISTS last_activity_score INTEGER DEFAULT 0, -- 0-100, based on recent activity patterns
ADD COLUMN IF NOT EXISTS two_way_conversation_rate DECIMAL(5, 2) DEFAULT 0.0; -- percentage of contacts that replied

-- Create table to track message delivery status
CREATE TABLE IF NOT EXISTS message_delivery_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id TEXT, -- WhatsApp message ID
  recipient TEXT NOT NULL,
  status TEXT NOT NULL, -- 'sent', 'delivered', 'read', 'failed', 'blocked'
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  delivered_at TIMESTAMP WITH TIME ZONE,
  read_at TIMESTAMP WITH TIME ZONE,
  failed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(message_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_message_delivery_session_id ON message_delivery_tracking(session_id);
CREATE INDEX IF NOT EXISTS idx_message_delivery_user_id ON message_delivery_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_message_delivery_status ON message_delivery_tracking(status);
CREATE INDEX IF NOT EXISTS idx_message_delivery_sent_at ON message_delivery_tracking(sent_at);

-- Create table to track connection events
CREATE TABLE IF NOT EXISTS connection_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'connected', 'disconnected', 'reconnecting', 'error'
  event_details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connection_events_session_id ON connection_events(session_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_created_at ON connection_events(created_at);

-- Create table to track activity patterns
CREATE TABLE IF NOT EXISTS activity_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_date DATE NOT NULL,
  hour_of_day INTEGER NOT NULL, -- 0-23
  message_count INTEGER DEFAULT 0,
  unique_recipients INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(session_id, activity_date, hour_of_day)
);

CREATE INDEX IF NOT EXISTS idx_activity_patterns_session_id ON activity_patterns(session_id);
CREATE INDEX IF NOT EXISTS idx_activity_patterns_date ON activity_patterns(activity_date);

-- Improved function to update account strength metrics with real-time data
CREATE OR REPLACE FUNCTION update_account_strength_metrics_improved(p_session_id TEXT)
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
  
  -- New metrics
  v_connection_uptime_hours INTEGER;
  v_reconnection_count INTEGER;
  v_connection_stability_score INTEGER;
  v_profile_picture_exists BOOLEAN;
  v_profile_name_length INTEGER;
  v_total_chats INTEGER;
  v_active_chats INTEGER;
  v_message_delivery_rate DECIMAL(5, 2);
  v_message_read_rate DECIMAL(5, 2);
  v_failed_message_rate DECIMAL(5, 2);
  v_block_rate DECIMAL(5, 2);
  v_message_distribution_score INTEGER;
  v_burst_detection_count INTEGER;
  v_rate_limit_warnings INTEGER;
  v_last_activity_score INTEGER;
  v_two_way_conversation_rate DECIMAL(5, 2);
BEGIN
  -- Get account age
  SELECT created_at INTO v_session_created
  FROM whatsapp_sessions
  WHERE session_id = p_session_id;
  
  v_account_age_days := COALESCE(FLOOR(EXTRACT(EPOCH FROM (NOW() - v_session_created)) / 86400.0)::INTEGER, 0);
  
  -- Count messages accurately
  SELECT 
    COALESCE(SUM(
      CASE 
        WHEN type = 'announcement' AND recipients IS NOT NULL AND recipients != '' THEN
          jsonb_array_length(recipients::jsonb)
        WHEN type IN ('otp', 'api_message', 'strengthening') THEN 1
        ELSE 0
      END
    ), 0)
  INTO v_total_sent
  FROM automation_logs
  WHERE session_id = p_session_id AND status = 'sent'
    AND type IN ('otp', 'announcement', 'api_message', 'strengthening');
  
  -- Count unique contacts
  WITH expanded_recipients AS (
    SELECT 
      CASE 
        WHEN type = 'announcement' AND recipients IS NOT NULL AND recipients != '' THEN
          jsonb_array_elements_text(recipients::jsonb)::TEXT
        ELSE recipient
      END AS contact
    FROM automation_logs
    WHERE session_id = p_session_id 
      AND status = 'sent'
      AND type IN ('otp', 'announcement', 'api_message', 'strengthening')
      AND (
        (type = 'announcement' AND recipients IS NOT NULL AND recipients != '') 
        OR (type != 'announcement' AND recipient IS NOT NULL)
      )
  )
  SELECT COUNT(DISTINCT contact) INTO v_unique_contacts
  FROM expanded_recipients;
  
  -- Calculate averages
  v_avg_per_day := CASE 
    WHEN v_account_age_days > 0 THEN v_total_sent::DECIMAL / v_account_age_days 
    ELSE 0 
  END;
  
  -- Get max messages per hour from recent activity (last 24 hours)
  SELECT COALESCE(MAX(hourly_count), 0) INTO v_max_per_hour
  FROM (
    SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as hourly_count
    FROM automation_logs
    WHERE session_id = p_session_id 
      AND status = 'sent'
      AND created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY DATE_TRUNC('hour', created_at)
  ) AS hourly_stats;
  
  -- Calculate connection metrics
  SELECT 
    COUNT(*) FILTER (WHERE event_type = 'disconnected'),
    COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 3600, 0)::INTEGER
  INTO v_reconnection_count, v_connection_uptime_hours
  FROM connection_events
  WHERE session_id = p_session_id
    AND created_at >= NOW() - INTERVAL '7 days';
  
  -- Connection stability: 100 - (reconnections * 10), min 0
  v_connection_stability_score := GREATEST(0, 100 - (v_reconnection_count * 10));
  
  -- Message delivery tracking
  SELECT 
    COALESCE(COUNT(*) FILTER (WHERE status IN ('delivered', 'read')), 0)::DECIMAL / 
      NULLIF(COUNT(*), 0) * 100,
    COALESCE(COUNT(*) FILTER (WHERE status = 'read'), 0)::DECIMAL / 
      NULLIF(COUNT(*) FILTER (WHERE status IN ('delivered', 'read')), 0) * 100,
    COALESCE(COUNT(*) FILTER (WHERE status = 'failed'), 0)::DECIMAL / 
      NULLIF(COUNT(*), 0) * 100,
    COALESCE(COUNT(*) FILTER (WHERE status = 'blocked'), 0)::DECIMAL / 
      NULLIF(COUNT(DISTINCT recipient), 0) * 100
  INTO v_message_delivery_rate, v_message_read_rate, v_failed_message_rate, v_block_rate
  FROM message_delivery_tracking
  WHERE session_id = p_session_id
    AND sent_at >= NOW() - INTERVAL '30 days';
  
  -- Default to 100% if no data
  v_message_delivery_rate := COALESCE(v_message_delivery_rate, 100.0);
  v_message_read_rate := COALESCE(v_message_read_rate, 0.0);
  v_failed_message_rate := COALESCE(v_failed_message_rate, 0.0);
  v_block_rate := COALESCE(v_block_rate, 0.0);
  
  -- Message distribution score (check if messages are spread throughout the day)
  -- Good distribution = messages across multiple hours, not all in one hour
  WITH hourly_distribution AS (
    SELECT hour_of_day, SUM(message_count) as msg_count
    FROM activity_patterns
    WHERE session_id = p_session_id
      AND activity_date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY hour_of_day
  )
  SELECT 
    CASE 
      WHEN COUNT(*) >= 8 THEN 100 -- Messages across 8+ hours = excellent
      WHEN COUNT(*) >= 4 THEN 70 -- Messages across 4+ hours = good
      WHEN COUNT(*) >= 2 THEN 40 -- Messages across 2+ hours = fair
      ELSE 10 -- All messages in one hour = poor
    END
  INTO v_message_distribution_score
  FROM hourly_distribution
  WHERE msg_count > 0;
  
  v_message_distribution_score := COALESCE(v_message_distribution_score, 50);
  
  -- Burst detection (more than 20 messages in a single hour)
  SELECT COUNT(*)
  INTO v_burst_detection_count
  FROM (
    SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as hourly_count
    FROM automation_logs
    WHERE session_id = p_session_id 
      AND status = 'sent'
      AND created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE_TRUNC('hour', created_at)
    HAVING COUNT(*) > 20
  ) AS bursts;
  
  -- Two-way conversation rate (contacts that replied)
  -- This would need to be tracked separately, for now use engagement estimate
  v_two_way_conversation_rate := CASE
    WHEN v_account_age_days > 7 AND v_total_sent > 10 THEN 30.0
    WHEN v_account_age_days > 3 AND v_total_sent > 5 THEN 15.0
    ELSE 5.0
  END;
  
  -- Last activity score (activity in last 24-48 hours)
  SELECT 
    CASE 
      WHEN COUNT(*) > 0 THEN 100
      ELSE 0
    END
  INTO v_last_activity_score
  FROM automation_logs
  WHERE session_id = p_session_id
    AND status = 'sent'
    AND created_at >= NOW() - INTERVAL '48 hours';
  
  v_last_activity_score := COALESCE(v_last_activity_score, 0);
  
  -- Calculate engagement rate
  v_engagement_rate := CASE
    WHEN v_account_age_days > 7 AND v_total_sent > 5 THEN 25.0
    WHEN v_account_age_days > 3 AND v_total_sent > 2 THEN 15.0
    ELSE 5.0
  END;
  
  -- Profile completeness (will be updated by real-time checks)
  v_profile_complete := true;
  v_profile_picture_exists := false; -- Will be updated by client checks
  v_profile_name_length := 0; -- Will be updated by client checks
  
  -- IMPROVED STRENGTH SCORE CALCULATION (0-100)
  -- Based on industry best practices for WhatsApp account health
  v_strength_score := LEAST(100, GREATEST(0,
    -- Account age: 15 points (30+ days = max)
    LEAST(15, (v_account_age_days / 30.0) * 15) +
    
    -- Message volume: 20 points (50+ messages = max)
    LEAST(20, (v_total_sent / 50.0) * 20) +
    
    -- Unique contacts: 15 points (20+ contacts = max)
    LEAST(15, (v_unique_contacts / 20.0) * 15) +
    
    -- Message consistency: 10 points (avg 2+ msg/day = max)
    LEAST(10, (v_avg_per_day / 2.0) * 10) +
    
    -- Connection stability: 10 points
    (v_connection_stability_score / 100.0) * 10 +
    
    -- Message delivery rate: 10 points (95%+ = max)
    LEAST(10, (v_message_delivery_rate / 95.0) * 10) +
    
    -- Message read rate: 5 points (50%+ = max)
    LEAST(5, (v_message_read_rate / 50.0) * 5) +
    
    -- Message distribution: 5 points
    (v_message_distribution_score / 100.0) * 5 +
    
    -- Two-way conversations: 5 points (30%+ = max)
    LEAST(5, (v_two_way_conversation_rate / 30.0) * 5) +
    
    -- Activity recency: 5 points
    (v_last_activity_score / 100.0) * 5 -
    
    -- Penalties
    LEAST(10, v_failed_message_rate * 0.5) - -- Failed messages penalty
    LEAST(10, v_block_rate * 2) - -- Block rate penalty (high impact)
    LEAST(5, v_burst_detection_count * 1) - -- Burst detection penalty
    LEAST(5, v_rate_limit_warnings * 2) -- Rate limit warnings penalty
  ));
  
  -- Determine ban risk level with improved thresholds
  v_ban_risk := CASE
    WHEN v_strength_score >= 75 AND v_failed_message_rate < 5 AND v_block_rate < 2 THEN 'low'
    WHEN v_strength_score >= 55 AND v_failed_message_rate < 10 AND v_block_rate < 5 THEN 'medium'
    WHEN v_strength_score >= 35 AND v_failed_message_rate < 20 AND v_block_rate < 10 THEN 'high'
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
    connection_uptime_hours,
    reconnection_count,
    connection_stability_score,
    profile_picture_exists,
    profile_name_length,
    total_chats_count,
    active_chats_count,
    message_delivery_rate,
    message_read_rate,
    failed_message_rate,
    block_rate,
    message_distribution_score,
    burst_detection_count,
    rate_limit_warnings,
    last_activity_score,
    two_way_conversation_rate,
    calculated_at,
    updated_at
  )
  SELECT
    p_session_id,
    user_id,
    v_account_age_days,
    v_total_sent,
    0, -- v_total_received
    v_unique_contacts,
    v_avg_per_day,
    v_max_per_hour,
    v_engagement_rate,
    v_profile_complete,
    v_strength_score,
    v_ban_risk,
    v_connection_uptime_hours,
    v_reconnection_count,
    v_connection_stability_score,
    v_profile_picture_exists,
    v_profile_name_length,
    0, -- v_total_chats (will be updated by real-time checks)
    0, -- v_active_chats (will be updated by real-time checks)
    v_message_delivery_rate,
    v_message_read_rate,
    v_failed_message_rate,
    v_block_rate,
    v_message_distribution_score,
    v_burst_detection_count,
    0, -- v_rate_limit_warnings (will be tracked separately)
    v_last_activity_score,
    v_two_way_conversation_rate,
    NOW(),
    NOW()
  FROM whatsapp_sessions
  WHERE session_id = p_session_id
  ON CONFLICT (session_id) DO UPDATE SET
    account_age_days = EXCLUDED.account_age_days,
    total_messages_sent = EXCLUDED.total_messages_sent,
    unique_contacts_count = EXCLUDED.unique_contacts_count,
    avg_messages_per_day = EXCLUDED.avg_messages_per_day,
    max_messages_per_hour = EXCLUDED.max_messages_per_hour,
    engagement_rate = EXCLUDED.engagement_rate,
    strength_score = EXCLUDED.strength_score,
    ban_risk_level = EXCLUDED.ban_risk_level,
    connection_uptime_hours = EXCLUDED.connection_uptime_hours,
    reconnection_count = EXCLUDED.reconnection_count,
    connection_stability_score = EXCLUDED.connection_stability_score,
    message_delivery_rate = EXCLUDED.message_delivery_rate,
    message_read_rate = EXCLUDED.message_read_rate,
    failed_message_rate = EXCLUDED.failed_message_rate,
    block_rate = EXCLUDED.block_rate,
    message_distribution_score = EXCLUDED.message_distribution_score,
    burst_detection_count = EXCLUDED.burst_detection_count,
    last_activity_score = EXCLUDED.last_activity_score,
    two_way_conversation_rate = EXCLUDED.two_way_conversation_rate,
    calculated_at = NOW(),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

