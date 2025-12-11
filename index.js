const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// Trust proxy for Railway (required for X-Forwarded-For headers)
app.set('trust proxy', true);

// CORS middleware - MUST be before other middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log(`🌐 CORS request from origin: ${origin || 'none'}`);
  console.log(`🌐 Request method: ${req.method}`);
  console.log(`🌐 Request path: ${req.path}`);
  
  // Allow all origins for now
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    console.log(`✅ Set Access-Control-Allow-Origin: ${origin}`);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
    console.log(`✅ Set Access-Control-Allow-Origin: *`);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    console.log('✅ Handling OPTIONS preflight request');
    console.log('✅ Sending 204 with CORS headers');
    return res.status(204).send();
  }
  
  next();
});

// Also use cors library as backup (but manual headers take precedence)
app.use(cors({
  origin: true,
  credentials: true,
  optionsSuccessStatus: 204,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Length', 'Content-Type']
}));

app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase environment variables!');
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Test Supabase connection on startup
supabase.from('whatsapp_sessions').select('count').limit(1)
  .then(({ error }) => {
    if (error) {
      console.error('❌ Supabase connection failed:', error.message);
    } else {
      console.log('✅ Supabase connected successfully');
    }
  });

// Store active WhatsApp clients
const clients = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'wassapi-backend',
    supabase: supabaseUrl ? 'configured' : 'missing'
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Backend is working!',
    timestamp: new Date().toISOString(),
    activeClients: clients.size
  });
});

// Initialize WhatsApp client for a user
async function initializeClient(userId, sessionId) {
  try {
    console.log(`Initializing WhatsApp client for user ${userId}, session ${sessionId}`);
    
    // Check if user already has a connected session
    const { data: existingSessions } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'connected')
      .limit(1);

    if (existingSessions && existingSessions.length > 0) {
      throw new Error('User already has a connected WhatsApp account');
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    let qrCodeData = null;

    client.on('qr', async (qr) => {
      console.log(`📱 QR Code generated for session ${sessionId}`);
      try {
        qrCodeData = await qrcode.toDataURL(qr);
        console.log(`✅ QR code converted to data URL (${qrCodeData.length} chars)`);
        
        // Update session in database with QR code
        const { error } = await supabase
          .from('whatsapp_sessions')
          .update({ qr_code: qrCodeData })
          .eq('session_id', sessionId);
        
        if (error) {
          console.error('❌ Error updating QR code in database:', error);
        } else {
          console.log('✅ QR code saved to database');
        }
      } catch (error) {
        console.error('❌ Error generating QR code:', error);
      }
    });

    client.on('ready', async () => {
      console.log(`✅ WhatsApp client ready for session ${sessionId}`);
      const info = client.info;
      console.log(`📱 Connected to: ${info.wid.user}`);
      
      // Update session in database
      const { error } = await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'connected',
          phone_number: info.wid.user,
          qr_code: null,
          last_activity: new Date().toISOString(),
        })
        .eq('session_id', sessionId);

      if (error) {
        console.error('❌ Error updating session status:', error);
      } else {
        console.log('✅ Session status updated to connected');
      }

      // Disconnect any other sessions for this user
      const { error: disconnectError } = await supabase
        .from('whatsapp_sessions')
        .update({ status: 'disconnected' })
        .eq('user_id', userId)
        .neq('session_id', sessionId);
      
      if (disconnectError) {
        console.error('⚠️ Error disconnecting old sessions:', disconnectError);
      }
    });

    client.on('authenticated', () => {
      console.log(`✅ Authenticated for session ${sessionId}`);
    });

    client.on('auth_failure', async (msg) => {
      console.error(`❌ Auth failure for session ${sessionId}:`, msg);
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'failed' })
        .eq('session_id', sessionId);
      clients.delete(sessionId);
    });

    client.on('disconnected', async (reason) => {
      console.log(`⚠️ Disconnected for session ${sessionId}:`, reason);
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'disconnected' })
        .eq('session_id', sessionId);
      clients.delete(sessionId);
    });

    console.log('🚀 Initializing WhatsApp client...');
    await client.initialize();
    clients.set(sessionId, client);
    console.log(`✅ Client initialized and stored for session ${sessionId}`);

    return { client, qrCodeData };
  } catch (error) {
    console.error(`❌ Error initializing client for session ${sessionId}:`, error);
    throw error;
  }
}

// Connect WhatsApp endpoint
app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    console.log('📞 Connect request received from origin:', req.headers.origin);
    console.log('📞 Connect request body:', req.body);
    const { userId, sessionId } = req.body;

    if (!userId || !sessionId) {
      console.error('❌ Missing userId or sessionId');
      return res.status(400).json({ error: 'userId and sessionId are required' });
    }

    // Check if user already has a connected session
    const { data: existingSessions } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'connected')
      .limit(1);

    if (existingSessions && existingSessions.length > 0) {
      console.log(`❌ User ${userId} already has a connected session`);
      return res.status(400).json({ 
        error: 'You already have a connected WhatsApp account. Please disconnect it first.' 
      });
    }

    // Initialize client
    console.log(`🚀 Initializing client for user ${userId}, session ${sessionId}`);
    const { qrCodeData } = await initializeClient(userId, sessionId);

    console.log(`✅ Client initialized, QR code: ${qrCodeData ? 'generated' : 'pending'}`);

    res.json({
      success: true,
      sessionId,
      qrCode: qrCodeData,
      status: 'connecting',
    });
  } catch (error) {
    console.error('❌ Error connecting WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get session status
app.get('/api/whatsapp/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log(`📊 Getting session status for: ${sessionId}`);

    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    if (error) throw error;

    console.log(`✅ Session found: ${data ? data.status : 'not found'}`);
    res.json({ session: data });
  } catch (error) {
    console.error('❌ Error getting session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect WhatsApp
app.post('/api/whatsapp/disconnect/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId } = req.body;
    console.log(`🔌 Disconnecting session ${sessionId} for user ${userId}`);

    const client = clients.get(sessionId);
    if (client) {
      console.log('🔌 Logging out WhatsApp client...');
      await client.logout();
      clients.delete(sessionId);
      console.log('✅ Client logged out and removed');
    }

    const { error } = await supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('session_id', sessionId)
      .eq('user_id', userId);

    if (error) throw error;

    console.log('✅ Session deleted from database');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error disconnecting:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send OTP
app.post('/api/whatsapp/send-otp', async (req, res) => {
  try {
    console.log('📤 Send OTP request:', req.body);
    const { sessionId, recipient, otp, userId } = req.body;

    const client = clients.get(sessionId);
    if (!client) {
      console.error(`❌ Session ${sessionId} not found in active clients`);
      return res.status(404).json({ error: 'Session not found' });
    }

    const message = `Your OTP code is: ${otp}`;
    const chatId = `${recipient}@c.us`;
    
    console.log(`📱 Sending OTP to ${chatId}`);
    await client.sendMessage(chatId, message);
    console.log('✅ OTP sent successfully');

    // Log to database
    await supabase.from('automation_logs').insert({
      user_id: userId,
      session_id: sessionId,
      type: 'otp',
      recipient,
      message: `OTP: ${otp}`,
      status: 'sent',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send announcement
app.post('/api/whatsapp/send-announcement', async (req, res) => {
  try {
    console.log('📢 Send announcement request:', req.body);
    const { sessionId, recipients, message, userId } = req.body;

    const client = clients.get(sessionId);
    if (!client) {
      console.error(`❌ Session ${sessionId} not found`);
      return res.status(404).json({ error: 'Session not found' });
    }

    let sent = 0;
    const errors = [];

    console.log(`📱 Sending to ${recipients.length} recipients`);
    for (const recipient of recipients) {
      try {
        const chatId = `${recipient}@c.us`;
        await client.sendMessage(chatId, message);
        sent++;
        console.log(`✅ Sent to ${recipient}`);
      } catch (error) {
        console.error(`❌ Failed to send to ${recipient}:`, error.message);
        errors.push({ recipient, error: error.message });
      }
    }

    // Log to database
    await supabase.from('automation_logs').insert({
      user_id: userId,
      session_id: sessionId,
      type: 'announcement',
      recipients,
      message,
      status: sent > 0 ? 'sent' : 'failed',
      error_message: errors.length > 0 ? JSON.stringify(errors) : null,
    });

    console.log(`✅ Announcement sent: ${sent}/${recipients.length} successful`);
    res.json({ success: true, sent, errors });
  } catch (error) {
    console.error('❌ Error sending announcement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Railway provides PORT, default to 5000 for local development
const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 Wassapi backend server running on port', PORT);
  console.log('📍 Health check: http://localhost:' + PORT + '/health');
  console.log('📍 Test endpoint: http://localhost:' + PORT + '/api/test');
  console.log('🌐 Trust proxy enabled for Railway');
  console.log('');
});
