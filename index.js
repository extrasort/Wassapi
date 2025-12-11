const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
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

// Constants
const MESSAGE_COST_IQD = 10.00;
const DEFAULT_WALLET_BALANCE = 1000.00;

// Helper function to generate API key
function generateApiKey() {
  const randomBytes = crypto.randomBytes(32);
  const apiKey = 'wass_' + randomBytes.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 48);
  return apiKey;
}

// Helper function to generate API secret
function generateApiSecret() {
  return crypto.randomBytes(64).toString('hex');
}

// Helper function to initialize wallet balance for user
async function initializeWalletBalance(userId) {
  try {
    // Check if user profile exists and has wallet balance (using user_profiles for Supabase Auth)
    const { data: userProfile, error: fetchError } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = not found
      console.error('❌ Error checking wallet balance:', fetchError);
      return;
    }

    // If user profile doesn't exist or balance is null, initialize it
    if (!userProfile || userProfile.wallet_balance === null) {
      // Insert or update user profile with wallet balance
      const { error: updateError } = await supabase
        .from('user_profiles')
        .upsert({ 
          id: userId,
          wallet_balance: DEFAULT_WALLET_BALANCE 
        }, { onConflict: 'id' });

      if (updateError) {
        console.error('❌ Error initializing wallet balance:', updateError);
      } else {
        // Log initial transaction
        await supabase.from('wallet_transactions').insert({
          user_id: userId,
          transaction_type: 'initial',
          amount: DEFAULT_WALLET_BALANCE,
          balance_before: 0,
          balance_after: DEFAULT_WALLET_BALANCE,
          description: 'Initial wallet balance'
        });
        console.log(`✅ Wallet balance initialized to ${DEFAULT_WALLET_BALANCE} IQD for user ${userId}`);
      }
    }
  } catch (error) {
    console.error('❌ Error in initializeWalletBalance:', error);
  }
}

// Helper function to deduct wallet balance
async function deductBalance(userId, sessionId, description, referenceId = null) {
  try {
    // Get current balance from user_profiles (Supabase Auth)
    const { data: userProfile, error: fetchError } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    if (fetchError) {
      throw new Error(`Failed to fetch balance: ${fetchError.message}`);
    }

    const currentBalance = userProfile?.wallet_balance || DEFAULT_WALLET_BALANCE;

    // Check if sufficient balance
    if (currentBalance < MESSAGE_COST_IQD) {
      return {
        success: false,
        error: 'Insufficient balance',
        currentBalance,
        required: MESSAGE_COST_IQD
      };
    }

    // Deduct balance
    const newBalance = currentBalance - MESSAGE_COST_IQD;
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', userId);

    if (updateError) {
      throw new Error(`Failed to update balance: ${updateError.message}`);
    }

    // Log transaction
    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      session_id: sessionId,
      transaction_type: 'debit',
      amount: MESSAGE_COST_IQD,
      balance_before: currentBalance,
      balance_after: newBalance,
      description,
      reference_id: referenceId
    });

    return {
      success: true,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      amountDeducted: MESSAGE_COST_IQD
    };
  } catch (error) {
    console.error('❌ Error deducting balance:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

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

// Restore active sessions on server startup
async function restoreActiveSessions() {
  try {
    console.log('🔄 Restoring active WhatsApp sessions...');
    const { data: activeSessions, error } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('status', 'connected');

    if (error) {
      console.error('❌ Error fetching active sessions:', error);
      return;
    }

    if (!activeSessions || activeSessions.length === 0) {
      console.log('✅ No active sessions to restore');
      return;
    }

    console.log(`📱 Found ${activeSessions.length} active session(s) to restore`);

    // Restore each active session (don't await - let them initialize in parallel)
    const restorePromises = activeSessions.map(async (session) => {
      try {
        // Don't await - let it initialize in background
        restoreClient(session.user_id, session.session_id).catch((error) => {
          console.error(`❌ Failed to restore session ${session.session_id}:`, error.message);
          // Mark as disconnected if restore fails
          supabase
            .from('whatsapp_sessions')
            .update({ status: 'disconnected' })
            .eq('session_id', session.session_id);
        });
      } catch (error) {
        console.error(`❌ Error starting restore for session ${session.session_id}:`, error.message);
      }
    });
    
    // Wait a bit for clients to start initializing, but don't block server startup
    await Promise.allSettled(restorePromises);
    console.log('✅ Session restoration initiated (clients will become ready asynchronously)');
  } catch (error) {
    console.error('❌ Error restoring active sessions:', error);
  }
}

// Restore a single WhatsApp client (without creating new session)
async function restoreClient(userId, sessionId) {
  return new Promise((resolve, reject) => {
    console.log(`🔄 Restoring client for session ${sessionId}`);
    
    let isResolved = false;
    let timeoutId;
    
    // Puppeteer configuration
    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--max-old-space-size=512',
      ],
    };

    // Use system Chromium if available
    if (process.env.PUPPETEER_EXECUTABLE_PATH || fs.existsSync('/usr/bin/chromium')) {
      const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
      puppeteerOptions.executablePath = execPath;
      console.log(`✅ Using Chromium from: ${execPath}`);
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: puppeteerOptions,
    });

    // Set up event handlers
    client.on('ready', async () => {
      if (isResolved) return; // Already handled
      
      clearTimeout(timeoutId);
      isResolved = true;
      
      console.log(`✅ WhatsApp client restored and ready for session ${sessionId}`);
      const info = client.info;
      console.log(`📱 Connected to: ${info.wid.user}`);
      
      // Store client in map if not already stored
      clients.set(sessionId, client);
      
      await supabase
        .from('whatsapp_sessions')
        .update({ 
          status: 'connected',
          last_activity: new Date().toISOString() 
        })
        .eq('session_id', sessionId);
      
      resolve(client);
    });

    client.on('authenticated', () => {
      console.log(`✅ Authenticated for restored session ${sessionId}`);
    });

    client.on('auth_failure', async (msg) => {
      clearTimeout(timeoutId);
      if (isResolved) return;
      isResolved = true;
      
      console.error(`❌ Auth failure for restored session ${sessionId}:`, msg);
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'failed' })
        .eq('session_id', sessionId);
      clients.delete(sessionId);
      reject(new Error(`Auth failure: ${msg}`));
    });

    client.on('disconnected', async (reason) => {
      console.log(`⚠️ Disconnected for restored session ${sessionId}:`, reason);
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'disconnected' })
        .eq('session_id', sessionId);
      clients.delete(sessionId);
    });

    // Initialize client
    client.initialize().then(() => {
      // Store client immediately - ready event will fire later
      clients.set(sessionId, client);
      console.log(`✅ Client restored and stored for session ${sessionId} (waiting for ready...)`);
      
      // Set timeout to 60 seconds (increased from 30)
      timeoutId = setTimeout(() => {
        if (!isResolved && !client.info) {
          console.warn(`⚠️ Client for session ${sessionId} did not become ready within 60 seconds - will continue waiting asynchronously`);
          // Don't resolve - let client become ready in background
          // The client is already stored in the map, so it will work when ready
          isResolved = true;
          resolve(client); // Resolve to avoid hanging promise, but client isn't ready yet
        }
      }, 60000); // Increased to 60 seconds
    }).catch((error) => {
      clearTimeout(timeoutId);
      if (isResolved) return;
      isResolved = true;
      
      console.error(`❌ Error initializing restored client for session ${sessionId}:`, error);
      clients.delete(sessionId);
      reject(error);
    });
  });
}

// Initialize WhatsApp client for a user
async function initializeClient(userId, sessionId) {
  try {
    console.log(`Initializing WhatsApp client for user ${userId}, session ${sessionId}`);
    
    // Check if user already has a connected session (skip if restoring)
    const { data: existingSessions } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'connected')
      .neq('session_id', sessionId)
      .limit(1);

    if (existingSessions && existingSessions.length > 0) {
      throw new Error('User already has a connected WhatsApp account');
    }

    // Puppeteer configuration for Linux deployment
    // Note: Removed --single-process as it causes session instability
    // Use Railway's resource limits instead for memory management
    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--max-old-space-size=512', // Limit memory per process
      ],
    };

    // Use system Chromium if available (for Railway/Docker deployments)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log(`✅ Using Chromium from PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    } else if (process.platform === 'linux') {
      // Try common Chromium paths on Linux
      const chromiumPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ];
      
      for (const path of chromiumPaths) {
        if (fs.existsSync(path)) {
          puppeteerOptions.executablePath = path;
          console.log(`✅ Using system Chromium at: ${path}`);
          break;
        }
      }
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: puppeteerOptions,
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
      const phoneNumber = info.wid.user;
      console.log(`📱 Connected to: ${phoneNumber}`);
      
      // Initialize wallet balance if needed
      await initializeWalletBalance(userId);
      
      // Update session in database
      const { error } = await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'connected',
          phone_number: phoneNumber,
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

      // Generate API key for this phone number
      try {
        // Check if API key already exists for this session
        const { data: existingKey } = await supabase
          .from('api_keys')
          .select('*')
          .eq('session_id', sessionId)
          .eq('is_active', true)
          .single();

        if (!existingKey) {
          const apiKey = generateApiKey();
          const apiSecret = generateApiSecret();

          const { error: apiKeyError } = await supabase
            .from('api_keys')
            .insert({
              user_id: userId,
              session_id: sessionId,
              phone_number: phoneNumber,
              api_key: apiKey,
              api_secret: apiSecret,
              is_active: true
            });

          if (apiKeyError) {
            console.error('❌ Error creating API key:', apiKeyError);
          } else {
            console.log(`✅ API key generated for phone ${phoneNumber}`);
            console.log(`🔑 API Key: ${apiKey}`);
          }
        }
      } catch (apiError) {
        console.error('❌ Error in API key generation:', apiError);
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

    // Handle page crashes
    client.on('remote_session_saved', () => {
      console.log(`✅ Remote session saved for ${sessionId}`);
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

// Helper function to check if client is ready and connected
function isClientReady(client) {
  try {
    // Check if client exists and is initialized
    if (!client) {
      return false;
    }
    
    // Check if client has info (means it's authenticated and ready)
    if (!client.info) {
      return false;
    }
    
    // Try to access the puppeteer page through the client
    // whatsapp-web.js stores the page internally
    try {
      // The client has a _pupPage property or similar
      // If we can't access it, we'll rely on the info check
      const page = client.pupPage || (client.pupBrowser && client.pupBrowser.pages && client.pupBrowser.pages()[0]);
      if (page && typeof page.isClosed === 'function' && page.isClosed()) {
        return false;
      }
    } catch (pageError) {
      // If we can't check the page, assume it's okay if client.info exists
      // This is a fallback for cases where page structure is different
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error checking client readiness:', error);
    return false;
  }
}

// Send OTP
app.post('/api/whatsapp/send-otp', async (req, res) => {
  try {
    console.log('📤 Send OTP request:', req.body);
    const { sessionId, recipient, otp, userId } = req.body;

    const client = clients.get(sessionId);
    if (!client) {
      console.error(`❌ Session ${sessionId} not found in active clients`);
      
      // Check if session exists in database
      const { data: session } = await supabase
        .from('whatsapp_sessions')
        .select('status')
        .eq('session_id', sessionId)
        .eq('user_id', userId)
        .single();
      
      if (session) {
        if (session.status === 'connected') {
          // Session exists but wasn't restored - might still be initializing
          return res.status(503).json({ 
            error: 'Session is being restored. Please wait a moment and try again.',
            sessionStatus: 'restoring'
          });
        } else {
          return res.status(400).json({ 
            error: `Session exists but is ${session.status}. Please reconnect your WhatsApp account via the dashboard.`,
            sessionStatus: session.status
          });
        }
      }
      
      return res.status(404).json({ error: 'Session not found. Please reconnect your WhatsApp account via the dashboard.' });
    }

    // Check if client is still ready
    if (!isClientReady(client)) {
      // Check if client exists but isn't ready yet (still initializing)
      if (client && !client.info) {
        console.log(`⏳ Client for session ${sessionId} is still initializing...`);
        return res.status(503).json({ 
          error: 'WhatsApp session is still initializing. Please wait a moment and try again.',
          sessionStatus: 'initializing'
        });
      }
      
      // Client is truly disconnected
      console.error(`❌ Client for session ${sessionId} is not ready or disconnected`);
      // Clean up the invalid client
      clients.delete(sessionId);
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'disconnected' })
        .eq('session_id', sessionId);
      return res.status(400).json({ error: 'WhatsApp session is disconnected. Please reconnect your account.' });
    }

    // Check and deduct wallet balance
    const balanceCheck = await deductBalance(userId, sessionId, `OTP sent to ${recipient}`, `otp_${Date.now()}`);
    if (!balanceCheck.success) {
      return res.status(402).json({
        error: balanceCheck.error || 'Insufficient balance',
        currentBalance: balanceCheck.currentBalance,
        required: MESSAGE_COST_IQD,
        message: `You need ${MESSAGE_COST_IQD} IQD to send this message. Your current balance is ${balanceCheck.currentBalance || 0} IQD.`
      });
    }

    const message = `Your OTP code is: ${otp}`;
    
    // Format phone number (remove any non-digits except +, then remove +)
    const formattedNumber = recipient.replace(/[^\d+]/g, '').replace(/^\+/, '');
    let chatId = formattedNumber.includes('@') ? formattedNumber : `${formattedNumber}@c.us`;
    
    console.log(`📱 Sending OTP to ${chatId}`);
    
    try {
      // Try to get the number ID first (resolves LID issue)
      let numberId;
      try {
        numberId = await client.getNumberId(chatId.replace('@c.us', ''));
        if (numberId) {
          chatId = numberId._serialized;
          console.log(`✅ Resolved number ID for ${formattedNumber}: ${chatId}`);
        }
      } catch (lidError) {
        console.log(`⚠️ Could not resolve number ID for ${chatId}, trying direct send...`);
        // Continue with original chatId if resolution fails
      }
      
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

      res.json({ 
        success: true,
        balance: balanceCheck.balanceAfter,
        message: 'OTP sent successfully'
      });
      } catch (sendError) {
      console.error('❌ Error sending OTP message:', sendError);
      
      // Refund the balance if message failed
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('wallet_balance')
        .eq('id', userId)
        .single();
      
      if (userProfile && balanceCheck.success) {
        const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
        await supabase
          .from('user_profiles')
          .update({ wallet_balance: refundedBalance })
          .eq('id', userId);
        
        await supabase.from('wallet_transactions').insert({
          user_id: userId,
          session_id: sessionId,
          transaction_type: 'credit',
          amount: MESSAGE_COST_IQD,
          balance_before: balanceCheck.balanceAfter,
          balance_after: refundedBalance,
          description: `Refund: Failed to send OTP to ${recipient}`,
          reference_id: `refund_otp_${Date.now()}`
        });
        console.log('💰 Balance refunded due to send failure');
      }
      
      // If session is closed, clean up the client
      if (sendError.message && sendError.message.includes('Session closed')) {
        console.log(`🧹 Cleaning up disconnected client for session ${sessionId}`);
        clients.delete(sessionId);
        await supabase
          .from('whatsapp_sessions')
          .update({ status: 'disconnected' })
          .eq('session_id', sessionId);
        return res.status(400).json({ 
          error: 'WhatsApp session was closed. Please reconnect your account and try again.' 
        });
      }
      
      throw sendError;
    }
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    res.status(500).json({ error: error.message || 'Failed to send OTP. Please try again.' });
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
      return res.status(404).json({ error: 'Session not found. Please reconnect your WhatsApp account.' });
    }

    // Check if client is still ready
    if (!isClientReady(client)) {
      // Check if client exists but isn't ready yet (still initializing)
      if (client && !client.info) {
        console.log(`⏳ Client for session ${sessionId} is still initializing...`);
        return res.status(503).json({ 
          error: 'WhatsApp session is still initializing. Please wait a moment and try again.',
          sessionStatus: 'initializing'
        });
      }
      
      // Client is truly disconnected
      console.error(`❌ Client for session ${sessionId} is not ready or disconnected`);
      // Clean up the invalid client
      clients.delete(sessionId);
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'disconnected' })
        .eq('session_id', sessionId);
      return res.status(400).json({ error: 'WhatsApp session is disconnected. Please reconnect your account.' });
    }

    // Calculate total cost
    const totalCost = recipients.length * MESSAGE_COST_IQD;
    
    // Get current balance from user_profiles (Supabase Auth)
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    const currentBalance = userProfile?.wallet_balance || 0;

    // Check if sufficient balance
    if (currentBalance < totalCost) {
      return res.status(402).json({
        error: 'Insufficient balance',
        currentBalance,
        required: totalCost,
        recipients: recipients.length,
        costPerMessage: MESSAGE_COST_IQD,
        message: `You need ${totalCost} IQD to send ${recipients.length} messages. Your current balance is ${currentBalance} IQD.`
      });
    }

    // Deduct total cost upfront
    const newBalance = currentBalance - totalCost;
    await supabase
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', userId);

    // Log transaction
    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      session_id: sessionId,
      transaction_type: 'debit',
      amount: totalCost,
      balance_before: currentBalance,
      balance_after: newBalance,
      description: `Announcement to ${recipients.length} recipients`,
      reference_id: `announcement_${Date.now()}`
    });

    let sent = 0;
    const errors = [];
    let refundAmount = 0;

    console.log(`📱 Sending to ${recipients.length} recipients`);
    for (const recipient of recipients) {
      try {
        // Check client before each message
        if (!isClientReady(client)) {
          console.error(`❌ Client disconnected during sending to ${recipient}`);
          errors.push({ 
            recipient, 
            error: 'WhatsApp session was disconnected. Please reconnect and try again.' 
          });
          refundAmount += MESSAGE_COST_IQD;
          // Clean up the invalid client
          clients.delete(sessionId);
          await supabase
            .from('whatsapp_sessions')
            .update({ status: 'disconnected' })
            .eq('session_id', sessionId);
          break; // Stop sending to remaining recipients
        }

        // Format phone number
        const formattedRecipient = recipient.replace(/[^\d+]/g, '').replace(/^\+/, '');
        let chatId = `${formattedRecipient}@c.us`;
        
        // Try to resolve number ID first
        try {
          const numberId = await client.getNumberId(formattedRecipient);
          if (numberId) {
            chatId = numberId._serialized;
          }
        } catch (lidError) {
          // Continue with original chatId
        }
        
        await client.sendMessage(chatId, message);
        sent++;
        console.log(`✅ Sent to ${recipient}`);
      } catch (error) {
        console.error(`❌ Failed to send to ${recipient}:`, error.message);
        refundAmount += MESSAGE_COST_IQD;
        
        // If session is closed, stop sending and clean up
        if (error.message && error.message.includes('Session closed')) {
          console.log(`🧹 Client disconnected, stopping announcement send`);
          clients.delete(sessionId);
          await supabase
            .from('whatsapp_sessions')
            .update({ status: 'disconnected' })
            .eq('session_id', sessionId);
          errors.push({ 
            recipient, 
            error: 'WhatsApp session was closed. Please reconnect your account and try again.' 
          });
          break; // Stop sending to remaining recipients
        }
        
        errors.push({ recipient, error: error.message });
      }
    }

    // Refund failed messages
    if (refundAmount > 0) {
      const finalBalance = newBalance + refundAmount;
      await supabase
        .from('user_profiles')
        .update({ wallet_balance: finalBalance })
        .eq('id', userId);

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        session_id: sessionId,
        transaction_type: 'credit',
        amount: refundAmount,
        balance_before: newBalance,
        balance_after: finalBalance,
        description: `Refund: Failed to send ${errors.length} messages`,
        reference_id: `refund_announcement_${Date.now()}`
      });
      console.log(`💰 Refunded ${refundAmount} IQD for failed messages`);
    }

    // Log to database
    await supabase.from('automation_logs').insert({
      user_id: userId,
      session_id: sessionId,
      type: 'announcement',
      recipients: JSON.stringify(recipients), // Store as JSON string
      message,
      status: sent > 0 ? 'sent' : 'failed',
      error_message: errors.length > 0 ? JSON.stringify(errors) : null,
    });

    console.log(`✅ Announcement sent: ${sent}/${recipients.length} successful`);
    res.json({ 
      success: true, 
      sent, 
      failed: errors.length,
      errors,
      balance: refundAmount > 0 ? newBalance + refundAmount : newBalance,
      totalCost: sent * MESSAGE_COST_IQD,
      refunded: refundAmount
    });
  } catch (error) {
    console.error('❌ Error sending announcement:', error);
    res.status(500).json({ error: error.message });
  }
});

// API Key Authentication Middleware
async function authenticateApiKey(req, res, next) {
  try {
    // Get API key from headers (case-insensitive)
    const apiKey = req.headers['x-api-key'] || 
                   req.headers['X-API-Key'] ||
                   req.headers['X-API-KEY'] ||
                   req.headers['authorization']?.replace('Bearer ', '') ||
                   req.headers['Authorization']?.replace('Bearer ', '');
    
    console.log('🔑 API Key auth check:', {
      hasHeader: !!req.headers['x-api-key'] || !!req.headers['X-API-Key'],
      headerKeys: Object.keys(req.headers).filter(k => k.toLowerCase().includes('api') || k.toLowerCase().includes('authorization')),
      apiKeyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'none'
    });
    
    if (!apiKey) {
      console.error('❌ No API key found in headers');
      return res.status(401).json({ error: 'API key is required' });
    }

    // Find API key in database
    const { data: apiKeyData, error } = await supabase
      .from('api_keys')
      .select('*, whatsapp_sessions(*)')
      .eq('api_key', apiKey)
      .eq('is_active', true)
      .single();

    if (error || !apiKeyData) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Update last used timestamp
    await supabase
      .from('api_keys')
      .update({ 
        last_used_at: new Date().toISOString(),
        usage_count: (apiKeyData.usage_count || 0) + 1
      })
      .eq('id', apiKeyData.id);

    // Attach API key info to request
    req.apiKey = apiKeyData;
    req.userId = apiKeyData.user_id;
    req.sessionId = apiKeyData.session_id;
    req.phoneNumber = apiKeyData.phone_number;

    next();
  } catch (error) {
    console.error('❌ API key authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ==================== EXTERNAL API ENDPOINTS (API Key Auth) ====================

// Get wallet balance (API Key)
app.get('/api/v1/wallet/balance', authenticateApiKey, async (req, res) => {
  try {
    const { data: userProfile, error } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', req.userId)
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      balance: userProfile?.wallet_balance || DEFAULT_WALLET_BALANCE,
      currency: 'IQD'
    });
  } catch (error) {
    console.error('❌ Error fetching balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get wallet transactions (API Key)
app.get('/api/v1/wallet/transactions', authenticateApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { data: transactions, error } = await supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send message via API Key
app.post('/api/v1/messages/send', authenticateApiKey, async (req, res) => {
  try {
    const { recipient, message } = req.body;

    if (!recipient || !message) {
      return res.status(400).json({ error: 'recipient and message are required' });
    }

    const client = clients.get(req.sessionId);
    if (!client) {
      return res.status(404).json({ error: 'WhatsApp session not found. Please reconnect via the dashboard.' });
    }

    if (!isClientReady(client)) {
      // Check if client exists but isn't ready yet
      if (client && !client.info) {
        return res.status(503).json({ 
          error: 'WhatsApp session is still initializing. Please wait a moment and try again.',
          sessionStatus: 'initializing'
        });
      }
      return res.status(400).json({ error: 'WhatsApp session is disconnected. Please reconnect via the dashboard.' });
    }

    // Check and deduct balance
    const balanceCheck = await deductBalance(req.userId, req.sessionId, `Message sent to ${recipient} via API`, `api_${Date.now()}`);
    if (!balanceCheck.success) {
      return res.status(402).json({
        error: balanceCheck.error || 'Insufficient balance',
        currentBalance: balanceCheck.currentBalance,
        required: MESSAGE_COST_IQD
      });
    }

    // Format phone number (remove any non-digits except +, then remove +)
    const formattedNumber = recipient.replace(/[^\d+]/g, '').replace(/^\+/, '');
    let chatId = formattedNumber.includes('@') ? formattedNumber : `${formattedNumber}@c.us`;
    
    try {
      // Try to get the number ID first (resolves LID issue)
      let numberId;
      try {
        numberId = await client.getNumberId(chatId.replace('@c.us', ''));
        if (numberId) {
          chatId = numberId._serialized;
        }
      } catch (lidError) {
        console.log(`⚠️ Could not resolve number ID for ${chatId}, trying direct send...`);
        // Continue with original chatId if resolution fails
      }
      
      await client.sendMessage(chatId, message);

      // Log to database
      await supabase.from('automation_logs').insert({
        user_id: req.userId,
        session_id: req.sessionId,
        type: 'api_message',
        recipient,
        message,
        status: 'sent',
      });

      res.json({
        success: true,
        message: 'Message sent successfully',
        balance: balanceCheck.balanceAfter,
        recipient,
        sentAt: new Date().toISOString()
      });
    } catch (sendError) {
      // Refund balance if message failed
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('wallet_balance')
        .eq('id', req.userId)
        .single();
      
      if (userProfile && balanceCheck.success) {
        const refundAmount = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
        await supabase
          .from('user_profiles')
          .update({ wallet_balance: refundAmount })
          .eq('id', req.userId);
        
        await supabase.from('wallet_transactions').insert({
          user_id: req.userId,
          session_id: req.sessionId,
          transaction_type: 'credit',
          amount: MESSAGE_COST_IQD,
          balance_before: balanceCheck.balanceAfter,
          balance_after: refundAmount,
          description: `Refund: Failed to send message to ${recipient} via API`,
          reference_id: `refund_api_${Date.now()}`
        });
      }

      throw sendError;
    }
  } catch (error) {
    console.error('❌ Error sending message via API:', error);
    res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

// Send bulk messages via API Key
app.post('/api/v1/messages/send-bulk', authenticateApiKey, async (req, res) => {
  try {
    const { recipients, message } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients array is required and must not be empty' });
    }

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const client = clients.get(req.sessionId);
    if (!client) {
      return res.status(404).json({ error: 'WhatsApp session not found. Please reconnect via the dashboard.' });
    }

    if (!isClientReady(client)) {
      // Check if client exists but isn't ready yet
      if (client && !client.info) {
        return res.status(503).json({ 
          error: 'WhatsApp session is still initializing. Please wait a moment and try again.',
          sessionStatus: 'initializing'
        });
      }
      return res.status(400).json({ error: 'WhatsApp session is disconnected. Please reconnect via the dashboard.' });
    }

    // Calculate total cost
    const totalCost = recipients.length * MESSAGE_COST_IQD;
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', req.userId)
      .single();

    const currentBalance = userProfile?.wallet_balance || 0;

    if (currentBalance < totalCost) {
      return res.status(402).json({
        error: 'Insufficient balance',
        currentBalance,
        required: totalCost,
        recipients: recipients.length,
        costPerMessage: MESSAGE_COST_IQD
      });
    }

    // Deduct total cost
    const newBalance = currentBalance - totalCost;
    await supabase
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', req.userId);

    await supabase.from('wallet_transactions').insert({
      user_id: req.userId,
      session_id: req.sessionId,
      transaction_type: 'debit',
      amount: totalCost,
      balance_before: currentBalance,
      balance_after: newBalance,
      description: `Bulk message to ${recipients.length} recipients via API`,
      reference_id: `api_bulk_${Date.now()}`
    });

    let sent = 0;
    const errors = [];
    let refundAmount = 0;

    for (const recipient of recipients) {
      try {
        if (!isClientReady(client)) {
          errors.push({ recipient, error: 'Session disconnected' });
          refundAmount += MESSAGE_COST_IQD;
          break;
        }

        const chatId = recipient.includes('@') ? recipient : `${recipient}@c.us`;
        await client.sendMessage(chatId, message);
        sent++;
      } catch (error) {
        errors.push({ recipient, error: error.message });
        refundAmount += MESSAGE_COST_IQD;
      }
    }

    // Refund failed messages
    if (refundAmount > 0) {
      const finalBalance = newBalance + refundAmount;
      await supabase
        .from('user_profiles')
        .update({ wallet_balance: finalBalance })
        .eq('id', req.userId);

      await supabase.from('wallet_transactions').insert({
        user_id: req.userId,
        session_id: req.sessionId,
        transaction_type: 'credit',
        amount: refundAmount,
        balance_before: newBalance,
        balance_after: finalBalance,
        description: `Refund: Failed to send ${errors.length} messages via API`,
        reference_id: `refund_api_bulk_${Date.now()}`
      });
    }

    res.json({
      success: true,
      sent,
      failed: errors.length,
      errors,
      balance: newBalance + refundAmount,
      totalCost: sent * MESSAGE_COST_IQD,
      refunded: refundAmount
    });
  } catch (error) {
    console.error('❌ Error sending bulk messages via API:', error);
    res.status(500).json({ error: error.message || 'Failed to send messages' });
  }
});

// Get API key info
app.get('/api/v1/auth/info', authenticateApiKey, async (req, res) => {
  res.json({
    success: true,
    apiKey: {
      phoneNumber: req.phoneNumber,
      sessionId: req.sessionId,
      lastUsedAt: req.apiKey.last_used_at,
      usageCount: req.apiKey.usage_count,
      createdAt: req.apiKey.created_at
    }
  });
});

// Get session status (API Key)
app.get('/api/v1/session/status', authenticateApiKey, async (req, res) => {
  try {
    const client = clients.get(req.sessionId);
    const isReady = isClientReady(client);
    
    res.json({
      success: true,
      sessionId: req.sessionId,
      isReady,
      hasClient: !!client,
      hasInfo: client ? !!client.info : false
    });
  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== USER ENDPOINTS (Dashboard) ====================

// Get wallet balance
app.get('/api/wallet/balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: userProfile, error } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      balance: userProfile?.wallet_balance || DEFAULT_WALLET_BALANCE,
      currency: 'IQD'
    });
  } catch (error) {
    console.error('❌ Error fetching balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get wallet transactions
app.get('/api/wallet/transactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { data: transactions, error } = await supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get API keys for user
app.get('/api/api-keys/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: apiKeys, error } = await supabase
      .from('api_keys')
      .select('id, phone_number, session_id, is_active, created_at, last_used_at, usage_count')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      apiKeys: apiKeys.map(key => ({
        ...key,
        // Don't expose full API key, only show first 8 chars
        apiKeyPrefix: key.api_key ? key.api_key.substring(0, 12) + '...' : null
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching API keys:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get full API key (only for display)
app.get('/api/api-keys/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;
    const { data: apiKey, error } = await supabase
      .from('api_keys')
      .select('api_key, phone_number, created_at')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .single();

    if (error || !apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      success: true,
      apiKey: apiKey.api_key,
      phoneNumber: apiKey.phone_number,
      createdAt: apiKey.created_at
    });
  } catch (error) {
    console.error('❌ Error fetching API key:', error);
    res.status(500).json({ error: error.message });
  }
});

// Revoke API key
app.post('/api/api-keys/revoke/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;
    const { error } = await supabase
      .from('api_keys')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('session_id', sessionId);

    if (error) {
      throw error;
    }

    res.json({ success: true, message: 'API key revoked successfully' });
  } catch (error) {
    console.error('❌ Error revoking API key:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACCOUNT STRENGTH ENDPOINTS ====================

// Get account strength metrics for a session
app.get('/api/account-strength/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;

    // First, update the metrics by calling the database function
    const { error: updateError } = await supabase.rpc('update_account_strength_metrics', {
      p_session_id: sessionId
    });

    if (updateError) {
      console.warn('⚠️ Could not update metrics (function might not exist yet):', updateError);
      // Continue anyway - try to get existing metrics
    }

    // Get the metrics
    const { data: metrics, error } = await supabase
      .from('account_strength_metrics')
      .select('*')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .single();

    if (error || !metrics) {
      // If no metrics exist, calculate basic ones
      const { data: session } = await supabase
        .from('whatsapp_sessions')
        .select('created_at')
        .eq('session_id', sessionId)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Calculate account age accurately
      const accountAgeDays = Math.floor((new Date() - new Date(session.created_at)) / (1000 * 60 * 60 * 24));
      
      // Get all logs to count messages accurately
      const { data: logs } = await supabase
        .from('automation_logs')
        .select('type, recipient, recipients')
        .eq('session_id', sessionId)
        .eq('status', 'sent')
        .in('type', ['otp', 'announcement', 'api_message', 'strengthening']);

      // Count total messages accurately
      let totalSent = 0;
      const uniqueContactsSet = new Set();
      
      if (logs && logs.length > 0) {
        for (const log of logs) {
          if (log.type === 'announcement' && log.recipients) {
            try {
              const recipients = JSON.parse(log.recipients);
              if (Array.isArray(recipients)) {
                totalSent += recipients.length;
                recipients.forEach(r => uniqueContactsSet.add(r));
              }
            } catch (e) {
              // If JSON parse fails, count as 1
              totalSent += 1;
              if (log.recipient) uniqueContactsSet.add(log.recipient);
            }
          } else {
            // For OTP, API messages, and strengthening - count as 1
            totalSent += 1;
            if (log.recipient) uniqueContactsSet.add(log.recipient);
          }
        }
      }
      
      const uniqueContacts = uniqueContactsSet.size;
      const avgPerDay = accountAgeDays > 0 ? totalSent / accountAgeDays : 0;
      
      // Calculate basic score with improved formula
      const engagementRate = accountAgeDays > 7 && totalSent > 5 ? 25 : 
                           accountAgeDays > 3 && totalSent > 2 ? 15 : 5;
      
      const strengthScore = Math.min(100, Math.max(0,
        Math.min(20, accountAgeDays * 1.33) +  // Account age (15 days = max)
        Math.min(30, (totalSent / 20.0) * 30) +  // Message volume (20 msgs = max)
        Math.min(25, (uniqueContacts / 10.0) * 25) +  // Unique contacts (10 = max)
        Math.min(15, avgPerDay * 15) +  // Consistency (1 msg/day = max)
        (engagementRate / 100.0) * 10  // Engagement
      ));

      const banRiskLevel = strengthScore >= 80 ? 'low' : 
                          strengthScore >= 60 ? 'medium' : 
                          strengthScore >= 40 ? 'high' : 'critical';

      return res.json({
        success: true,
        metrics: {
          account_age_days: accountAgeDays,
          total_messages_sent: totalSent,
          total_messages_received: 0,
          unique_contacts_count: uniqueContacts,
          avg_messages_per_day: parseFloat(avgPerDay.toFixed(2)),
          max_messages_per_hour: 10,
          engagement_rate: engagementRate,
          profile_complete: true,
          strength_score: Math.round(strengthScore),
          ban_risk_level: banRiskLevel,
          calculated_at: new Date().toISOString()
        }
      });
    }

    res.json({ success: true, metrics });
  } catch (error) {
    console.error('❌ Error fetching account strength:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get strengthening logs for a session
app.get('/api/account-strength/:userId/:sessionId/logs', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    const { data: logs, error } = await supabase
      .from('strengthening_logs')
      .select('*')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    res.json({ success: true, logs: logs || [] });
  } catch (error) {
    console.error('❌ Error fetching strengthening logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Comprehensive account strengthening service (single button - performs all activities)
app.post('/api/account-strength/:userId/:sessionId/strengthen-comprehensive', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;

    const client = clients.get(sessionId);
    if (!client || !isClientReady(client)) {
      return res.status(400).json({ error: 'Session not ready. Please ensure your WhatsApp is connected.' });
    }

    // Comprehensive strengthening costs 25 IQD (combines all services)
    const cost = 25;

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    const currentBalance = userProfile?.wallet_balance || 0;
    if (currentBalance < cost) {
      return res.status(402).json({
        error: 'Insufficient balance',
        currentBalance,
        required: cost
      });
    }

    // Create log entry for comprehensive strengthening
    const { data: logEntry, error: logError } = await supabase
      .from('strengthening_logs')
      .insert({
        session_id: sessionId,
        user_id: userId,
        service_type: 'comprehensive',
        service_status: 'pending',
        cost_iqd: cost
      })
      .select()
      .single();

    if (logError) {
      throw logError;
    }

    // Deduct balance
    await supabase
      .from('user_profiles')
      .update({ wallet_balance: currentBalance - cost })
      .eq('id', userId);

    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      session_id: sessionId,
      transaction_type: 'debit',
      amount: cost,
      balance_before: currentBalance,
      balance_after: currentBalance - cost,
      description: `Comprehensive account strengthening (all activities)`,
      reference_id: `strengthen_${Date.now()}`
    });

    // Perform strengthening activity
    try {
      let activityDetails = {};
      
      switch (serviceType) {
        case 'profile_update':
          // Get profile picture and info (simulates profile activity)
          try {
            const profilePic = await client.getProfilePicUrl(client.info.wid._serialized);
            const info = client.info;
            activityDetails = {
              profilePicFetched: !!profilePic,
              profileName: info.pushname || '',
              timestamp: new Date().toISOString()
            };
            // Also update "last seen" by checking state
            await client.getState();
          } catch (err) {
            console.log('Profile update activity:', err.message);
          }
          break;
          
        case 'message_simulation':
          // Get chats and actually read multiple messages to simulate real activity
          const chats = await client.getChats();
          activityDetails.chatsFound = chats.length;
          
          if (chats.length > 0) {
            // Read messages from up to 3 random chats
            const chatsToRead = chats
              .sort(() => 0.5 - Math.random())
              .slice(0, Math.min(3, chats.length));
            
            for (const chat of chatsToRead) {
              try {
                // Fetch recent messages (simulates reading)
                const messages = await chat.fetchMessages({ limit: 5 });
                
                // Mark as read if possible
                try {
                  if (messages.length > 0 && chat.unreadCount > 0) {
                    await chat.markSeen();
                  }
                } catch (readErr) {
                  // Ignore read errors
                }
              } catch (msgErr) {
                console.log('Error reading chat:', msgErr.message);
              }
            }
            
            activityDetails.chatsRead = chatsToRead.length;
            activityDetails.messagesRead = chatsToRead.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
          }
          break;
          
        case 'contact_sync':
          // Get and cache contacts (simulates contact sync activity)
          const contacts = await client.getContacts();
          activityDetails.contactsCount = contacts.length;
          
          // Also get block list to show account is active
          try {
            const blockedContacts = await client.getBlockedContacts();
            activityDetails.blockedCount = blockedContacts.length;
          } catch (err) {
            // Blocked contacts might not be available
          }
          break;
          
        case 'status_update':
          // Check connection state and get account info (shows active presence)
          const state = await client.getState();
          const accountInfo = client.info;
          
          activityDetails.state = state;
          activityDetails.accountActive = state === 'CONNECTED';
          activityDetails.pushName = accountInfo.pushname || '';
          
          // Also fetch chats count to show activity
          const allChats = await client.getChats();
          activityDetails.totalChats = allChats.length;
          break;
          
        case 'idle_period':
          // Simulate idle by doing minimal activity after delay
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Check state to show we're still connected
          const idleState = await client.getState();
          activityDetails.idlePeriodSeconds = 2;
          activityDetails.stateDuringIdle = idleState;
          break;
      }
      
      // Log the comprehensive activity to automation_logs for tracking
      await supabase.from('automation_logs').insert({
        user_id: userId,
        session_id: sessionId,
        type: 'strengthening',
        recipient: 'comprehensive',
        message: `Comprehensive account strengthening completed: ${activityDetails.completedSteps}/${activityDetails.totalSteps} steps`,
        status: 'sent'
      });

      // Update log as completed with activity details
      await supabase
        .from('strengthening_logs')
        .update({
          service_status: 'completed',
          completed_at: new Date().toISOString(),
          service_details: { 
            success: true, 
            timestamp: new Date().toISOString(),
            ...activityDetails
          }
        })
        .eq('id', logEntry.id);
      
      // Trigger account strength metrics recalculation
      try {
        await supabase.rpc('update_account_strength_metrics', {
          p_session_id: sessionId
        });
      } catch (recalcError) {
        console.log('Could not recalculate metrics:', recalcError.message);
      }

      // Update last activity
      await supabase
        .from('whatsapp_sessions')
        .update({ last_activity: new Date().toISOString() })
        .eq('session_id', sessionId);

      res.json({
        success: true,
        message: 'Comprehensive account strengthening completed successfully',
        logId: logEntry.id,
        newBalance: currentBalance - cost,
        activityDetails: activityDetails,
        stepsCompleted: activityDetails.completedSteps,
        totalSteps: activityDetails.totalSteps
      });
    } catch (activityError) {
      // Update log as failed
      await supabase
        .from('strengthening_logs')
        .update({
          service_status: 'failed',
          completed_at: new Date().toISOString(),
          service_details: { error: activityError.message }
        })
        .eq('id', logEntry.id);

      throw activityError;
    }
  } catch (error) {
    console.error('❌ Error in account strengthening:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test message sending (from dashboard)
app.post('/api/whatsapp/test-message', async (req, res) => {
  try {
    const { sessionId, recipient, message, userId } = req.body;

    if (!sessionId || !recipient || !message || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = clients.get(sessionId);
    if (!client) {
      // Check if session exists and is being restored
      const { data: sessionData } = await supabase
        .from('whatsapp_sessions')
        .select('status')
        .eq('session_id', sessionId)
        .single();

      if (sessionData?.status === 'connected') {
        return res.status(503).json({
          error: 'Session is being restored. Please wait a moment and try again.',
          sessionStatus: 'restoring'
        });
      }
      return res.status(400).json({ error: 'WhatsApp session not found or disconnected' });
    }

    if (!isClientReady(client)) {
      if (client && !client.info) {
        return res.status(503).json({
          error: 'WhatsApp session is still initializing. Please wait a moment and try again.',
          sessionStatus: 'initializing'
        });
      }
      return res.status(400).json({ error: 'WhatsApp session is disconnected' });
    }

    // Check wallet balance
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    const currentBalance = userProfile?.wallet_balance || 0;
    if (currentBalance < MESSAGE_COST_IQD) {
      return res.status(402).json({
        error: 'Insufficient balance',
        currentBalance,
        required: MESSAGE_COST_IQD
      });
    }

    // Format phone number
    const formattedNumber = recipient.replace(/[^\d+]/g, '').replace(/^\+/, '');
    let chatId = formattedNumber.includes('@') ? formattedNumber : `${formattedNumber}@c.us`;

    // Try to resolve number ID
    try {
      const numberId = await client.getNumberId(formattedNumber);
      if (numberId) {
        chatId = numberId._serialized;
      }
    } catch (lidError) {
      console.log(`⚠️ Could not resolve number ID for ${formattedNumber}, trying direct send...`);
    }

    // Send message
    await client.sendMessage(chatId, message);

    // Deduct balance
    const newBalance = currentBalance - MESSAGE_COST_IQD;
    await supabase
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', userId);

    // Log transaction
    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      session_id: sessionId,
      transaction_type: 'debit',
      amount: MESSAGE_COST_IQD,
      balance_before: currentBalance,
      balance_after: newBalance,
      description: `Test message to ${formattedNumber}`,
      reference_id: `test_msg_${Date.now()}`
    });

    // Log in automation_logs
    await supabase.from('automation_logs').insert({
      user_id: userId,
      session_id: sessionId,
      type: 'api_message',
      recipient: formattedNumber,
      message: message,
      status: 'sent'
    });

    res.json({
      success: true,
      message: 'Test message sent successfully',
      recipient: formattedNumber,
      balance: newBalance,
      sentAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error sending test message:', error);
    res.status(500).json({ error: error.message || 'Failed to send test message' });
  }
});

// Railway provides PORT, default to 5000 for local development
const PORT = process.env.PORT || 5000;

// Start server and restore active sessions
async function startServer() {
  // Restore active sessions before starting server
  await restoreActiveSessions();

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 Wassapi backend server running on port', PORT);
  console.log('📍 Health check: http://localhost:' + PORT + '/health');
  console.log('📍 Test endpoint: http://localhost:' + PORT + '/api/test');
  console.log('🌐 Trust proxy enabled for Railway');
    console.log(`📊 Active clients: ${clients.size}`);
  console.log('');
  });
}

startServer().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
