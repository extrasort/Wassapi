# Wassapi Backend

WhatsApp backend service for Wassapi using WhatsApp Web.js.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```env
PORT=5000
SUPABASE_URL=https://muefdflkgpmzvlihvghl.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

3. Get Supabase Service Role Key:
   - Go to Supabase Dashboard → Settings → API
   - Copy the `service_role` key (NOT the anon key)
   - This key has admin privileges and can bypass RLS

4. Run the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Features

- ✅ Real WhatsApp QR code generation
- ✅ WhatsApp account connection
- ✅ One account per user enforcement
- ✅ OTP sending
- ✅ Announcement sending
- ✅ Session management
- ✅ Automatic disconnection of old sessions

## API Endpoints

### POST /api/whatsapp/connect
Connect a WhatsApp account.

**Request:**
```json
{
  "userId": "user-uuid",
  "sessionId": "session-id"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "session-id",
  "qrCode": "data:image/png;base64,...",
  "status": "connecting"
}
```

### GET /api/whatsapp/session/:sessionId
Get session status.

### POST /api/whatsapp/disconnect/:sessionId
Disconnect a WhatsApp account.

**Request:**
```json
{
  "userId": "user-uuid"
}
```

### POST /api/whatsapp/send-otp
Send OTP via WhatsApp.

**Request:**
```json
{
  "sessionId": "session-id",
  "recipient": "1234567890",
  "otp": "123456",
  "userId": "user-uuid"
}
```

### POST /api/whatsapp/send-announcement
Send announcement to multiple recipients.

**Request:**
```json
{
  "sessionId": "session-id",
  "recipients": ["1234567890", "0987654321"],
  "message": "Your message here",
  "userId": "user-uuid"
}
```

## Deployment

### Railway
1. Connect your GitHub repository
2. Set environment variables
3. Deploy

### Other Platforms
- Ensure Node.js 18+ is available
- Set environment variables
- Run `npm start`

## Security Notes

- ⚠️ Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend
- ✅ Use environment variables
- ✅ Keep `.env` in `.gitignore`
- ✅ Use HTTPS in production

## Troubleshooting

### QR Code not showing
- Check if backend is running
- Verify Supabase credentials
- Check browser console for errors

### Connection fails
- Ensure WhatsApp Web.js can access the internet
- Check if port 5000 is available
- Verify Supabase connection

### Multiple accounts error
- Backend automatically prevents multiple connections
- Disconnect existing session first

