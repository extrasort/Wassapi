-- Initial Supabase Schema for Wassapi
-- Run this SQL in your Supabase SQL Editor FIRST (before 001_wallet_and_api_keys.sql)
-- This assumes you're using Supabase Auth (auth.users table exists by default)

-- Create user_profiles table (extends auth.users)
-- This table stores additional user information
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create whatsapp_sessions table
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE NOT NULL,
  phone_number TEXT,
  status TEXT DEFAULT 'disconnected',
  qr_code TEXT,
  last_activity TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create automation_logs table
CREATE TABLE IF NOT EXISTS automation_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'otp', 'announcement', 'api_message'
  recipient TEXT,
  recipients TEXT, -- For bulk messages (JSON array as text)
  message TEXT,
  status TEXT DEFAULT 'sent', -- 'sent', 'failed'
  error_message TEXT, -- For storing error details
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE
);

-- Create indexes for whatsapp_sessions
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user_id ON whatsapp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_session_id ON whatsapp_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status ON whatsapp_sessions(status);

-- Create indexes for automation_logs
CREATE INDEX IF NOT EXISTS idx_automation_logs_user_id ON automation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_session_id ON automation_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_created_at ON automation_logs(created_at);

-- Enable Row Level Security (RLS)
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for user_profiles
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own profile" ON user_profiles;
CREATE POLICY "Users can insert own profile" ON user_profiles
  FOR INSERT WITH CHECK (id = auth.uid());

-- Service role can manage all profiles (for backend operations)
DROP POLICY IF EXISTS "Service role can manage profiles" ON user_profiles;
CREATE POLICY "Service role can manage profiles" ON user_profiles
  FOR ALL USING (true);

-- RLS Policies for whatsapp_sessions
DROP POLICY IF EXISTS "Users can view own sessions" ON whatsapp_sessions;
CREATE POLICY "Users can view own sessions" ON whatsapp_sessions
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own sessions" ON whatsapp_sessions;
CREATE POLICY "Users can insert own sessions" ON whatsapp_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own sessions" ON whatsapp_sessions;
CREATE POLICY "Users can update own sessions" ON whatsapp_sessions
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own sessions" ON whatsapp_sessions;
CREATE POLICY "Users can delete own sessions" ON whatsapp_sessions
  FOR DELETE USING (user_id = auth.uid());

-- Service role can manage all sessions (for backend operations)
DROP POLICY IF EXISTS "Service role can manage sessions" ON whatsapp_sessions;
CREATE POLICY "Service role can manage sessions" ON whatsapp_sessions
  FOR ALL USING (true);

-- RLS Policies for automation_logs
DROP POLICY IF EXISTS "Users can view own logs" ON automation_logs;
CREATE POLICY "Users can view own logs" ON automation_logs
  FOR SELECT USING (user_id = auth.uid());

-- Service role can manage all logs (for backend operations)
DROP POLICY IF EXISTS "Service role can manage logs" ON automation_logs;
CREATE POLICY "Service role can manage logs" ON automation_logs
  FOR ALL USING (true);

-- Create trigger function to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_whatsapp_sessions_updated_at ON whatsapp_sessions;
CREATE TRIGGER update_whatsapp_sessions_updated_at
  BEFORE UPDATE ON whatsapp_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

