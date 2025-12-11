# Watani Shield Backend

Backend API for Watani Shield - WhatsApp account protection and automation service.

## Features

- 🔐 JWT-based authentication
- 📱 WhatsApp session management via QR codes
- 🛡️ Account strengthening and protection
- ⚡ OTP and announcement automation
- 📊 Session monitoring and activity logging

## Tech Stack

- Node.js with Express
- SQLite database
- WhatsApp Web.js for WhatsApp integration
- JWT for authentication
- Rate limiting and security middleware

## Environment Variables

Create a `.env` file with:

```env
PORT=5000
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-min-32-chars
CLIENT_URL=https://your-frontend-domain.com
NODE_ENV=production
```

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

## Production

```bash
npm start
```

## Railway Deployment

This backend is configured for Railway deployment:

1. Connect this repository to Railway
2. Set environment variables in Railway dashboard
3. Railway will automatically detect and deploy

See `railway.json` for configuration.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user

### WhatsApp
- `POST /api/whatsapp/connect` - Create new WhatsApp session
- `GET /api/whatsapp/sessions` - Get all user sessions
- `GET /api/whatsapp/session/:sessionId` - Get session status
- `POST /api/whatsapp/disconnect/:sessionId` - Disconnect session

### Automation
- `POST /api/automation/otp/send` - Send OTP message
- `POST /api/automation/announcement/send` - Send bulk announcement
- `GET /api/automation/messages/:sessionId` - Get message history

## License

MIT

