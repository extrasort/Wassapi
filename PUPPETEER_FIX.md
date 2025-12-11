# Puppeteer/Chromium Fix for Railway Deployment

## Problem
When deploying to Railway (or other Linux environments), Puppeteer fails with:
```
error while loading shared libraries: libgobject-2.0.so.0: cannot open shared object file
```

This happens because the Linux container doesn't have the required system libraries for Chromium.

## Solution

We've implemented multiple fixes to handle this:

### 1. System Dependencies
Created `Aptfile` and `nixpacks.toml` to install required system libraries during Railway build.

### 2. Puppeteer Configuration
Updated Puppeteer args to work better in containerized environments:
- `--no-sandbox` - Required for running as root
- `--disable-setuid-sandbox` - Required for Docker/Railway
- `--single-process` - Important for limited memory environments
- Other stability flags for headless Chrome

### 3. Chromium Executable Detection
The code now:
- Checks for `PUPPETEER_EXECUTABLE_PATH` environment variable
- Falls back to common Linux Chromium paths if available
- Uses bundled Chromium as last resort

## Deployment Options

### Option 1: Railway with Aptfile (Recommended)
Railway will automatically use the `Aptfile` to install dependencies during build.

1. Make sure `Aptfile` exists in your repository
2. Deploy to Railway
3. Railway will install the packages automatically

### Option 2: Railway with Nixpacks
If using Nixpacks builder, the `nixpacks.toml` will be used.

### Option 3: Docker
Use the provided `Dockerfile` for Docker deployments.

Set environment variable:
```env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

## Environment Variables (Optional)

You can set these in Railway if needed:

```env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
```

## Testing

After deployment, test the WhatsApp connect endpoint:
```bash
curl -X POST https://your-railway-url.railway.app/api/whatsapp/connect \
  -H "Content-Type: application/json" \
  -d '{"userId":"test","sessionId":"test-session"}'
```

If successful, you should see a QR code response or no 500 errors.

## Troubleshooting

### Still Getting Library Errors
1. Check Railway build logs - ensure packages are being installed
2. Verify `Aptfile` is in the root of your backend directory
3. Try setting `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` explicitly

### Chromium Not Found
The code will fall back to bundled Chromium. If that fails:
1. Check Railway logs for Chromium installation
2. Verify the Aptfile packages are installed
3. Try using Docker deployment instead

### Memory Issues
If you see memory errors:
- The `--single-process` flag helps reduce memory usage
- Railway might need a higher tier plan for WhatsApp Web.js
- Consider using Railway's resource limits settings

