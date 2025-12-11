const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { getDatabase } = require('../database/db');
const { scheduleActivity } = require('./account-strengthener');

const clients = new Map();

function createWhatsAppClient(sessionId, userId) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    client.on('qr', (qr) => {
      console.log(`QR Code for session ${sessionId}:`);
      qrcode.generate(qr, { small: true });
      
      // Save QR code to database
      const db = getDatabase();
      db.run(
        'UPDATE whatsapp_sessions SET qr_code = ?, status = ? WHERE session_id = ?',
        [qr, 'qr_pending', sessionId]
      );
    });

    client.on('ready', async () => {
      console.log(`WhatsApp client ready for session ${sessionId}`);
      const info = client.info;
      
      const db = getDatabase();
      db.run(
        'UPDATE whatsapp_sessions SET status = ?, phone_number = ?, qr_code = NULL WHERE session_id = ?',
        ['connected', info.wid.user, sessionId]
      );

      // Start account strengthening activities
      scheduleActivity(sessionId, client);
      
      resolve(client);
    });

    client.on('authenticated', () => {
      console.log(`Session ${sessionId} authenticated`);
    });

    client.on('auth_failure', (msg) => {
      console.error(`Authentication failure for session ${sessionId}:`, msg);
      const db = getDatabase();
      db.run(
        'UPDATE whatsapp_sessions SET status = ? WHERE session_id = ?',
        ['auth_failed', sessionId]
      );
      reject(new Error('Authentication failed'));
    });

    client.on('disconnected', (reason) => {
      console.log(`Session ${sessionId} disconnected:`, reason);
      const db = getDatabase();
      db.run(
        'UPDATE whatsapp_sessions SET status = ? WHERE session_id = ?',
        ['disconnected', sessionId]
      );
      clients.delete(sessionId);
    });

    client.initialize().catch(reject);
  });
}

async function getClient(sessionId, userId) {
  if (clients.has(sessionId)) {
    return clients.get(sessionId);
  }

  const client = await createWhatsAppClient(sessionId, userId);
  clients.set(sessionId, client);
  return client;
}

async function sendMessage(sessionId, userId, recipient, message) {
  const db = getDatabase();
  
  // Get database session ID
  const getSessionDbId = () => {
    return new Promise((resolve) => {
      db.get(
        'SELECT id FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
        [sessionId, userId],
        (err, session) => {
          resolve(session ? session.id : null);
        }
      );
    });
  };

  try {
    const client = await getClient(sessionId, userId);
    const chatId = recipient.includes('@c.us') ? recipient : `${recipient}@c.us`;
    
    const result = await client.sendMessage(chatId, message);
    
    // Log message
    const sessionDbId = await getSessionDbId();
    if (sessionDbId) {
      db.run(
        'INSERT INTO sent_messages (user_id, session_id, recipient, message, status, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, sessionDbId, recipient, message, 'sent', new Date().toISOString()]
      );
    }

    return { success: true, messageId: result.id._serialized };
  } catch (error) {
    console.error('Error sending message:', error);
    
    // Log failed message
    const sessionDbId = await getSessionDbId();
    if (sessionDbId) {
      db.run(
        'INSERT INTO sent_messages (user_id, session_id, recipient, message, status) VALUES (?, ?, ?, ?, ?)',
        [userId, sessionDbId, recipient, message, 'failed']
      );
    }

    throw error;
  }
}

async function disconnectClient(sessionId) {
  if (clients.has(sessionId)) {
    const client = clients.get(sessionId);
    await client.logout();
    await client.destroy();
    clients.delete(sessionId);
  }
}

module.exports = {
  createWhatsAppClient,
  getClient,
  sendMessage,
  disconnectClient,
  clients
};

