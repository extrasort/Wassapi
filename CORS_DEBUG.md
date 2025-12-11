# CORS Debugging

## Current Issue
CORS errors when frontend at `https://watanishield.netlify.app` tries to call backend at `https://watanishield.up.railway.app`

## Fix Applied

1. ✅ Changed `optionsSuccessStatus` to `204` (matches the error status code)
2. ✅ Added explicit `app.options('*', cors(corsOptions))` handler
3. ✅ Added logging to see which origins are being checked
4. ✅ Temporarily allowing all origins for debugging

## Test CORS

### From Browser Console (on Netlify site)
```javascript
fetch('https://watanishield.up.railway.app/health', {
  method: 'GET',
  headers: {
    'Origin': 'https://watanishield.netlify.app'
  }
})
.then(r => r.json())
.then(console.log)
.catch(console.error);
```

### Using curl
```bash
# Test OPTIONS preflight
curl -X OPTIONS https://watanishield.up.railway.app/api/whatsapp/connect \
  -H "Origin: https://watanishield.netlify.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v
```

Should see:
```
< HTTP/1.1 204 No Content
< Access-Control-Allow-Origin: https://watanishield.netlify.app
< Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS,PATCH
```

## Check Railway Logs

After redeploying, check Railway logs for:
- `✅ CORS allowed Netlify origin: https://watanishield.netlify.app`
- Or `❌ CORS blocked origin: ...`

## If Still Not Working

1. Check Railway logs for CORS messages
2. Verify the origin in browser Network tab matches exactly
3. Try temporarily allowing all origins:
   ```javascript
   origin: true  // Allow all origins
   ```

