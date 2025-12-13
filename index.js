const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { backupSession, restoreSession, deleteSession, ensureBucketExists } = require('./services/session-storage');
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
    
    // Ensure storage bucket exists
    await ensureBucketExists();
    
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
        // First, restore session data from Supabase Storage
        console.log(`📥 Restoring session data for ${session.session_id} from storage...`);
        const restored = await restoreSession(session.session_id);
        if (restored) {
          console.log(`✅ Session data restored for ${session.session_id}`);
        } else {
          console.log(`⚠️ No session data found in storage for ${session.session_id}`);
          console.log(`   This is expected for new sessions or first deployment. Will attempt to restore client - if session data is invalid, a QR code will be generated.`);
        }
        
        // Then restore the client
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

    // Set up QR code handler BEFORE initialize (in case session data is missing)
    client.on('qr', async (qr) => {
      console.log(`📱 QR code generated for restored session ${sessionId} - session data may be invalid or expired`);
      try {
        const qrCodeData = await qrcode.toDataURL(qr);
        await supabase
          .from('whatsapp_sessions')
          .update({ 
            status: 'qr_pending',
            qr_code: qrCodeData 
          })
          .eq('session_id', sessionId);
        console.log(`✅ QR code saved to database for session ${sessionId}`);
      } catch (error) {
        console.error(`❌ Error saving QR code for session ${sessionId}:`, error);
      }
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
            
            const { data: session } = await supabase
              .from('whatsapp_sessions')
              .select('user_id')
              .eq('session_id', sessionId)
              .single();
            
            await supabase
              .from('whatsapp_sessions')
              .update({ 
                status: 'connected',
                last_activity: new Date().toISOString() 
              })
              .eq('session_id', sessionId);
            
            // Track subscription usage for restored session (if it's a new number)
            if (session && session.user_id) {
              const activeSubscription = await getActiveSubscription(session.user_id);
              if (activeSubscription) {
                // Check if this is a new number by counting existing connected sessions
                const { count } = await supabase
                  .from('whatsapp_sessions')
                  .select('*', { count: 'exact', head: true })
                  .eq('user_id', session.user_id)
                  .eq('status', 'connected');
                
                // Only increment if this is the first connected session (new number)
                if (count === 1) {
                  await incrementSubscriptionUsage(activeSubscription.id, 0, 1);
                }
              }
            }
            
            // Backup session data to Supabase Storage
            backupSession(sessionId).catch(err => {
              console.error(`⚠️ Failed to backup session ${sessionId}:`, err.message);
            });
            
            // Log connection event
            const { data: session } = await supabase
              .from('whatsapp_sessions')
              .select('user_id')
              .eq('session_id', sessionId)
              .single();
            
            if (session) {
              try {
                await supabase.from('connection_events').insert({
                  session_id: sessionId,
                  user_id: session.user_id,
                  event_type: 'connected',
                  event_details: { 
                    state: 'CONNECTED',
                    phone: info.wid.user,
                    timestamp: new Date().toISOString() 
                  }
                });
              } catch (e) {
                // Ignore errors if table doesn't exist yet
              }
            }

            // Setup incoming message handlers
            setupIncomingMessageHandlers(client, session.user_id, sessionId);
            
            resolve(client);
          });

    client.on('authenticated', async () => {
      console.log(`✅ Authenticated for restored session ${sessionId}`);
      // Backup session data when authenticated (async, don't block)
      backupSession(sessionId).catch(err => {
        console.error(`⚠️ Failed to backup session ${sessionId} after authentication:`, err.message);
      });
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
            
            // Log disconnection event
            const { data: session } = await supabase
              .from('whatsapp_sessions')
              .select('user_id')
              .eq('session_id', sessionId)
              .single();
            
            if (session) {
              await supabase.from('connection_events').insert({
                session_id: sessionId,
                user_id: session.user_id,
                event_type: 'disconnected',
                event_details: { 
                  reason: reason || 'unknown',
                  timestamp: new Date().toISOString() 
                }
              }).catch(() => {}); // Ignore errors if table doesn't exist yet
            }
            
            clients.delete(sessionId);
          });

    // Initialize client
    client.initialize().then(() => {
      // Store client immediately - ready event will fire later
      clients.set(sessionId, client);
      console.log(`✅ Client restored and stored for session ${sessionId} (waiting for ready...)`);
      
      // Set timeout to 120 seconds (2 minutes) for restoration
      timeoutId = setTimeout(() => {
        if (!isResolved && !client.info) {
          console.warn(`⚠️ Client for session ${sessionId} did not become ready within 120 seconds`);
          
          // Check if a QR code was generated (meaning re-auth is needed)
          // If not, there might be another issue - mark as failed
          supabase
            .from('whatsapp_sessions')
            .select('status, qr_code')
            .eq('session_id', sessionId)
            .single()
            .then(({ data: sessionData }) => {
              if (sessionData && sessionData.status !== 'qr_pending') {
                // No QR code generated and not ready - mark as failed
                supabase
                  .from('whatsapp_sessions')
                  .update({ status: 'failed' })
                  .eq('session_id', sessionId);
                console.log(`❌ Session ${sessionId} marked as failed - no authentication progress`);
              }
            });
          
          // Resolve the promise so restore doesn't hang, but client is stored
          if (!isResolved) {
            isResolved = true;
            resolve(client);
          }
        }
      }, 120000); // 120 seconds
    }).catch((error) => {
      clearTimeout(timeoutId);
      if (isResolved) return;
      isResolved = true;
      
      console.error(`❌ Error initializing restored client for session ${sessionId}:`, error);
      clients.delete(sessionId);
      
      // Mark session as failed if initialization fails
      supabase
        .from('whatsapp_sessions')
        .update({ status: 'failed' })
        .eq('session_id', sessionId)
        .catch(err => console.error('Error updating session status:', err));
      
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
        
        // Track subscription usage for new number
        const activeSubscription = await getActiveSubscription(userId);
        if (activeSubscription) {
          await incrementSubscriptionUsage(activeSubscription.id, 0, 1);
        }
      }
      
      // Backup session data to Supabase Storage (async, don't block)
      backupSession(sessionId).catch(err => {
        console.error(`⚠️ Failed to backup session ${sessionId}:`, err.message);
      });

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

      // Setup incoming message handlers
      setupIncomingMessageHandlers(client, userId, sessionId);
    });

    client.on('authenticated', async () => {
      console.log(`✅ Authenticated for session ${sessionId}`);
      // Backup session data when authenticated (async, don't block)
      backupSession(sessionId).catch(err => {
        console.error(`⚠️ Failed to backup session ${sessionId} after authentication:`, err.message);
      });
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

    // Check subscription limits for new number
    const subscriptionCheck = await checkSubscriptionLimits(userId, 0, 1);
    if (!subscriptionCheck.allowed) {
      return res.status(403).json({
        error: 'Subscription limit exceeded',
        reason: subscriptionCheck.reason,
        details: subscriptionCheck,
        message: 'You have reached the maximum number of WhatsApp accounts allowed by your subscription. Please upgrade your subscription to connect more accounts.'
      });
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
    
    // Delete session data from Supabase Storage
    deleteSession(sessionId).catch(err => {
      console.error(`⚠️ Failed to delete session ${sessionId} from storage:`, err.message);
    });

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
    const { sessionId, recipient, otp, userId, language } = req.body;

    let client = clients.get(sessionId);
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
          // Session exists but wasn't restored - try to restore it now
          console.log(`🔄 Attempting to restore session ${sessionId} on demand...`);
          try {
            client = await restoreClient(userId, sessionId);
            // Wait a bit for client to potentially become ready
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (restoreError) {
            console.error(`❌ Failed to restore session ${sessionId}:`, restoreError);
            return res.status(503).json({ 
              error: 'Session is being restored. Please wait a moment and try again.',
              sessionStatus: 'restoring'
            });
          }
        } else {
          return res.status(400).json({ 
            error: `Session exists but is ${session.status}. Please reconnect your WhatsApp account via the dashboard.`,
            sessionStatus: session.status
          });
        }
      } else {
        return res.status(404).json({ error: 'Session not found. Please reconnect your WhatsApp account via the dashboard.' });
      }
    }

    // Check if client is still ready
    if (!isClientReady(client)) {
      // Check if client exists but isn't ready yet (still initializing)
      if (client && !client.info) {
        console.log(`⏳ Client for session ${sessionId} is still initializing...`);
        
        // Check how long it's been since the session was created/updated
        const { data: sessionData } = await supabase
          .from('whatsapp_sessions')
          .select('updated_at, created_at')
          .eq('session_id', sessionId)
          .single();
        
        if (sessionData) {
          const lastUpdate = new Date(sessionData.updated_at || sessionData.created_at);
          const minutesSinceUpdate = (Date.now() - lastUpdate.getTime()) / 1000 / 60;
          
          // If it's been more than 5 minutes, mark as disconnected
          if (minutesSinceUpdate > 5) {
            console.log(`⚠️ Session ${sessionId} has been initializing for ${minutesSinceUpdate.toFixed(1)} minutes - marking as disconnected`);
            clients.delete(sessionId);
            await supabase
              .from('whatsapp_sessions')
              .update({ status: 'disconnected' })
              .eq('session_id', sessionId);
            return res.status(400).json({ 
              error: 'WhatsApp session failed to initialize. Please reconnect your account via the dashboard.',
              sessionStatus: 'failed'
            });
          }
        }
        
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

    // Check subscription limits
    const subscriptionCheck = await checkSubscriptionLimits(userId, 1, 0);
    if (!subscriptionCheck.allowed) {
      return res.status(403).json({
        error: 'Subscription limit exceeded',
        reason: subscriptionCheck.reason,
        details: subscriptionCheck
      });
    }

    // Check rate limits
    const rateLimitCheck = await checkRateLimit(userId, 1);
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        reason: rateLimitCheck.reason,
        limit: rateLimitCheck.limit,
        current: rateLimitCheck.current
      });
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

    // Concise but informative OTP message format
    // Default to Arabic/English bilingual if no language specified
    const messageLanguage = language || 'ar'; // 'ar' or 'en'
    let message;
    if (messageLanguage === 'en') {
      message = `Your verification code is: ${otp}\nValid for 5 minutes.`;
    } else {
      message = `رمز التحقق الخاص بك هو: ${otp}\nصالح لمدة 5 دقائق.`;
    }
    
    // Format phone number (remove any non-digits except +, then remove +)
    const formattedNumber = recipient.replace(/[^\d+]/g, '').replace(/^\+/, '');
    
    // Validate phone number format (should be digits only, 9-15 digits)
    if (!/^\d{9,15}$/.test(formattedNumber)) {
      // Refund balance
      if (balanceCheck.success) {
        const { data: userProfile } = await supabase
          .from('user_profiles')
          .select('wallet_balance')
          .eq('id', userId)
          .single();
        if (userProfile) {
          const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
          await supabase
            .from('user_profiles')
            .update({ wallet_balance: refundedBalance })
            .eq('id', userId);
        }
      }
      return res.status(400).json({ 
        error: 'Invalid phone number format. Please use international format without + (e.g., 9647812345678)',
        received: recipient
      });
    }
    
    console.log(`📱 Sending OTP to ${formattedNumber}`);
    
    try {
      // Try to get the number ID (LID) first - required for sending messages
      let numberId;
      try {
        numberId = await client.getNumberId(formattedNumber);
        if (!numberId || !numberId._serialized) {
          // Refund balance
          if (balanceCheck.success) {
            const { data: userProfile } = await supabase
              .from('user_profiles')
              .select('wallet_balance')
              .eq('id', userId)
              .single();
            if (userProfile) {
              const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
              await supabase
                .from('user_profiles')
                .update({ wallet_balance: refundedBalance })
                .eq('id', userId);
            }
          }
          return res.status(400).json({ 
            error: `Unable to resolve WhatsApp account for number ${formattedNumber}. The number may not be registered on WhatsApp or may be invalid.`,
            recipient: formattedNumber,
            hint: 'Ensure the phone number is registered on WhatsApp and uses the correct international format without +'
          });
        }
        var chatId = numberId._serialized;
        console.log(`✅ Resolved LID for ${formattedNumber}: ${chatId}`);
      } catch (lidError) {
        console.error(`❌ Error resolving LID for ${formattedNumber}:`, lidError.message);
        // Refund balance
        if (balanceCheck.success) {
          const { data: userProfile } = await supabase
            .from('user_profiles')
            .select('wallet_balance')
            .eq('id', userId)
            .single();
          if (userProfile) {
            const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
            await supabase
              .from('user_profiles')
              .update({ wallet_balance: refundedBalance })
              .eq('id', userId);
          }
        }
        return res.status(400).json({ 
          error: `Unable to resolve WhatsApp account for number ${formattedNumber}. The number may not be registered on WhatsApp.`,
          recipient: formattedNumber,
          details: lidError.message,
          hint: 'Ensure the phone number is registered on WhatsApp and uses the correct international format without + (e.g., 9647812345678)'
        });
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

      // Track subscription usage
      if (subscriptionCheck.subscription_id) {
        await incrementSubscriptionUsage(subscriptionCheck.subscription_id, 1, 0);
      }

      res.json({ 
        success: true,
        balance: balanceCheck.balanceAfter,
        message: 'OTP sent successfully'
      });

      // Trigger webhooks for successful OTP send (async, don't wait)
      triggerWebhooks(userId, sessionId, 'otp', {
        success: true,
        event: 'otp_sent',
        recipient: formattedNumber,
        otp: otp,
        timestamp: new Date().toISOString(),
        message: 'OTP sent successfully'
      }).catch(err => console.error('Webhook error (non-blocking):', err));

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

      // Trigger webhooks for failed OTP send (async, don't wait)
      triggerWebhooks(userId, sessionId, 'otp', {
        success: false,
        event: 'otp_failed',
        recipient: formattedNumber,
        otp: otp,
        timestamp: new Date().toISOString(),
        error: sendError.message || 'Failed to send OTP'
      }).catch(err => console.error('Webhook error (non-blocking):', err));
      
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

    // Check subscription limits
    const subscriptionCheck = await checkSubscriptionLimits(userId, recipients.length, 0);
    if (!subscriptionCheck.allowed) {
      return res.status(403).json({
        error: 'Subscription limit exceeded',
        reason: subscriptionCheck.reason,
        details: subscriptionCheck
      });
    }

    // Check rate limits
    const rateLimitCheck = await checkRateLimit(userId, recipients.length);
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        reason: rateLimitCheck.reason,
        limit: rateLimitCheck.limit,
        current: rateLimitCheck.current
      });
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
        
        // Validate phone number format
        if (!/^\d{9,15}$/.test(formattedRecipient)) {
          console.error(`⚠️ Invalid phone number format: ${recipient}`);
          errors.push({ 
            recipient, 
            error: 'Invalid phone number format. Use international format without + (e.g., 9647812345678)' 
          });
          refundAmount += MESSAGE_COST_IQD;
          continue;
        }
        
        // Try to resolve number ID (LID) - required for sending messages
        let chatId;
        try {
          const numberId = await client.getNumberId(formattedRecipient);
          if (!numberId || !numberId._serialized) {
            console.error(`⚠️ Could not resolve LID for ${formattedRecipient}`);
            errors.push({ 
              recipient, 
              error: `Unable to resolve WhatsApp account. The number may not be registered on WhatsApp.` 
            });
            refundAmount += MESSAGE_COST_IQD;
            continue;
          }
          chatId = numberId._serialized;
        } catch (lidError) {
          console.error(`❌ Error resolving LID for ${formattedRecipient}:`, lidError.message);
          errors.push({ 
            recipient, 
            error: `Unable to resolve WhatsApp account: ${lidError.message}` 
          });
          refundAmount += MESSAGE_COST_IQD;
          continue;
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

    // Track subscription usage (only for successfully sent messages)
    if (subscriptionCheck && subscriptionCheck.subscription_id && sent > 0) {
      await incrementSubscriptionUsage(subscriptionCheck.subscription_id, sent, 0);
    }

    // Trigger webhooks for announcement (async, don't wait)
    triggerWebhooks(userId, sessionId, 'announcement', {
      success: sent > 0,
      event: 'announcement_sent',
      totalRecipients: recipients.length,
      successfulSends: sent,
      failedSends: errors.length,
      errors: errors,
      message: message,
      timestamp: new Date().toISOString()
    }).catch(err => console.error('Webhook error (non-blocking):', err));
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

// Send OTP via API Key (separate endpoint with fixed message format)
app.post('/api/v1/otp/send', authenticateApiKey, async (req, res) => {
  try {
    const { recipient, otp, language } = req.body;

    if (!recipient || !otp) {
      return res.status(400).json({ error: 'recipient and otp are required' });
    }

    let client = clients.get(req.sessionId);
    if (!client) {
      // Check if session exists in database and try to restore it
      const { data: sessionData } = await supabase
        .from('whatsapp_sessions')
        .select('status, updated_at, created_at')
        .eq('session_id', req.sessionId)
        .eq('user_id', req.userId)
        .single();

      if (sessionData) {
        // Check if session has been stuck for >5 minutes
        const lastUpdate = new Date(sessionData.updated_at || sessionData.created_at);
        const minutesSinceUpdate = (Date.now() - lastUpdate.getTime()) / 1000 / 60;
        
        if (minutesSinceUpdate > 5 && (sessionData.status === 'connected' || sessionData.status === 'connecting')) {
          // Session stuck, mark as disconnected
          await supabase
            .from('whatsapp_sessions')
            .update({ status: 'disconnected' })
            .eq('session_id', req.sessionId);
          return res.status(400).json({ 
            error: 'WhatsApp session timed out. Please reconnect your account via the dashboard.',
            sessionStatus: 'failed'
          });
        }
        
        if (sessionData.status === 'connected' || sessionData.status === 'connecting') {
          // Try to restore session on demand
          console.log(`🔄 Attempting on-demand restoration for session ${req.sessionId}`);
          try {
            await restoreSession(req.sessionId);
            client = await restoreClient(req.userId, req.sessionId);
            // Wait a bit for client to potentially become ready
            await new Promise(resolve => setTimeout(resolve, 3000));
          } catch (restoreError) {
            console.error(`❌ Failed to restore session ${req.sessionId}:`, restoreError.message);
            return res.status(503).json({ 
              error: 'Failed to restore WhatsApp session. Please reconnect your account via the dashboard.',
              sessionStatus: 'failed'
            });
          }
        } else {
          return res.status(400).json({ 
            error: `WhatsApp session is ${sessionData.status}. Please reconnect via the dashboard.`,
            sessionStatus: sessionData.status
          });
        }
      } else {
        return res.status(404).json({ error: 'WhatsApp session not found. Please reconnect via the dashboard.' });
      }
    }

    // Wait for client to become ready if it exists but isn't ready yet
    if (client && !isClientReady(client)) {
      console.log(`⏳ Waiting for session ${req.sessionId} to become ready...`);
      
      // Check how long it's been initializing
      const { data: sessionData } = await supabase
        .from('whatsapp_sessions')
        .select('updated_at, created_at, status')
        .eq('session_id', req.sessionId)
        .single();
      
      if (sessionData) {
        const lastUpdate = new Date(sessionData.updated_at || sessionData.created_at);
        const minutesSinceUpdate = (Date.now() - lastUpdate.getTime()) / 1000 / 60;
        
        if (minutesSinceUpdate > 5) {
          // Been stuck for >5 minutes
          console.log(`⚠️ Session ${req.sessionId} has been initializing for ${minutesSinceUpdate.toFixed(1)} minutes - marking as disconnected`);
          clients.delete(req.sessionId);
          await supabase
            .from('whatsapp_sessions')
            .update({ status: 'disconnected' })
            .eq('session_id', req.sessionId);
          return res.status(400).json({ 
            error: 'WhatsApp session initialization timed out. Please reconnect your account via the dashboard.',
            sessionStatus: 'failed'
          });
        }
      }
      
      // Poll for readiness for up to 15 seconds
      const maxWaitTime = 15000; // 15 seconds
      const pollInterval = 500; // Check every 500ms
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime) {
        if (isClientReady(client)) {
          console.log(`✅ Session ${req.sessionId} became ready after ${Date.now() - startTime}ms`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      
      // Check one more time after polling
      if (!isClientReady(client)) {
        return res.status(503).json({ 
          error: 'WhatsApp session is still initializing. Please wait a moment and try again.',
          sessionStatus: 'initializing',
          hint: 'The session may need a few more seconds. Please try again in 10-15 seconds.'
        });
      }
    } else if (!client) {
      return res.status(400).json({ error: 'WhatsApp session is disconnected. Please reconnect via the dashboard.' });
    }

    // Check and deduct balance
    const balanceCheck = await deductBalance(req.userId, req.sessionId, `OTP sent to ${recipient} via API`, `api_otp_${Date.now()}`);
    if (!balanceCheck.success) {
      return res.status(402).json({
        error: balanceCheck.error || 'Insufficient balance',
        currentBalance: balanceCheck.currentBalance,
        required: MESSAGE_COST_IQD
      });
    }

    // Concise but informative OTP message format
    // Default to Arabic/English bilingual if no language specified
    const messageLanguage = language || 'ar'; // 'ar' or 'en'
    let message;
    if (messageLanguage === 'en') {
      message = `Your verification code is: ${otp}\nValid for 5 minutes.`;
    } else {
      message = `رمز التحقق الخاص بك هو: ${otp}\nصالح لمدة 5 دقائق.`;
    }

    // Format phone number
    const formattedNumber = recipient.replace(/[^\d+]/g, '').replace(/^\+/, '');
    
    // Validate phone number format (should be digits only, 9-15 digits)
    if (!/^\d{9,15}$/.test(formattedNumber)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Please use international format without + (e.g., 9647812345678)',
        received: recipient
      });
    }

    try {
      // Try to resolve number ID (LID) - required for sending messages
      let numberId;
      try {
        numberId = await client.getNumberId(formattedNumber);
        if (!numberId || !numberId._serialized) {
          return res.status(400).json({ 
            error: `Unable to resolve WhatsApp account for number ${formattedNumber}. The number may not be registered on WhatsApp or may be invalid.`,
            recipient: formattedNumber,
            hint: 'Ensure the phone number is registered on WhatsApp and uses the correct international format without +'
          });
        }
        var chatId = numberId._serialized;
        console.log(`✅ Resolved LID for ${formattedNumber}: ${chatId}`);
      } catch (lidError) {
        console.error(`❌ Error resolving LID for ${formattedNumber}:`, lidError.message);
        return res.status(400).json({ 
          error: `Unable to resolve WhatsApp account for number ${formattedNumber}. The number may not be registered on WhatsApp.`,
          recipient: formattedNumber,
          details: lidError.message,
          hint: 'Ensure the phone number is registered on WhatsApp and uses the correct international format without + (e.g., 9647812345678)'
        });
      }

      await client.sendMessage(chatId, message);

      // Log to database
      await supabase.from('automation_logs').insert({
        user_id: req.userId,
        session_id: req.sessionId,
        type: 'otp',
        recipient: formattedNumber,
        message: `OTP: ${otp}`,
        status: 'sent',
      });

      // Track subscription usage
      if (subscriptionCheck.subscription_id) {
        await incrementSubscriptionUsage(subscriptionCheck.subscription_id, 1, 0);
      }

      // Trigger webhooks for successful OTP send (async, don't wait)
      triggerWebhooks(req.userId, req.sessionId, 'otp', {
        success: true,
        event: 'otp_sent',
        recipient: formattedNumber,
        otp: otp,
        timestamp: new Date().toISOString(),
        message: 'OTP sent successfully via API'
      }).catch(err => console.error('Webhook error (non-blocking):', err));

      res.json({
        success: true,
        message: 'OTP sent successfully',
        balance: balanceCheck.balanceAfter,
        recipient: formattedNumber,
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
          description: `Refund: Failed to send OTP to ${formattedNumber} via API`,
          reference_id: `refund_api_otp_${Date.now()}`
        });
      }

      // Trigger webhooks for failed OTP send (async, don't wait)
      triggerWebhooks(req.userId, req.sessionId, 'otp', {
        success: false,
        event: 'otp_failed',
        recipient: formattedNumber,
        otp: otp,
        timestamp: new Date().toISOString(),
        error: sendError.message || 'Failed to send OTP via API'
      }).catch(err => console.error('Webhook error (non-blocking):', err));

      throw sendError;
    }
  } catch (error) {
    console.error('❌ Error sending OTP via API:', error);
    res.status(500).json({ error: error.message || 'Failed to send OTP. Please try again.' });
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

    // Check subscription limits
    const subscriptionCheck = await checkSubscriptionLimits(req.userId, 1, 0);
    if (!subscriptionCheck.allowed) {
      return res.status(403).json({
        error: 'Subscription limit exceeded',
        reason: subscriptionCheck.reason,
        details: subscriptionCheck
      });
    }

    // Check rate limits
    const rateLimitCheck = await checkRateLimit(req.userId, 1);
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        reason: rateLimitCheck.reason,
        limit: rateLimitCheck.limit,
        current: rateLimitCheck.current,
        retryAfter: rateLimitCheck.reason === 'rate_limit_minute' ? 60 : 
                   rateLimitCheck.reason === 'rate_limit_hour' ? 3600 : 86400
      });
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
    
    // Validate phone number format (should be digits only, 9-15 digits)
    if (!/^\d{9,15}$/.test(formattedNumber)) {
      // Refund balance
      if (balanceCheck.success) {
        const { data: userProfile } = await supabase
          .from('user_profiles')
          .select('wallet_balance')
          .eq('id', req.userId)
          .single();
        if (userProfile) {
          const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
          await supabase
            .from('user_profiles')
            .update({ wallet_balance: refundedBalance })
            .eq('id', req.userId);
        }
      }
      return res.status(400).json({ 
        error: 'Invalid phone number format. Please use international format without + (e.g., 9647812345678)',
        received: recipient
      });
    }
    
    try {
      // Try to get the number ID (LID) first - required for sending messages
      let numberId;
      try {
        numberId = await client.getNumberId(formattedNumber);
        if (!numberId || !numberId._serialized) {
          // Refund balance
          if (balanceCheck.success) {
            const { data: userProfile } = await supabase
              .from('user_profiles')
              .select('wallet_balance')
              .eq('id', req.userId)
              .single();
            if (userProfile) {
              const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
              await supabase
                .from('user_profiles')
                .update({ wallet_balance: refundedBalance })
                .eq('id', req.userId);
            }
          }
          return res.status(400).json({ 
            error: `Unable to resolve WhatsApp account for number ${formattedNumber}. The number may not be registered on WhatsApp or may be invalid.`,
            recipient: formattedNumber,
            hint: 'Ensure the phone number is registered on WhatsApp and uses the correct international format without +'
          });
        }
        var chatId = numberId._serialized;
        console.log(`✅ Resolved LID for ${formattedNumber}: ${chatId}`);
      } catch (lidError) {
        console.error(`❌ Error resolving LID for ${formattedNumber}:`, lidError.message);
        // Refund balance
        if (balanceCheck.success) {
          const { data: userProfile } = await supabase
            .from('user_profiles')
            .select('wallet_balance')
            .eq('id', req.userId)
            .single();
          if (userProfile) {
            const refundedBalance = balanceCheck.balanceAfter + MESSAGE_COST_IQD;
            await supabase
              .from('user_profiles')
              .update({ wallet_balance: refundedBalance })
              .eq('id', req.userId);
          }
        }
        return res.status(400).json({ 
          error: `Unable to resolve WhatsApp account for number ${formattedNumber}. The number may not be registered on WhatsApp.`,
          recipient: formattedNumber,
          details: lidError.message,
          hint: 'Ensure the phone number is registered on WhatsApp and uses the correct international format without + (e.g., 9647812345678)'
        });
      }
      
      const messageResult = await client.sendMessage(chatId, message);

      // Track subscription usage
      if (subscriptionCheck.subscription_id) {
        await incrementSubscriptionUsage(subscriptionCheck.subscription_id, 1, 0);
      }

      // Log to database
      await supabase.from('automation_logs').insert({
        user_id: req.userId,
        session_id: req.sessionId,
        type: 'api_message',
        recipient,
        message,
        status: 'sent',
      });
      
      // Track message delivery (initial status: sent)
      if (messageResult && messageResult.id) {
        try {
          await supabase.from('message_delivery_tracking').insert({
            session_id: req.sessionId,
            user_id: req.userId,
            message_id: messageResult.id._serialized || messageResult.id.toString(),
            recipient: formattedNumber,
            status: 'sent',
            sent_at: new Date().toISOString()
          });
        } catch (e) {
          // Ignore errors if table doesn't exist yet
        }
        
        // Set up delivery tracking listeners (if message object supports it)
        if (messageResult.on) {
          messageResult.on('delivery', async () => {
            try {
              await supabase.from('message_delivery_tracking')
                .update({ 
                  status: 'delivered',
                  delivered_at: new Date().toISOString()
                })
                .eq('message_id', messageResult.id._serialized || messageResult.id.toString());
            } catch (e) {
              // Ignore errors
            }
          });
          
          messageResult.on('read', async () => {
            try {
              await supabase.from('message_delivery_tracking')
                .update({ 
                  status: 'read',
                  read_at: new Date().toISOString()
                })
                .eq('message_id', messageResult.id._serialized || messageResult.id.toString());
            } catch (e) {
              // Ignore errors
            }
          });
        }
      }

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

    // Check subscription limits
    const subscriptionCheck = await checkSubscriptionLimits(req.userId, recipients.length, 0);
    if (!subscriptionCheck.allowed) {
      return res.status(403).json({
        error: 'Subscription limit exceeded',
        reason: subscriptionCheck.reason,
        details: subscriptionCheck
      });
    }

    // Check rate limits
    const rateLimitCheck = await checkRateLimit(req.userId, recipients.length);
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        reason: rateLimitCheck.reason,
        limit: rateLimitCheck.limit,
        current: rateLimitCheck.current
      });
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

    // Track subscription usage (only for successfully sent messages)
    if (subscriptionCheck && subscriptionCheck.subscription_id && sent > 0) {
      await incrementSubscriptionUsage(subscriptionCheck.subscription_id, sent, 0);
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

// ==================== WALLET TOPUP ENDPOINTS ====================

// Create wallet topup request
app.post('/api/wallet/topup', async (req, res) => {
  try {
    const { userId, amount, paymentMethod, paymentReference } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }

    if (amount < 1000) {
      return res.status(400).json({ error: 'Minimum topup amount is 1,000 IQD' });
    }

    // Calculate bonus using the database function
    const { data: bonusResult, error: bonusError } = await supabase
      .rpc('calculate_topup_bonus', { amount });

    if (bonusError) {
      throw bonusError;
    }

    const bonusAmount = bonusResult || 0;
    const totalCredited = amount + bonusAmount;

    // Create topup record
    const { data: topup, error: topupError } = await supabase
      .from('wallet_topups')
      .insert({
        user_id: userId,
        amount_iqd: amount,
        bonus_amount_iqd: bonusAmount,
        total_credited_iqd: totalCredited,
        payment_method: paymentMethod || 'manual',
        payment_reference: paymentReference,
        status: 'pending'
      })
      .select()
      .single();

    if (topupError) {
      throw topupError;
    }

    res.json({
      success: true,
      topup: {
        id: topup.id,
        amount: amount,
        bonus: bonusAmount,
        total: totalCredited,
        status: topup.status
      }
    });
  } catch (error) {
    console.error('❌ Error creating topup:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete wallet topup (admin/confirmation endpoint)
app.post('/api/wallet/topup/:topupId/complete', async (req, res) => {
  try {
    const { topupId } = req.params;

    // Get topup
    const { data: topup, error: topupError } = await supabase
      .from('wallet_topups')
      .select('*')
      .eq('id', topupId)
      .single();

    if (topupError || !topup) {
      return res.status(404).json({ error: 'Topup not found' });
    }

    if (topup.status !== 'pending') {
      return res.status(400).json({ error: `Topup is already ${topup.status}` });
    }

    // Get current balance
    const { data: userProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', topup.user_id)
      .single();

    if (profileError) {
      throw profileError;
    }

    const currentBalance = userProfile?.wallet_balance || 0;
    const newBalance = currentBalance + topup.total_credited_iqd;

    // Update wallet balance
    const { error: balanceError } = await supabase
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', topup.user_id);

    if (balanceError) {
      throw balanceError;
    }

    // Create wallet transaction
    await supabase.from('wallet_transactions').insert({
      user_id: topup.user_id,
      transaction_type: 'credit',
      amount: topup.total_credited_iqd,
      balance_before: currentBalance,
      balance_after: newBalance,
      description: `Topup: ${topup.amount_iqd} IQD + ${topup.bonus_amount_iqd} IQD bonus`,
      reference_id: `topup_${topup.id}`
    });

    // Update topup status
    const { error: updateError } = await supabase
      .from('wallet_topups')
      .update({
        status: 'completed',
        processed_at: new Date().toISOString()
      })
      .eq('id', topupId);

    if (updateError) {
      throw updateError;
    }

    res.json({
      success: true,
      balance: newBalance,
      credited: topup.total_credited_iqd
    });
  } catch (error) {
    console.error('❌ Error completing topup:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get topup history
app.get('/api/wallet/topups/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: topups, error } = await supabase
      .from('wallet_topups')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw error;
    }

    res.json({ success: true, topups });
  } catch (error) {
    console.error('❌ Error fetching topups:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUBSCRIPTION ENDPOINTS ====================

// Get subscription tiers
app.get('/api/subscriptions/tiers', async (req, res) => {
  try {
    const { data: tiers, error } = await supabase
      .from('subscription_tiers')
      .select('*')
      .eq('is_active', true)
      .order('price_iqd', { ascending: true });

    if (error) {
      throw error;
    }

    res.json({ success: true, tiers });
  } catch (error) {
    console.error('❌ Error fetching subscription tiers:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user's active subscription
app.get('/api/subscriptions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: subscription, error } = await supabase
      .from('user_subscriptions')
      .select(`
        *,
        subscription_tiers (*)
      `)
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      throw error;
    }

    res.json({ success: true, subscription: subscription || null });
  } catch (error) {
    console.error('❌ Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create subscription
app.post('/api/subscriptions', async (req, res) => {
  try {
    const { userId, tierKey } = req.body;

    if (!userId || !tierKey) {
      return res.status(400).json({ error: 'userId and tierKey are required' });
    }

    // Get tier details
    const { data: tier, error: tierError } = await supabase
      .from('subscription_tiers')
      .select('*')
      .eq('tier_key', tierKey)
      .eq('is_active', true)
      .single();

    if (tierError || !tier) {
      return res.status(404).json({ error: 'Subscription tier not found' });
    }

    // Check wallet balance
    const { data: userProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .single();

    if (profileError) {
      throw profileError;
    }

    const currentBalance = userProfile?.wallet_balance || 0;
    if (currentBalance < tier.price_iqd) {
      return res.status(400).json({ 
        error: 'Insufficient balance',
        required: tier.price_iqd,
        current: currentBalance
      });
    }

    // Deduct from wallet
    const newBalance = currentBalance - tier.price_iqd;
    const { error: balanceError } = await supabase
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', userId);

    if (balanceError) {
      throw balanceError;
    }

    // Create wallet transaction
    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      transaction_type: 'debit',
      amount: tier.price_iqd,
      balance_before: currentBalance,
      balance_after: newBalance,
      description: `Subscription: ${tier.tier_name}`,
      reference_id: `subscription_${Date.now()}`
    });

    // Calculate expiration (premium never expires, others are 30 days)
    const expiresAt = tier.messages_limit === null ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Create subscription
    const { data: subscription, error: subError } = await supabase
      .from('user_subscriptions')
      .insert({
        user_id: userId,
        tier_key: tierKey,
        status: 'active',
        expires_at: expiresAt,
        messages_used: 0,
        numbers_used: 0
      })
      .select()
      .single();

    if (subError) {
      throw subError;
    }

    res.json({
      success: true,
      subscription,
      newBalance
    });
  } catch (error) {
    console.error('❌ Error creating subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SETTINGS ENDPOINTS ====================

// Get user settings
app.get('/api/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: settings, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // Return default settings if none exist
    if (!settings) {
      res.json({
        success: true,
        settings: {
          rate_limit_per_minute: 10,
          rate_limit_per_hour: 100,
          rate_limit_per_day: 1000,
          auto_retry_failed_messages: true,
          max_retry_attempts: 3,
          webhook_timeout_seconds: 30,
          enable_message_logging: true,
          notification_preferences: { email: true, webhook: true },
          custom_settings: {}
        }
      });
      return;
    }

    res.json({ success: true, settings });
  } catch (error) {
    console.error('❌ Error fetching settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update user settings
app.put('/api/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;

    // Check if settings exist
    const { data: existing, error: checkError } = await supabase
      .from('user_settings')
      .select('id')
      .eq('user_id', userId)
      .single();

    let result;
    if (checkError && checkError.code === 'PGRST116') {
      // Create new settings
      result = await supabase
        .from('user_settings')
        .insert({
          user_id: userId,
          ...updates
        })
        .select()
        .single();
    } else {
      // Update existing settings
      result = await supabase
        .from('user_settings')
        .update(updates)
        .eq('user_id', userId)
        .select()
        .single();
    }

    if (result.error) {
      throw result.error;
    }

    res.json({ success: true, settings: result.data });
  } catch (error) {
    console.error('❌ Error updating settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update user profile (for registration and profile updates)
app.post('/api/users/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { legalName, address, phoneNumber } = req.body;

    const updates = {};
    if (legalName !== undefined) updates.legal_name = legalName;
    if (address !== undefined) updates.address = address;
    if (phoneNumber !== undefined) updates.phone_number = phoneNumber;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert({
        id: userId,
        ...updates
      }, { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ success: true, profile: data });
  } catch (error) {
    console.error('❌ Error updating user profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUBSCRIPTION & RATE LIMITING HELPERS ====================

// Check subscription limits
async function checkSubscriptionLimits(userId, messagesNeeded = 1, numbersNeeded = 0) {
  try {
    const { data, error } = await supabase.rpc('check_subscription_limits', {
      p_user_id: userId,
      p_messages_needed: messagesNeeded,
      p_numbers_needed: numbersNeeded
    });

    if (error) {
      console.error('Error checking subscription limits:', error);
      // If function doesn't exist or error, allow (fallback)
      return { allowed: true };
    }

    return data || { allowed: true };
  } catch (error) {
    console.error('Error in checkSubscriptionLimits:', error);
    return { allowed: true }; // Fallback: allow if check fails
  }
}

// Increment subscription usage
async function incrementSubscriptionUsage(subscriptionId, messages = 1, numbers = 0) {
  try {
    await supabase.rpc('increment_subscription_usage', {
      p_subscription_id: subscriptionId,
      p_messages: messages,
      p_numbers: numbers
    });
  } catch (error) {
    console.error('Error incrementing subscription usage:', error);
    // Non-blocking error
  }
}

// Check rate limits
async function checkRateLimit(userId, messageCount = 1) {
  try {
    const { data: settings, error } = await supabase
      .from('user_settings')
      .select('rate_limit_per_minute, rate_limit_per_hour, rate_limit_per_day')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching rate limit settings:', error);
      return { allowed: true }; // Fallback: allow if check fails
    }

    // If no settings, use defaults
    const limits = settings || {
      rate_limit_per_minute: 10,
      rate_limit_per_hour: 100,
      rate_limit_per_day: 1000
    };

    // Check messages sent in last minute
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { count: minuteCount } = await supabase
      .from('automation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', oneMinuteAgo);

    if (minuteCount + messageCount > limits.rate_limit_per_minute) {
      return {
        allowed: false,
        reason: 'rate_limit_minute',
        limit: limits.rate_limit_per_minute,
        current: minuteCount
      };
    }

    // Check messages sent in last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: hourCount } = await supabase
      .from('automation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', oneHourAgo);

    if (hourCount + messageCount > limits.rate_limit_per_hour) {
      return {
        allowed: false,
        reason: 'rate_limit_hour',
        limit: limits.rate_limit_per_hour,
        current: hourCount
      };
    }

    // Check messages sent in last day
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: dayCount } = await supabase
      .from('automation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', oneDayAgo);

    if (dayCount + messageCount > limits.rate_limit_per_day) {
      return {
        allowed: false,
        reason: 'rate_limit_day',
        limit: limits.rate_limit_per_day,
        current: dayCount
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Error in checkRateLimit:', error);
    return { allowed: true }; // Fallback: allow if check fails
  }
}

// Get active subscription for user
async function getActiveSubscription(userId) {
  try {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('id, tier_key, messages_used, numbers_used')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching subscription:', error);
    }

    return data || null;
  } catch (error) {
    console.error('Error in getActiveSubscription:', error);
    return null;
  }
}

// ==================== WEBHOOK HELPERS ====================

// Setup incoming message handlers for a client
function setupIncomingMessageHandlers(client, userId, sessionId) {
  // Handle incoming messages
  client.on('message', async (message) => {
    try {
      // Skip messages from status broadcasts
      if (message.from === 'status@broadcast') {
        return;
      }

      // Get message details
      const from = message.from;
      const body = message.body || '';
      const hasMedia = message.hasMedia;
      const type = message.type;
      const timestamp = message.timestamp * 1000; // Convert to milliseconds
      
      // Determine message type and payload
      let messageType = 'text';
      let payload = {
        success: true,
        event: 'message_received',
        from: from.replace('@c.us', ''),
        timestamp: new Date(timestamp).toISOString(),
        messageType: type,
        hasMedia: hasMedia
      };

      // Handle different message types
      if (type === 'location') {
        messageType = 'location';
        const location = message.location;
        payload.location = {
          latitude: location.latitude,
          longitude: location.longitude,
          name: location.name || null,
          address: location.address || null
        };
      } else if (type === 'image' || type === 'video' || type === 'audio' || type === 'document') {
        messageType = 'media';
        payload.mediaType = type;
        if (hasMedia) {
          try {
            const media = await message.downloadMedia();
            payload.media = {
              mimetype: media.mimetype,
              data: media.data.substring(0, 100) + '...' // Truncate for webhook payload
            };
          } catch (e) {
            console.error('Error downloading media:', e);
          }
        }
      } else if (type === 'sticker') {
        messageType = 'sticker';
      } else if (type === 'voice') {
        messageType = 'voice';
      } else {
        // Text message
        messageType = 'text';
        payload.text = body;
      }

      // Trigger webhooks for incoming messages
      await triggerWebhooks(userId, sessionId, `incoming_${messageType}`, payload);
      
      // Also trigger generic incoming message webhook
      await triggerWebhooks(userId, sessionId, 'incoming_message', {
        ...payload,
        messageType: messageType
      });

    } catch (error) {
      console.error('Error handling incoming message:', error);
    }
  });

  // Handle message acknowledgments (delivered, read)
  client.on('message_ack', async (msg, ack) => {
    try {
      if (ack === 3) { // Read
        await triggerWebhooks(userId, sessionId, 'message_read', {
          success: true,
          event: 'message_read',
          messageId: msg.id._serialized,
          from: msg.from.replace('@c.us', ''),
          timestamp: new Date().toISOString()
        });
      } else if (ack === 2) { // Delivered
        await triggerWebhooks(userId, sessionId, 'message_delivered', {
          success: true,
          event: 'message_delivered',
          messageId: msg.id._serialized,
          from: msg.from.replace('@c.us', ''),
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('Error handling message ack:', error);
    }
  });
}

// Trigger webhooks for a given event (async, fire and forget)
async function triggerWebhooks(userId, sessionId, eventType, payload) {
  try {
    // Get active webhooks for this user and session
    const { data: webhooks, error } = await supabase
      .from('webhooks')
      .select('*')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .eq('is_active', true)
      .in('webhook_type', [eventType, 'all']);

    if (error || !webhooks || webhooks.length === 0) {
      return; // No webhooks configured
    }

    // Trigger each webhook
    for (const webhook of webhooks) {
      // Determine which URL to use
      let webhookUrl = webhook.webhook_url;
      if (payload.success && webhook.success_webhook_url) {
        webhookUrl = webhook.success_webhook_url;
      } else if (!payload.success && webhook.failure_webhook_url) {
        webhookUrl = webhook.failure_webhook_url;
      }

      if (!webhookUrl) continue;

      // Merge custom payload with default payload
      const finalPayload = {
        ...payload,
        ...(webhook.custom_payload || {})
      };

      // Call webhook asynchronously (don't block)
      callWebhook(webhook.id, userId, sessionId, webhook, webhookUrl, payload, finalPayload)
        .catch(err => console.error(`Webhook ${webhook.id} call failed:`, err.message));
    }
  } catch (error) {
    console.error('Error triggering webhooks:', error);
  }
}

// Call a single webhook with retry logic
async function callWebhook(webhookId, userId, sessionId, webhookConfig, url, originalPayload, payload) {
  const maxRetries = webhookConfig.max_retries || 3;
  const retryDelay = (webhookConfig.retry_delay_seconds || 5) * 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const isRetry = attempt > 1;
      const result = await makeWebhookRequest(url, payload, webhookConfig.headers || {});

      // Log successful call
      await supabase.from('webhook_logs').insert({
        webhook_id: webhookId,
        user_id: userId,
        session_id: sessionId,
        event_type: originalPayload.event || 'unknown',
        payload: payload,
        response_status: result.status,
        response_body: result.body?.substring(0, 1000), // Limit response body
        success: true,
        attempt_number: attempt,
        is_retry: isRetry
      });

      // Update webhook stats
      await supabase.rpc('update_webhook_stats', {
        p_webhook_id: webhookId,
        p_success: true
      });

      return result; // Success, exit retry loop
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;

      // Log failed call
      await supabase.from('webhook_logs').insert({
        webhook_id: webhookId,
        user_id: userId,
        session_id: sessionId,
        event_type: originalPayload.event || 'unknown',
        payload: payload,
        response_status: error.status || null,
        response_body: error.message?.substring(0, 1000),
        success: false,
        error_message: error.message,
        attempt_number: attempt,
        is_retry: attempt > 1
      });

      if (isLastAttempt) {
        // Update webhook stats for final failure
        await supabase.rpc('update_webhook_stats', {
          p_webhook_id: webhookId,
          p_success: false
        });
        throw error;
      }

      // Wait before retry
      if (webhookConfig.retry_on_failure !== false) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
}

// Make HTTP/HTTPS request to webhook URL
function makeWebhookRequest(url, payload, headers) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const defaultHeaders = {
        'Content-Type': 'application/json',
        'User-Agent': 'Wassapi-Webhook/1.0'
      };

      const finalHeaders = {
        ...defaultHeaders,
        ...headers
      };

      const postData = JSON.stringify(payload);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          ...finalHeaders,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000 // 10 second timeout
      };

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body });
          } else {
            reject(new Error(`Webhook returned status ${res.statusCode}: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Webhook request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook request timeout'));
      });

      req.write(postData);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ==================== WEBHOOK ENDPOINTS ====================

// Get webhooks for user/session
app.get('/api/webhooks/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const sessionId = req.query.sessionId;

    let query = supabase
      .from('webhooks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    }

    const { data: webhooks, error } = await query;

    if (error) {
      throw error;
    }

    res.json({ success: true, webhooks: webhooks || [] });
  } catch (error) {
    console.error('❌ Error fetching webhooks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get webhook by ID
app.get('/api/webhooks/:userId/:webhookId', async (req, res) => {
  try {
    const { userId, webhookId } = req.params;

    const { data: webhook, error } = await supabase
      .from('webhooks')
      .select('*')
      .eq('id', webhookId)
      .eq('user_id', userId)
      .single();

    if (error) {
      throw error;
    }

    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json({ success: true, webhook });
  } catch (error) {
    console.error('❌ Error fetching webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create webhook
app.post('/api/webhooks/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { sessionId, webhookUrl, webhookType, customPayload, successWebhookUrl, failureWebhookUrl, headers, retryOnFailure, maxRetries, retryDelaySeconds } = req.body;

    if (!sessionId || !webhookUrl || !webhookType) {
      return res.status(400).json({ error: 'sessionId, webhookUrl, and webhookType are required' });
    }

    // Validate webhook URL
    try {
      new URL(webhookUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid webhook URL format' });
    }

    // Verify session belongs to user
    const { data: session } = await supabase
      .from('whatsapp_sessions')
      .select('session_id')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { data: webhook, error } = await supabase
      .from('webhooks')
      .insert({
        user_id: userId,
        session_id: sessionId,
        webhook_url: webhookUrl,
        webhook_type: webhookType,
        custom_payload: customPayload || {},
        success_webhook_url: successWebhookUrl || null,
        failure_webhook_url: failureWebhookUrl || null,
        headers: headers || { 'Content-Type': 'application/json' },
        retry_on_failure: retryOnFailure !== undefined ? retryOnFailure : true,
        max_retries: maxRetries || 3,
        retry_delay_seconds: retryDelaySeconds || 5
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        return res.status(409).json({ error: 'Webhook already exists for this session and type' });
      }
      throw error;
    }

    res.json({ success: true, webhook });
  } catch (error) {
    console.error('❌ Error creating webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update webhook
app.put('/api/webhooks/:userId/:webhookId', async (req, res) => {
  try {
    const { userId, webhookId } = req.params;
    const { webhookUrl, webhookType, customPayload, successWebhookUrl, failureWebhookUrl, headers, isActive, retryOnFailure, maxRetries, retryDelaySeconds } = req.body;

    // Verify webhook belongs to user
    const { data: existingWebhook } = await supabase
      .from('webhooks')
      .select('id')
      .eq('id', webhookId)
      .eq('user_id', userId)
      .single();

    if (!existingWebhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const updateData = {};
    if (webhookUrl !== undefined) {
      try {
        new URL(webhookUrl);
        updateData.webhook_url = webhookUrl;
      } catch {
        return res.status(400).json({ error: 'Invalid webhook URL format' });
      }
    }
    if (webhookType !== undefined) updateData.webhook_type = webhookType;
    if (customPayload !== undefined) updateData.custom_payload = customPayload;
    if (successWebhookUrl !== undefined) updateData.success_webhook_url = successWebhookUrl || null;
    if (failureWebhookUrl !== undefined) updateData.failure_webhook_url = failureWebhookUrl || null;
    if (headers !== undefined) updateData.headers = headers;
    if (isActive !== undefined) updateData.is_active = isActive;
    if (retryOnFailure !== undefined) updateData.retry_on_failure = retryOnFailure;
    if (maxRetries !== undefined) updateData.max_retries = maxRetries;
    if (retryDelaySeconds !== undefined) updateData.retry_delay_seconds = retryDelaySeconds;
    updateData.updated_at = new Date().toISOString();

    const { data: webhook, error } = await supabase
      .from('webhooks')
      .update(updateData)
      .eq('id', webhookId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ success: true, webhook });
  } catch (error) {
    console.error('❌ Error updating webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete webhook
app.delete('/api/webhooks/:userId/:webhookId', async (req, res) => {
  try {
    const { userId, webhookId } = req.params;

    const { error } = await supabase
      .from('webhooks')
      .delete()
      .eq('id', webhookId)
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    res.json({ success: true, message: 'Webhook deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get webhook logs
app.get('/api/webhooks/:userId/:webhookId/logs', async (req, res) => {
  try {
    const { userId, webhookId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    // Verify webhook belongs to user
    const { data: webhook } = await supabase
      .from('webhooks')
      .select('id')
      .eq('id', webhookId)
      .eq('user_id', userId)
      .single();

    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const { data: logs, error } = await supabase
      .from('webhook_logs')
      .select('*')
      .eq('webhook_id', webhookId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    res.json({ success: true, logs: logs || [] });
  } catch (error) {
    console.error('❌ Error fetching webhook logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test webhook (sends a test payload)
app.post('/api/webhooks/:userId/:webhookId/test', async (req, res) => {
  try {
    const { userId, webhookId } = req.params;

    const { data: webhook, error: fetchError } = await supabase
      .from('webhooks')
      .select('*')
      .eq('id', webhookId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const testPayload = {
      success: true,
      event: 'webhook_test',
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook from Wassapi',
      ...(webhook.custom_payload || {})
    };

    try {
      await callWebhook(webhookId, userId, webhook.session_id, webhook, webhook.webhook_url, testPayload, testPayload);
      res.json({ success: true, message: 'Test webhook sent successfully' });
    } catch (error) {
      res.status(500).json({ error: `Webhook test failed: ${error.message}` });
    }
  } catch (error) {
    console.error('❌ Error testing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACCOUNT STRENGTH ENDPOINTS ====================

// Get account strength metrics for a session
app.get('/api/account-strength/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;

    // Get WhatsApp client to collect real-time metrics
    const client = clients.get(sessionId);
    let realTimeMetrics = {};
    
    if (client && isClientReady(client)) {
      try {
        // Collect real-time profile data
        const info = client.info;
        const state = await client.getState();
        
        // Check profile picture
        try {
          const profilePic = await client.getProfilePicUrl(info.wid._serialized);
          realTimeMetrics.profile_picture_exists = !!profilePic;
        } catch (e) {
          realTimeMetrics.profile_picture_exists = false;
        }
        
        // Get profile name length
        realTimeMetrics.profile_name_length = (info.pushname || '').length;
        realTimeMetrics.profile_complete = !!(info.pushname && info.pushname.length > 0);
        
        // Get chats count
        const chats = await client.getChats();
        realTimeMetrics.total_chats_count = chats.length;
        
        // Count active chats (with messages in last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        let activeChats = 0;
        for (const chat of chats.slice(0, 50)) { // Limit to first 50 for performance
          try {
            const messages = await chat.fetchMessages({ limit: 1 });
            if (messages.length > 0 && messages[0].timestamp * 1000 > sevenDaysAgo.getTime()) {
              activeChats++;
            }
          } catch (e) {
            // Skip if can't fetch
          }
        }
        realTimeMetrics.active_chats_count = activeChats;
        
        // Log connection event if connected
        if (state === 'CONNECTED') {
          try {
            await supabase.from('connection_events').insert({
              session_id: sessionId,
              user_id: userId,
              event_type: 'connected',
              event_details: { state, timestamp: new Date().toISOString() }
            });
          } catch (e) {
            // Ignore errors if table doesn't exist yet
          }
        }
        
        // Track activity pattern (current hour)
        const now = new Date();
        const currentHour = now.getHours();
        const today = now.toISOString().split('T')[0];
        
        try {
          await supabase.from('activity_patterns').upsert({
            session_id: sessionId,
            user_id: userId,
            activity_date: today,
            hour_of_day: currentHour,
            message_count: 1
          }, {
            onConflict: 'session_id,activity_date,hour_of_day',
            ignoreDuplicates: false
          });
        } catch (e) {
          // Ignore errors if table doesn't exist yet
        }
        
      } catch (realTimeError) {
        console.log('⚠️ Error collecting real-time metrics:', realTimeError.message);
      }
    }

    // First, try to use improved function, fallback to original
    let updateError = null;
    try {
      const { error } = await supabase.rpc('update_account_strength_metrics_improved', {
        p_session_id: sessionId
      });
      updateError = error;
    } catch (e) {
      // If improved function doesn't exist, try original
      const { error } = await supabase.rpc('update_account_strength_metrics', {
        p_session_id: sessionId
      });
      updateError = error;
    }

    if (updateError) {
      console.warn('⚠️ Could not update metrics:', updateError);
      // Continue anyway - try to get existing metrics
    }
    
    // Update real-time metrics if we collected them
    if (Object.keys(realTimeMetrics).length > 0) {
      try {
        await supabase
          .from('account_strength_metrics')
          .update(realTimeMetrics)
          .eq('session_id', sessionId);
      } catch (e) {
        // Ignore errors if table doesn't exist yet
      }
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

    // Perform comprehensive strengthening activities sequentially
    try {
      const serviceTypes = ['profile_update', 'message_simulation', 'contact_sync', 'status_update', 'idle_period'];
      let activityDetails = {
        totalSteps: serviceTypes.length,
        completedSteps: 0,
        steps: []
      };
      
      for (const serviceType of serviceTypes) {
        try {
          let stepDetails = { type: serviceType, status: 'completed' };
          
          switch (serviceType) {
            case 'profile_update':
              // Get profile picture and info (simulates profile activity)
              try {
                const profilePic = await client.getProfilePicUrl(client.info.wid._serialized);
                const info = client.info;
                stepDetails.details = {
                  profilePicFetched: !!profilePic,
                  profileName: info.pushname || '',
                  timestamp: new Date().toISOString()
                };
                // Also update "last seen" by checking state
                await client.getState();
              } catch (err) {
                console.log('Profile update activity:', err.message);
                stepDetails.status = 'failed';
                stepDetails.error = err.message;
              }
              break;
              
            case 'message_simulation':
              // Get chats and actually read multiple messages to simulate real activity
              try {
                const chats = await client.getChats();
                stepDetails.details = { chatsFound: chats.length };
                
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
                  
                  stepDetails.details.chatsRead = chatsToRead.length;
                  stepDetails.details.messagesRead = chatsToRead.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
                }
              } catch (err) {
                console.log('Message simulation activity:', err.message);
                stepDetails.status = 'failed';
                stepDetails.error = err.message;
              }
              break;
              
            case 'contact_sync':
              // Get and cache contacts (simulates contact sync activity)
              try {
                const contacts = await client.getContacts();
                stepDetails.details = { contactsCount: contacts.length };
                
                // Also get block list to show account is active
                try {
                  const blockedContacts = await client.getBlockedContacts();
                  stepDetails.details.blockedCount = blockedContacts.length;
                } catch (err) {
                  // Blocked contacts might not be available
                }
              } catch (err) {
                console.log('Contact sync activity:', err.message);
                stepDetails.status = 'failed';
                stepDetails.error = err.message;
              }
              break;
              
            case 'status_update':
              // Check connection state and get account info (shows active presence)
              try {
                const state = await client.getState();
                const accountInfo = client.info;
                
                stepDetails.details = {
                  state: state,
                  accountActive: state === 'CONNECTED',
                  pushName: accountInfo.pushname || ''
                };
                
                // Also fetch chats count to show activity
                const allChats = await client.getChats();
                stepDetails.details.totalChats = allChats.length;
              } catch (err) {
                console.log('Status update activity:', err.message);
                stepDetails.status = 'failed';
                stepDetails.error = err.message;
              }
              break;
              
            case 'idle_period':
              // Simulate idle by doing minimal activity after delay
              try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                // Check state to show we're still connected
                const idleState = await client.getState();
                stepDetails.details = {
                  idlePeriodSeconds: 2,
                  stateDuringIdle: idleState
                };
              } catch (err) {
                console.log('Idle period activity:', err.message);
                stepDetails.status = 'failed';
                stepDetails.error = err.message;
              }
              break;
          }
          
          activityDetails.steps.push(stepDetails);
          if (stepDetails.status === 'completed') {
            activityDetails.completedSteps++;
          }
        } catch (stepError) {
          console.log(`Error in ${serviceType}:`, stepError.message);
          activityDetails.steps.push({
            type: serviceType,
            status: 'failed',
            error: stepError.message
          });
        }
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
