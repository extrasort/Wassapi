# Database Schema Verification

This document lists all tables and columns that the backend expects. Ensure your Supabase database matches this schema.

## Required Tables

### 1. `auth.users` (Supabase built-in)
- Managed by Supabase Auth
- Backend references: `user_id` in other tables

### 2. `user_profiles`
**Required Columns:**
- `id` (UUID, PRIMARY KEY, REFERENCES auth.users(id))
- `wallet_balance` (DECIMAL(10, 2), DEFAULT 1000.00)
- `created_at` (TIMESTAMP WITH TIME ZONE)
- `updated_at` (TIMESTAMP WITH TIME ZONE)

**Backend Usage:**
- Stores wallet balance per user
- Accessed via: `supabase.from('user_profiles').select('wallet_balance')`

### 3. `whatsapp_sessions`
**Required Columns:**
- `id` (UUID, PRIMARY KEY)
- `user_id` (UUID, REFERENCES auth.users(id))
- `session_id` (TEXT, UNIQUE, NOT NULL)
- `phone_number` (TEXT)
- `status` (TEXT, DEFAULT 'disconnected')
- `qr_code` (TEXT)
- `last_activity` (TIMESTAMP WITH TIME ZONE)
- `created_at` (TIMESTAMP WITH TIME ZONE)
- `updated_at` (TIMESTAMP WITH TIME ZONE)

**Backend Usage:**
- Stores WhatsApp session information
- Accessed via: `supabase.from('whatsapp_sessions').select('*')`

### 4. `api_keys`
**Required Columns:**
- `id` (UUID, PRIMARY KEY)
- `user_id` (UUID, REFERENCES auth.users(id))
- `session_id` (TEXT, REFERENCES whatsapp_sessions(session_id))
- `phone_number` (TEXT)
- `api_key` (TEXT, UNIQUE, NOT NULL)
- `api_secret` (TEXT)
- `is_active` (BOOLEAN, DEFAULT true)
- `created_at` (TIMESTAMP WITH TIME ZONE)
- `updated_at` (TIMESTAMP WITH TIME ZONE)
- `last_used_at` (TIMESTAMP WITH TIME ZONE)
- `usage_count` (INTEGER, DEFAULT 0)

**Backend Usage:**
- Stores API keys for external integrations
- Accessed via: `supabase.from('api_keys').select('*')`

### 5. `wallet_transactions`
**Required Columns:**
- `id` (UUID, PRIMARY KEY)
- `user_id` (UUID, REFERENCES auth.users(id))
- `session_id` (TEXT)
- `transaction_type` (TEXT, NOT NULL) -- 'credit', 'debit', 'initial'
- `amount` (DECIMAL(10, 2), NOT NULL)
- `balance_before` (DECIMAL(10, 2), NOT NULL)
- `balance_after` (DECIMAL(10, 2), NOT NULL)
- `description` (TEXT)
- `reference_id` (TEXT)
- `created_at` (TIMESTAMP WITH TIME ZONE)

**Backend Usage:**
- Tracks all wallet balance changes
- Accessed via: `supabase.from('wallet_transactions').insert({...})`

### 6. `automation_logs`
**Required Columns:**
- `id` (UUID, PRIMARY KEY)
- `user_id` (UUID, REFERENCES auth.users(id))
- `session_id` (TEXT, REFERENCES whatsapp_sessions(session_id))
- `type` (TEXT, NOT NULL) -- 'otp', 'announcement', 'api_message'
- `recipient` (TEXT) -- Single recipient
- `recipients` (TEXT) -- Bulk recipients (JSON array as text)
- `message` (TEXT)
- `status` (TEXT, DEFAULT 'sent') -- 'sent', 'failed'
- `error_message` (TEXT) -- Error details if failed
- `created_at` (TIMESTAMP WITH TIME ZONE)

**Backend Usage:**
- Logs all automated messages
- Accessed via: `supabase.from('automation_logs').insert({...})`

## Migration Order

Run migrations in this order:

1. **000_initial_schema.sql** - Creates base tables (user_profiles, whatsapp_sessions, automation_logs)
2. **001_wallet_and_api_keys.sql** - Adds wallet balance, API keys, and wallet transactions

## Verification Checklist

Run these queries in Supabase SQL Editor to verify your schema:

```sql
-- Check if all tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('user_profiles', 'whatsapp_sessions', 'api_keys', 'wallet_transactions', 'automation_logs');

-- Check user_profiles columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'user_profiles'
ORDER BY ordinal_position;

-- Check whatsapp_sessions columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'whatsapp_sessions'
ORDER BY ordinal_position;

-- Check api_keys columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'api_keys'
ORDER BY ordinal_position;

-- Check wallet_transactions columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'wallet_transactions'
ORDER BY ordinal_position;

-- Check automation_logs columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'automation_logs'
ORDER BY ordinal_position;
```

## Important Notes

1. **RLS Policies**: All tables have Row Level Security enabled. The backend uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS.

2. **Foreign Keys**: 
   - All `user_id` columns reference `auth.users(id)`
   - `session_id` in `api_keys` and `automation_logs` references `whatsapp_sessions(session_id)`

3. **Indexes**: Required for performance on frequently queried columns:
   - `user_id` in all tables
   - `session_id` in whatsapp_sessions, api_keys, automation_logs
   - `api_key` in api_keys (unique)

