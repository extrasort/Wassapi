# Database Setup Guide

Follow these steps to ensure your Supabase database matches the backend requirements.

## Step 1: Run Initial Schema Migration

Run this SQL file in your Supabase SQL Editor:

**File:** `database/migrations/000_initial_schema.sql`

This creates:
- `user_profiles` table
- `whatsapp_sessions` table  
- `automation_logs` table
- Required indexes and RLS policies

## Step 2: Run Wallet & API Keys Migration

Run this SQL file in your Supabase SQL Editor:

**File:** `database/migrations/001_wallet_and_api_keys.sql`

This adds:
- `wallet_balance` column to `user_profiles`
- `api_keys` table
- `wallet_transactions` table
- Required functions and triggers

## Step 3: Verify Schema

Run the verification queries from `SCHEMA_VERIFICATION.md` to ensure all tables and columns exist.

## Quick Setup (Copy & Paste)

You can copy and paste both migration files directly into the Supabase SQL Editor and run them sequentially.

## Important Notes

1. **Migration Order Matters**: Run `000_initial_schema.sql` BEFORE `001_wallet_and_api_keys.sql`

2. **RLS Policies**: The backend uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS, so all policies should work correctly.

3. **Foreign Keys**: Make sure `whatsapp_sessions` table exists before running `001_wallet_and_api_keys.sql` since `api_keys` references it.

## Troubleshooting

If you see errors like "relation does not exist":
- Ensure you ran migrations in the correct order
- Check that all tables were created successfully
- Verify foreign key constraints are correct

