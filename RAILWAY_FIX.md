# Railway Configuration Fix

## Issues Fixed

### 1. Port Configuration
- Railway automatically sets `PORT` environment variable (usually 8080)
- Backend now uses `process.env.PORT` which Railway provides
- Listens on `0.0.0.0` to accept connections from Railway's proxy

### 2. Trust Proxy
- Added `app.set('trust proxy', true)` 
- Required for Railway's reverse proxy
- Fixes `X-Forwarded-For` header errors
- Allows rate limiting to work correctly behind proxy

## Railway Environment Variables

Make sure these are set in Railway:

```
PORT=8080  (Railway sets this automatically)
SUPABASE_URL=https://muefdflkgpmzvlihvghl.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
CLIENT_URL=https://watanishield.netlify.app (optional)
```

## Testing

After redeploying, test:

```bash
curl https://watanishield.up.railway.app/health
```

Should return:
```json
{
  "status": "ok",
  "timestamp": "...",
  "service": "wassapi-backend",
  "supabase": "configured"
}
```

## What Changed

1. ✅ Added `app.set('trust proxy', true)` - Required for Railway
2. ✅ Changed listen to `0.0.0.0` - Accepts connections from Railway proxy
3. ✅ Uses `process.env.PORT` - Railway provides this automatically

## Redeploy

After these changes, Railway will automatically redeploy when you push to GitHub, or:

1. Go to Railway Dashboard
2. Click "Redeploy" on latest deployment
3. Wait for deployment to complete
4. Test health endpoint

