const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { getDatabase } = require('../database/db');
const { createWhatsAppClient, getClient, disconnectClient } = require('../services/whatsapp-manager');
const { getStrengtheningTips } = require('../services/account-strengthener');

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Create new WhatsApp session
router.post('/connect', async (req, res) => {
  try {
    const userId = req.user.userId;
    const sessionId = uuidv4();
    const db = getDatabase();

    // Create session record
    db.run(
      'INSERT INTO whatsapp_sessions (user_id, session_id, status) VALUES (?, ?, ?)',
      [userId, sessionId, 'initializing'],
      async function(err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to create session' });
        }

        try {
          // Initialize WhatsApp client
          await createWhatsAppClient(sessionId, userId);
          
          // Get QR code from database
          setTimeout(() => {
            db.get(
              'SELECT qr_code, status FROM whatsapp_sessions WHERE session_id = ?',
              [sessionId],
              (err, row) => {
                if (err) {
                  return res.status(500).json({ error: 'Failed to get QR code' });
                }
                res.json({
                  sessionId,
                  qrCode: row?.qr_code,
                  status: row?.status || 'initializing'
                });
              }
            );
          }, 2000);
        } catch (error) {
          res.status(500).json({ error: 'Failed to initialize WhatsApp client' });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get session status
router.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.userId;
  const db = getDatabase();

  db.get(
    'SELECT * FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
    [sessionId, userId],
    (err, session) => {
      if (err || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({ session });
    }
  );
});

// Get all user sessions
router.get('/sessions', (req, res) => {
  const userId = req.user.userId;
  const db = getDatabase();

  db.all(
    'SELECT * FROM whatsapp_sessions WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
    (err, sessions) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch sessions' });
      }
      res.json({ sessions });
    }
  );
});

// Disconnect session
router.post('/disconnect/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.userId;
    const db = getDatabase();

    // Verify ownership
    db.get(
      'SELECT * FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
      [sessionId, userId],
      async (err, session) => {
        if (err || !session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        try {
          await disconnectClient(sessionId);
          db.run(
            'UPDATE whatsapp_sessions SET status = ? WHERE session_id = ?',
            ['disconnected', sessionId]
          );
          res.json({ message: 'Session disconnected successfully' });
        } catch (error) {
          res.status(500).json({ error: 'Failed to disconnect session' });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get account strengthening tips
router.get('/strengthening-tips', (req, res) => {
  const tips = getStrengtheningTips();
  res.json({ tips });
});

// Get session activity logs
router.get('/session/:sessionId/activity', (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.userId;
  const db = getDatabase();

  // Verify ownership
  db.get(
    'SELECT * FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
    [sessionId, userId],
    (err, session) => {
      if (err || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      db.all(
        'SELECT * FROM activity_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 100',
        [sessionId],
        (err, logs) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to fetch activity logs' });
          }
          res.json({ logs });
        }
      );
    }
  );
});

module.exports = router;

