# Verify Backend Deployment

## Check if Changes are Deployed

The CORS errors suggest the new code might not be deployed yet. Verify:

### 1. Check Railway Deployment Status

1. Go to Railway Dashboard
2. Select your project
3. Check "Deployments" tab
4. Look for latest deployment:
   - Status should be "Active"
   - Check deployment time - is it after your last code change?

### 2. Check Railway Logs

Look for these log messages (they indicate new code is running):

```
🌐 CORS request from origin: https://watanishield.netlify.app
🌐 Request method: OPTIONS
✅ Handling OPTIONS preflight request
✅ Set Access-Control-Allow-Origin: https://watanishield.netlify.app
```

If you DON'T see these logs, the new code isn't deployed yet.

### 3. Force Redeploy

If deployment is old:

1. Railway Dashboard → Your Project
2. Click "Settings" → "Deployments"
3. Click "Redeploy" on latest deployment
4. OR trigger new deployment by pushing to GitHub

### 4. Test Health Endpoint

```bash
curl https://watanishield.up.railway.app/health
```

Should return JSON. If it works, backend is running.

### 5. Test CORS Directly

```bash
curl -X OPTIONS https://watanishield.up.railway.app/api/whatsapp/connect \
  -H "Origin: https://watanishield.netlify.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v
```

Look for these headers in response:
```
< Access-Control-Allow-Origin: https://watanishield.netlify.app
< Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS, PATCH
```

## If Still Not Working

### Check Railway Logs for:
1. Startup messages (should show port 8080)
2. CORS log messages (🌐 emoji)
3. Any error messages

### Common Issues:
- Code not deployed (most likely)
- Environment variables missing
- Port configuration wrong
- Railway service not running

## Quick Fix: Force Redeploy

1. Make a small change to trigger redeploy:
   ```bash
   echo "// Force redeploy" >> backend/index.js
   git add backend/index.js
   git commit -m "Force redeploy"
   git push
   ```

2. Or redeploy manually in Railway Dashboard

