# Railway Deployment Guide - Watani Shield Backend

## ✅ Backend Pushed to GitHub

The backend code has been pushed to: **https://github.com/extrasort/Watani-Shield**

## 🚂 Deploy to Railway

### Step 1: Connect Repository to Railway

1. Go to [Railway Dashboard](https://railway.app)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose **"extrasort/Watani-Shield"** repository
5. Railway will automatically detect it's a Node.js project

### Step 2: Configure Environment Variables

In Railway Dashboard, go to your project → **Variables** tab and add:

```env
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
CLIENT_URL=https://your-netlify-site.netlify.app
NODE_ENV=production
```

**Generate JWT_SECRET:**
```bash
openssl rand -base64 32
```

**Important:** 
- `CLIENT_URL` should be your Netlify frontend URL (update after deploying frontend)
- Railway automatically sets `PORT` - don't override it

### Step 3: Deploy

Railway will automatically:
1. Detect `package.json`
2. Run `npm install`
3. Start the server using `node index.js` (from Procfile)
4. Expose the service on a public URL

### Step 4: Get Your Deployment URL

1. Go to **Settings** → **Networking**
2. Click **"Generate Domain"** or use custom domain
3. Copy your Railway URL (e.g., `https://watani-shield-production.up.railway.app`)

### Step 5: Update Frontend

Update your Netlify frontend environment variable:
```
NEXT_PUBLIC_API_URL=https://your-railway-url.railway.app/api
```

## 📋 Railway Configuration Files

The repository includes:
- ✅ `railway.json` - Railway build configuration
- ✅ `Procfile` - Process file (starts with `node index.js`)
- ✅ `package.json` - Dependencies and scripts

## 🔍 Verify Deployment

Test your backend:
```bash
curl https://your-railway-url.railway.app/api/health
```

Expected response:
```json
{
  "status": "ok",
  "message": "WhatsApp Shield API is running"
}
```

## 📊 Monitoring

- **Logs**: View in Railway Dashboard → Deployments → Logs
- **Metrics**: Railway Dashboard → Metrics tab
- **Variables**: Railway Dashboard → Variables tab

## 🔄 Updates

To update the backend:
1. Make changes locally
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Your changes"
   git push origin main
   ```
3. Railway will automatically redeploy

## 🐛 Troubleshooting

### Build Fails
- Check Railway logs for errors
- Verify `package.json` is correct
- Ensure Node.js version is compatible (18+)

### Environment Variables Not Working
- Variables are available immediately after setting
- Restart service if needed: Railway Dashboard → Deployments → Restart

### Database Issues
- Railway provides ephemeral storage
- For production, consider:
  - Railway PostgreSQL addon
  - External database service
  - Railway volumes (for SQLite)

## 📚 Additional Resources

- [Railway Documentation](https://docs.railway.app)
- [Railway Discord](https://discord.gg/railway)

---

**Ready to deploy?** Just connect the GitHub repo in Railway and set your environment variables!

