const { getDatabase } = require('../database/db');

// Activity types to simulate human-like behavior
const ACTIVITY_TYPES = {
  PROFILE_UPDATE: 'profile_update',
  STATUS_CHECK: 'status_check',
  CONTACT_SYNC: 'contact_sync',
  IDLE_PERIOD: 'idle_period'
};

// Schedule random activities to make account look more human
function scheduleActivity(sessionId, client) {
  const db = getDatabase();
  
  // Random activity every 30-120 minutes
  const scheduleNext = () => {
    const delay = Math.random() * (120 - 30) * 60 * 1000 + 30 * 60 * 1000;
    
    setTimeout(async () => {
      try {
        // Random activity selection
        const activities = [
          async () => {
            // Update last seen
            await client.getState();
            logActivity(sessionId, ACTIVITY_TYPES.STATUS_CHECK, 'Status check performed');
          },
          async () => {
            // Simulate reading chats
            const chats = await client.getChats();
            if (chats.length > 0) {
              const randomChat = chats[Math.floor(Math.random() * chats.length)];
              await randomChat.fetchMessages({ limit: 1 });
              logActivity(sessionId, ACTIVITY_TYPES.STATUS_CHECK, 'Chat activity simulated');
            }
          }
        ];

        const randomActivity = activities[Math.floor(Math.random() * activities.length)];
        await randomActivity();

        // Update last activity in database
        db.run(
          'UPDATE whatsapp_sessions SET last_activity = ? WHERE session_id = ?',
          [new Date().toISOString(), sessionId]
        );

      } catch (error) {
        console.error(`Error in scheduled activity for ${sessionId}:`, error);
      }
      
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

function logActivity(sessionId, activityType, details) {
  const db = getDatabase();
  db.run(
    'INSERT INTO activity_logs (session_id, activity_type, details) VALUES (?, ?, ?)',
    [sessionId, activityType, details]
  );
}

// Account strengthening recommendations
function getStrengtheningTips() {
  return [
    {
      tip: 'Regular Activity',
      description: 'Keep your account active with regular logins and message exchanges',
      priority: 'high'
    },
    {
      tip: 'Profile Completeness',
      description: 'Complete your profile with a photo and status to appear more legitimate',
      priority: 'high'
    },
    {
      tip: 'Gradual Messaging',
      description: 'Start with low message volumes and gradually increase to avoid spam detection',
      priority: 'medium'
    },
    {
      tip: 'Two-Way Communication',
      description: 'Ensure recipients can reply to maintain conversation flow',
      priority: 'medium'
    },
    {
      tip: 'Avoid Mass Messaging',
      description: 'Space out messages and avoid sending identical messages to many recipients',
      priority: 'high'
    },
    {
      tip: 'Use Verified Numbers',
      description: 'Use phone numbers that can receive SMS for verification',
      priority: 'high'
    }
  ];
}

module.exports = {
  scheduleActivity,
  logActivity,
  getStrengtheningTips,
  ACTIVITY_TYPES
};

