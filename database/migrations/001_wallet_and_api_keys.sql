-- Migration: Add Wallet Balance and API Keys
-- Run this SQL in your Supabase SQL Editor

-- Add wallet_balance column to users table (if using users table)
-- Or add to user_profiles if using Supabase Auth
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL(10, 2) DEFAULT 1000.00;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL(10, 2) DEFAULT 1000.00;

-- Create API keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  api_secret TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE,
  usage_count INTEGER DEFAULT 0
);

-- Create wallet transactions table for tracking balance changes
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  transaction_type TEXT NOT NULL, -- 'credit', 'debit', 'initial'
  amount DECIMAL(10, 2) NOT NULL,
  balance_before DECIMAL(10, 2) NOT NULL,
  balance_after DECIMAL(10, 2) NOT NULL,
  description TEXT,
  reference_id TEXT, -- For linking to messages, payments, etc.
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_api_keys_api_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_session_id ON api_keys(session_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_phone_number ON api_keys(phone_number);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_session_id ON wallet_transactions(session_id);

-- Enable Row Level Security (RLS)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for api_keys table
CREATE POLICY "Users can view own api_keys" ON api_keys
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert own api_keys" ON api_keys
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own api_keys" ON api_keys
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete own api_keys" ON api_keys
  FOR DELETE USING (user_id = auth.uid());

-- RLS Policies for wallet_transactions table
CREATE POLICY "Users can view own transactions" ON wallet_transactions
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Service role can insert transactions" ON wallet_transactions
  FOR INSERT WITH CHECK (true); -- Service role bypasses RLS

-- Function to generate API key
CREATE OR REPLACE FUNCTION generate_api_key()
RETURNS TEXT AS $$
DECLARE
  api_key TEXT;
BEGIN
  -- Generate a random API key: prefix + random string
  api_key := 'wass_' || encode(gen_random_bytes(32), 'base64');
  -- Remove special characters and make URL-safe
  api_key := replace(replace(replace(api_key, '+', '-'), '/', '_'), '=', '');
  RETURN api_key;
END;
$$ LANGUAGE plpgsql;

-- Function to generate API secret
CREATE OR REPLACE FUNCTION generate_api_secret()
RETURNS TEXT AS $$
DECLARE
  api_secret TEXT;
BEGIN
  -- Generate a random API secret
  api_secret := encode(gen_random_bytes(64), 'hex');
  RETURN api_secret;
END;
$$ LANGUAGE plpgsql;

-- Function to deduct wallet balance (with transaction)
CREATE OR REPLACE FUNCTION deduct_wallet_balance(
  p_user_id UUID,
  p_amount DECIMAL,
  p_description TEXT,
  p_reference_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  current_balance DECIMAL;
  new_balance DECIMAL;
  result JSON;
BEGIN
  -- Get current balance
  SELECT wallet_balance INTO current_balance
  FROM users
  WHERE id = p_user_id
  FOR UPDATE; -- Lock row for update

  IF current_balance IS NULL THEN
    -- Initialize balance if null
    current_balance := 1000.00;
    UPDATE users SET wallet_balance = 1000.00 WHERE id = p_user_id;
  END IF;

  -- Check if sufficient balance
  IF current_balance < p_amount THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Insufficient balance',
      'current_balance', current_balance,
      'required', p_amount
    );
  END IF;

  -- Deduct amount
  new_balance := current_balance - p_amount;
  UPDATE users SET wallet_balance = new_balance WHERE id = p_user_id;

  -- Log transaction
  INSERT INTO wallet_transactions (
    user_id,
    session_id,
    transaction_type,
    amount,
    balance_before,
    balance_after,
    description,
    reference_id
  ) VALUES (
    p_user_id,
    p_session_id,
    'debit',
    p_amount,
    current_balance,
    new_balance,
    p_description,
    p_reference_id
  );

  RETURN json_build_object(
    'success', true,
    'balance_before', current_balance,
    'balance_after', new_balance,
    'amount_deducted', p_amount
  );
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at for api_keys
CREATE TRIGGER update_api_keys_updated_at BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Initialize wallet balance for existing users (if needed)
UPDATE users SET wallet_balance = 1000.00 WHERE wallet_balance IS NULL;
UPDATE user_profiles SET wallet_balance = 1000.00 WHERE wallet_balance IS NULL;

