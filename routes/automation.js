const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getDatabase } = require('../database/db');
const { sendMessage, getClient } = require('../services/whatsapp-manager');

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Send OTP
router.post('/otp/send', async (req, res) => {
  try {
    const { sessionId, recipient, otp } = req.body;
    const userId = req.user.userId;

    if (!sessionId || !recipient || !otp) {
      return res.status(400).json({ error: 'sessionId, recipient, and otp are required' });
    }

    // Verify session ownership
    const db = getDatabase();
    db.get(
      'SELECT * FROM whatsapp_sessions WHERE session_id = ? AND user_id = ? AND status = ?',
      [sessionId, userId, 'connected'],
      async (err, session) => {
        if (err || !session) {
          return res.status(404).json({ error: 'Session not found or not connected' });
        }

        const message = `Your OTP code is: ${otp}\n\nThis code will expire in 10 minutes. Do not share this code with anyone.`;

        try {
          const result = await sendMessage(sessionId, userId, recipient, message);
          res.json({
            success: true,
            message: 'OTP sent successfully',
            messageId: result.messageId
          });
        } catch (error) {
          res.status(500).json({ error: 'Failed to send OTP', details: error.message });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Send announcement
router.post('/announcement/send', async (req, res) => {
  try {
    const { sessionId, recipients, message } = req.body;
    const userId = req.user.userId;

    if (!sessionId || !recipients || !Array.isArray(recipients) || !message) {
      return res.status(400).json({ error: 'sessionId, recipients array, and message are required' });
    }

    // Verify session ownership
    const db = getDatabase();
    db.get(
      'SELECT * FROM whatsapp_sessions WHERE session_id = ? AND user_id = ? AND status = ?',
      [sessionId, userId, 'connected'],
      async (err, session) => {
        if (err || !session) {
          return res.status(404).json({ error: 'Session not found or not connected' });
        }

        const results = [];
        const errors = [];

        // Send messages with delay to avoid rate limiting
        for (let i = 0; i < recipients.length; i++) {
          try {
            // Add delay between messages (2-5 seconds)
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
            }

            const result = await sendMessage(sessionId, userId, recipients[i], message);
            results.push({ recipient: recipients[i], success: true, messageId: result.messageId });
          } catch (error) {
            errors.push({ recipient: recipients[i], error: error.message });
          }
        }

        res.json({
          success: true,
          sent: results.length,
          failed: errors.length,
          results,
          errors: errors.length > 0 ? errors : undefined
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create message template
router.post('/templates', (req, res) => {
  try {
    const { sessionId, name, template, type } = req.body;
    const userId = req.user.userId;

    if (!sessionId || !name || !template) {
      return res.status(400).json({ error: 'sessionId, name, and template are required' });
    }

    const db = getDatabase();
    
    // Get session ID from database
    db.get(
      'SELECT id FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
      [sessionId, userId],
      (err, session) => {
        if (err || !session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        db.run(
          'INSERT INTO message_templates (user_id, session_id, name, template, type) VALUES (?, ?, ?, ?, ?)',
          [userId, session.id, name, template, type || 'announcement'],
          function(err) {
            if (err) {
              return res.status(500).json({ error: 'Failed to create template' });
            }
            res.status(201).json({
              success: true,
              templateId: this.lastID,
              message: 'Template created successfully'
            });
          }
        );
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get message templates
router.get('/templates/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.userId;
  const db = getDatabase();

  db.get(
    'SELECT id FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
    [sessionId, userId],
    (err, session) => {
      if (err || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      db.all(
        'SELECT * FROM message_templates WHERE session_id = ? ORDER BY created_at DESC',
        [session.id],
        (err, templates) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to fetch templates' });
          }
          res.json({ templates });
        }
      );
    }
  );
});

// Get sent messages history
router.get('/messages/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.userId;
  const db = getDatabase();

  db.get(
    'SELECT id FROM whatsapp_sessions WHERE session_id = ? AND user_id = ?',
    [sessionId, userId],
    (err, session) => {
      if (err || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const limit = parseInt(req.query.limit) || 50;
      db.all(
        'SELECT * FROM sent_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
        [session.id, limit],
        (err, messages) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to fetch messages' });
          }
          res.json({ messages });
        }
      );
    }
  );
});

module.exports = router;

