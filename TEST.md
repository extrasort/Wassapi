# Testing the Backend

## Quick Health Check

### Option 1: Using curl
```bash
curl http://localhost:5000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "service": "wassapi-backend"
}
```

### Option 2: Using the test script
```bash
cd /Users/sadiq/watanishield/backend
node test-backend.js
```

### Option 3: Using browser
Open: http://localhost:5000/health

### Option 4: Test API endpoint
```bash
curl http://localhost:5000/api/test
```

## Check if Backend is Running

### Check process
```bash
# Check if Node.js process is running on port 5000
lsof -i :5000

# Or check all Node processes
ps aux | grep node
```

### Check logs
If backend is running, you should see:
```
🚀 Wassapi backend server running on port 5000
📍 Health check: http://localhost:5000/health
📍 Test endpoint: http://localhost:5000/api/test
```

## Common Issues

### Backend not starting
1. Check if port 5000 is available:
   ```bash
   lsof -i :5000
   ```
   If something is using it, kill it or change PORT in `.env`

2. Check for errors:
   ```bash
   cd backend
   npm start
   ```
   Look for error messages

3. Check dependencies:
   ```bash
   cd backend
   npm install
   ```

### Connection refused
- Backend is not running
- Start it: `cd backend && npm start`

### CORS errors
- Backend has CORS enabled
- Check if backend URL is correct in frontend

### Environment variables
- Make sure `.env` file exists
- Check `SUPABASE_SERVICE_ROLE_KEY` is set correctly

## Testing WhatsApp Connect

### 1. Start backend
```bash
cd /Users/sadiq/watanishield/backend
npm start
```

### 2. Test connect endpoint (requires userId and sessionId)
```bash
curl -X POST http://localhost:5000/api/whatsapp/connect \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user-id",
    "sessionId": "test-session-id"
  }'
```

## Debugging

### Enable verbose logging
Add to `index.js`:
```javascript
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, req.body);
  next();
});
```

### Check Supabase connection
Add to `index.js`:
```javascript
// Test Supabase connection
supabase.from('whatsapp_sessions').select('count').then(({ data, error }) => {
  if (error) {
    console.error('❌ Supabase connection failed:', error);
  } else {
    console.log('✅ Supabase connected');
  }
});
```

