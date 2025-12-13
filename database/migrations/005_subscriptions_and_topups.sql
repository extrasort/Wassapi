-- Migration: Subscriptions and Wallet Topups
-- Description: Adds subscription tiers, wallet topup system with bonuses, and enhanced user profile

-- Subscription Tiers Table
CREATE TABLE IF NOT EXISTS subscription_tiers (
    id SERIAL PRIMARY KEY,
    tier_name VARCHAR(50) UNIQUE NOT NULL,
    tier_key VARCHAR(50) UNIQUE NOT NULL, -- 'basic', 'standard', 'premium'
    price_iqd INTEGER NOT NULL,
    messages_limit INTEGER, -- NULL means unlimited
    numbers_limit INTEGER, -- NULL means unlimited
    description TEXT,
    features JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert subscription tiers
-- Note: For premium tier, NULL in messages_limit and numbers_limit means unlimited
INSERT INTO subscription_tiers (tier_name, tier_key, price_iqd, messages_limit, numbers_limit, description, features) VALUES
('Basic', 'basic', 10000, 1200, 1, 'Perfect for small businesses - 1200 messages for 1 number', '{"messages": 1200, "numbers": 1, "support": "email"}'),
('Standard', 'standard', 25000, 3000, 3, 'Ideal for growing businesses - 3000 messages for 3 numbers', '{"messages": 3000, "numbers": 3, "support": "priority"}'),
('Premium', 'premium', 100000, NULL, NULL, 'Unlimited messages and numbers for enterprise needs', '{"messages": "unlimited", "numbers": "unlimited", "support": "24/7"}')
ON CONFLICT (tier_key) DO UPDATE SET
  price_iqd = EXCLUDED.price_iqd,
  messages_limit = EXCLUDED.messages_limit,
  numbers_limit = EXCLUDED.numbers_limit,
  description = EXCLUDED.description,
  features = EXCLUDED.features,
  is_active = EXCLUDED.is_active;

-- User Subscriptions Table
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tier_key VARCHAR(50) NOT NULL REFERENCES subscription_tiers(tier_key),
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active', 'expired', 'cancelled'
    messages_used INTEGER DEFAULT 0,
    numbers_used INTEGER DEFAULT 0,
    starts_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE, -- NULL for premium (never expires)
    auto_renew BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT valid_status CHECK (status IN ('active', 'expired', 'cancelled'))
);

-- Wallet Topup Transactions
CREATE TABLE IF NOT EXISTS wallet_topups (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_iqd INTEGER NOT NULL,
    bonus_amount_iqd INTEGER DEFAULT 0,
    total_credited_iqd INTEGER NOT NULL, -- amount + bonus
    payment_method VARCHAR(50), -- 'manual', 'card', 'bank_transfer', etc.
    payment_reference VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'cancelled'
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT valid_topup_status CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'))
);

-- Update user_profiles to include legal information
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);

-- User Settings Table
CREATE TABLE IF NOT EXISTS user_settings (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    rate_limit_per_minute INTEGER DEFAULT 10, -- Messages per minute
    rate_limit_per_hour INTEGER DEFAULT 100, -- Messages per hour
    rate_limit_per_day INTEGER DEFAULT 1000, -- Messages per day
    auto_retry_failed_messages BOOLEAN DEFAULT true,
    max_retry_attempts INTEGER DEFAULT 3,
    webhook_timeout_seconds INTEGER DEFAULT 30,
    enable_message_logging BOOLEAN DEFAULT true,
    notification_preferences JSONB DEFAULT '{"email": true, "webhook": true}'::jsonb,
    custom_settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires_at ON user_subscriptions(expires_at);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_user_id ON wallet_topups(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_status ON wallet_topups(status);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

-- Function to calculate topup bonus
CREATE OR REPLACE FUNCTION calculate_topup_bonus(amount INTEGER)
RETURNS INTEGER AS $$
BEGIN
    -- Bonus structure:
    -- 10,000 - 24,999: 5% bonus
    -- 25,000 - 49,999: 10% bonus
    -- 50,000 - 99,999: 15% bonus
    -- 100,000+: 20% bonus
    CASE
        WHEN amount >= 100000 THEN
            RETURN FLOOR(amount * 0.20);
        WHEN amount >= 50000 THEN
            RETURN FLOOR(amount * 0.15);
        WHEN amount >= 25000 THEN
            RETURN FLOOR(amount * 0.10);
        WHEN amount >= 10000 THEN
            RETURN FLOOR(amount * 0.05);
        ELSE
            RETURN 0;
    END CASE;
END;
$$ LANGUAGE plpgsql;

-- Function to check subscription limits
CREATE OR REPLACE FUNCTION check_subscription_limits(
    p_user_id UUID,
    p_messages_needed INTEGER DEFAULT 1,
    p_numbers_needed INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
    v_subscription RECORD;
    v_tier RECORD;
    v_result JSONB;
BEGIN
    -- Get active subscription
    SELECT us.*, st.messages_limit, st.numbers_limit
    INTO v_subscription
    FROM user_subscriptions us
    JOIN subscription_tiers st ON us.tier_key = st.tier_key
    WHERE us.user_id = p_user_id
    AND us.status = 'active'
    AND (us.expires_at IS NULL OR us.expires_at > NOW())
    ORDER BY us.created_at DESC
    LIMIT 1;

    -- If no subscription, return false
    IF v_subscription IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'no_active_subscription'
        );
    END IF;

    -- Check messages limit (NULL means unlimited)
    IF v_subscription.messages_limit IS NOT NULL THEN
        IF (v_subscription.messages_used + p_messages_needed) > v_subscription.messages_limit THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'reason', 'message_limit_exceeded',
                'used', v_subscription.messages_used,
                'limit', v_subscription.messages_limit,
                'needed', p_messages_needed
            );
        END IF;
    END IF;

    -- Check numbers limit (NULL means unlimited)
    IF v_subscription.numbers_limit IS NOT NULL THEN
        IF (v_subscription.numbers_used + p_numbers_needed) > v_subscription.numbers_limit THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'reason', 'number_limit_exceeded',
                'used', v_subscription.numbers_used,
                'limit', v_subscription.numbers_limit,
                'needed', p_numbers_needed
            );
        END IF;
    END IF;

    -- All checks passed
    RETURN jsonb_build_object(
        'allowed', true,
        'subscription_id', v_subscription.id,
        'messages_used', v_subscription.messages_used,
        'messages_limit', v_subscription.messages_limit,
        'numbers_used', v_subscription.numbers_used,
        'numbers_limit', v_subscription.numbers_limit
    );
END;
$$ LANGUAGE plpgsql;

-- Function to increment subscription usage
CREATE OR REPLACE FUNCTION increment_subscription_usage(
    p_subscription_id INTEGER,
    p_messages INTEGER DEFAULT 1,
    p_numbers INTEGER DEFAULT 0
)
RETURNS VOID AS $$
BEGIN
    UPDATE user_subscriptions
    SET messages_used = messages_used + p_messages,
        numbers_used = numbers_used + p_numbers,
        updated_at = NOW()
    WHERE id = p_subscription_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_subscriptions_updated_at
    BEFORE UPDATE ON user_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at
    BEFORE UPDATE ON user_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

