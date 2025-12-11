const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/whatsapp_shield.db');
const DB_DIR = path.dirname(DB_PATH);

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let db = null;

function getDatabase() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error opening database:', err);
      }
    });
  }
  return db;
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    const database = getDatabase();
    
    // Users table
    database.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // WhatsApp sessions table
    database.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_id TEXT UNIQUE NOT NULL,
        phone_number TEXT,
        status TEXT DEFAULT 'disconnected',
        qr_code TEXT,
        last_activity DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Message templates table
    database.run(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        template TEXT NOT NULL,
        type TEXT DEFAULT 'announcement',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id)
      )
    `);

    // Sent messages log
    database.run(`
      CREATE TABLE IF NOT EXISTS sent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        recipient TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'message',
        status TEXT DEFAULT 'pending',
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id)
      )
    `);

    // Activity logs for account strengthening
    database.run(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        activity_type TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id)
      )
    `);

    database.close((err) => {
      if (err) {
        reject(err);
      } else {
        db = null;
        console.log('✅ Database initialized successfully');
        resolve();
      }
    });
  });
}

module.exports = { getDatabase, initDatabase };

