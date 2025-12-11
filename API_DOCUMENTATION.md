# Wassapi API Documentation

Welcome to the Wassapi WhatsApp API documentation. This API allows you to send WhatsApp messages programmatically using API keys.

## Base URL

```
https://your-railway-url.railway.app/api/v1
```

## Authentication

All API requests require an API key in the request header. You can obtain your API key from the Wassapi dashboard after connecting your WhatsApp account.

### API Key Header

Include your API key in one of the following ways:

**Option 1: X-API-Key header (Recommended)**
```http
X-API-Key: wass_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Option 2: Authorization Bearer token**
```http
Authorization: Bearer wass_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Getting Your API Key

1. Log in to your Wassapi dashboard
2. Connect your WhatsApp account by scanning the QR code
3. Once connected, navigate to the API Keys section
4. Your API key will be automatically generated and displayed
5. Copy the API key and store it securely

**Important:** 
- Each connected phone number gets its own unique API key
- Never share your API key publicly
- If your API key is compromised, revoke it immediately and generate a new one

---

## Wallet & Pricing

- **Default Balance**: New accounts start with **1,000 IQD**
- **Message Cost**: Each WhatsApp message costs **10 IQD**
- **Balance Refunds**: If a message fails to send, your balance is automatically refunded
- **Currency**: All transactions are in Iraqi Dinar (IQD)

---

## API Endpoints

### 1. Get Wallet Balance

Get your current wallet balance.

**Endpoint:** `GET /api/v1/wallet/balance`

**Headers:**
```http
X-API-Key: your_api_key_here
```

**Response:**
```json
{
  "success": true,
  "balance": 950.00,
  "currency": "IQD"
}
```

---

### 2. Get Wallet Transactions

View your wallet transaction history.

**Endpoint:** `GET /api/v1/wallet/transactions`

**Headers:**
```http
X-API-Key: your_api_key_here
```

**Query Parameters:**
- `limit` (optional): Number of transactions to return (default: 50, max: 100)
- `offset` (optional): Number of transactions to skip (default: 0)

**Example:**
```http
GET /api/v1/wallet/transactions?limit=20&offset=0
```

**Response:**
```json
{
  "success": true,
  "transactions": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "session_id": "session_xxx",
      "transaction_type": "debit",
      "amount": 10.00,
      "balance_before": 1000.00,
      "balance_after": 990.00,
      "description": "Message sent to 9647812345678 via API",
      "reference_id": "api_1234567890",
      "created_at": "2025-12-11T12:00:00Z"
    }
  ],
  "count": 1
}
```

**Transaction Types:**
- `initial`: Initial wallet balance
- `debit`: Money deducted (message sent)
- `credit`: Money refunded (message failed)

---

### 3. Send Single Message

Send a WhatsApp message to a single recipient.

**Endpoint:** `POST /api/v1/messages/send`

**Headers:**
```http
X-API-Key: your_api_key_here
Content-Type: application/json
```

**Request Body:**
```json
{
  "recipient": "9647812345678",
  "message": "Hello! This is a test message from Wassapi."
}
```

**Parameters:**
- `recipient` (required): Phone number in international format (without + sign) or WhatsApp ID format (e.g., `9647812345678` or `9647812345678@c.us`)
- `message` (required): The message text to send

**Response (Success):**
```json
{
  "success": true,
  "message": "Message sent successfully",
  "balance": 990.00,
  "recipient": "9647812345678",
  "sentAt": "2025-12-11T12:00:00Z"
}
```

**Response (Insufficient Balance - 402):**
```json
{
  "error": "Insufficient balance",
  "currentBalance": 5.00,
  "required": 10.00
}
```

**Response (Session Disconnected - 400):**
```json
{
  "error": "WhatsApp session is disconnected. Please reconnect via the dashboard."
}
```

**cURL Example:**
```bash
curl -X POST https://your-railway-url.railway.app/api/v1/messages/send \
  -H "X-API-Key: wass_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "9647812345678",
    "message": "Hello from Wassapi!"
  }'
```

**JavaScript Example:**
```javascript
const response = await fetch('https://your-railway-url.railway.app/api/v1/messages/send', {
  method: 'POST',
  headers: {
    'X-API-Key': 'wass_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    recipient: '9647812345678',
    message: 'Hello from Wassapi!'
  })
});

const data = await response.json();
console.log(data);
```

**Python Example:**
```python
import requests

url = "https://your-railway-url.railway.app/api/v1/messages/send"
headers = {
    "X-API-Key": "wass_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "Content-Type": "application/json"
}
data = {
    "recipient": "9647812345678",
    "message": "Hello from Wassapi!"
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

---

### 4. Send Bulk Messages

Send a WhatsApp message to multiple recipients.

**Endpoint:** `POST /api/v1/messages/send-bulk`

**Headers:**
```http
X-API-Key: your_api_key_here
Content-Type: application/json
```

**Request Body:**
```json
{
  "recipients": [
    "9647812345678",
    "9647812345679",
    "9647812345680"
  ],
  "message": "Hello! This is a bulk message from Wassapi."
}
```

**Parameters:**
- `recipients` (required): Array of phone numbers in international format
- `message` (required): The message text to send to all recipients

**Response (Success):**
```json
{
  "success": true,
  "sent": 3,
  "failed": 0,
  "errors": [],
  "balance": 970.00,
  "totalCost": 30.00,
  "refunded": 0.00
}
```

**Response (Partial Success):**
```json
{
  "success": true,
  "sent": 2,
  "failed": 1,
  "errors": [
    {
      "recipient": "9647812345680",
      "error": "Invalid phone number"
    }
  ],
  "balance": 970.00,
  "totalCost": 20.00,
  "refunded": 10.00
}
```

**Response (Insufficient Balance - 402):**
```json
{
  "error": "Insufficient balance",
  "currentBalance": 15.00,
  "required": 30.00,
  "recipients": 3,
  "costPerMessage": 10.00
}
```

**cURL Example:**
```bash
curl -X POST https://your-railway-url.railway.app/api/v1/messages/send-bulk \
  -H "X-API-Key: wass_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": ["9647812345678", "9647812345679"],
    "message": "Bulk message from Wassapi!"
  }'
```

---

### 5. Get API Key Information

Get information about your API key.

**Endpoint:** `GET /api/v1/auth/info`

**Headers:**
```http
X-API-Key: your_api_key_here
```

**Response:**
```json
{
  "success": true,
  "apiKey": {
    "phoneNumber": "9647812345678",
    "sessionId": "session_xxx",
    "lastUsedAt": "2025-12-11T12:00:00Z",
    "usageCount": 42,
    "createdAt": "2025-12-01T10:00:00Z"
  }
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message description"
}
```

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (invalid parameters, session disconnected)
- `401` - Unauthorized (invalid or missing API key)
- `402` - Payment Required (insufficient balance)
- `404` - Not Found (session not found)
- `500` - Internal Server Error

### Common Errors

**Invalid API Key:**
```json
{
  "error": "Invalid API key"
}
```

**Missing API Key:**
```json
{
  "error": "API key is required"
}
```

**Invalid Request:**
```json
{
  "error": "recipient and message are required"
}
```

**Session Disconnected:**
```json
{
  "error": "WhatsApp session is disconnected. Please reconnect via the dashboard."
}
```

**Insufficient Balance:**
```json
{
  "error": "Insufficient balance",
  "currentBalance": 5.00,
  "required": 10.00
}
```

---

## Rate Limiting

- API requests are rate-limited to prevent abuse
- Current limit: 100 requests per 15 minutes per API key
- If you exceed the limit, you'll receive a `429 Too Many Requests` response

---

## Best Practices

1. **Store API Keys Securely**
   - Never commit API keys to version control
   - Use environment variables for API keys
   - Rotate API keys periodically

2. **Error Handling**
   - Always check response status codes
   - Handle insufficient balance errors gracefully
   - Implement retry logic for transient errors

3. **Balance Management**
   - Monitor your wallet balance regularly
   - Set up balance alerts in your application
   - Handle refunds automatically when messages fail

4. **Phone Number Format**
   - Always use international format (without +)
   - Example: `9647812345678` (Iraq)
   - Do not include spaces or special characters

5. **Message Content**
   - Keep messages concise and clear
   - Avoid spam content (may result in account restrictions)
   - Test messages before sending in bulk

---

## Integration Examples

### Node.js / Express

```javascript
const express = require('express');
const axios = require('axios');
const app = express();

const WASSAPI_BASE_URL = 'https://your-railway-url.railway.app/api/v1';
const API_KEY = process.env.WASSAPI_API_KEY;

async function sendWhatsAppMessage(recipient, message) {
  try {
    const response = await axios.post(
      `${WASSAPI_BASE_URL}/messages/send`,
      { recipient, message },
      {
        headers: {
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    throw error;
  }
}

// Usage
app.post('/send-message', async (req, res) => {
  try {
    const { recipient, message } = req.body;
    const result = await sendWhatsAppMessage(recipient, message);
    res.json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error || 'Failed to send message'
    });
  }
});
```

### Python / Flask

```python
import os
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

WASSAPI_BASE_URL = 'https://your-railway-url.railway.app/api/v1'
API_KEY = os.getenv('WASSAPI_API_KEY')

def send_whatsapp_message(recipient, message):
    url = f'{WASSAPI_BASE_URL}/messages/send'
    headers = {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
    }
    data = {
        'recipient': recipient,
        'message': message
    }
    
    response = requests.post(url, json=data, headers=headers)
    response.raise_for_status()
    return response.json()

@app.route('/send-message', methods=['POST'])
def send_message():
    try:
        data = request.json
        recipient = data.get('recipient')
        message = data.get('message')
        
        result = send_whatsapp_message(recipient, message)
        return jsonify(result)
    except requests.exceptions.HTTPError as e:
        return jsonify({'error': e.response.json()}), e.response.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

### PHP

```php
<?php
$apiKey = getenv('WASSAPI_API_KEY');
$baseUrl = 'https://your-railway-url.railway.app/api/v1';

function sendWhatsAppMessage($recipient, $message) {
    global $apiKey, $baseUrl;
    
    $url = $baseUrl . '/messages/send';
    $data = json_encode([
        'recipient' => $recipient,
        'message' => $message
    ]);
    
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'X-API-Key: ' . $apiKey,
        'Content-Type: application/json'
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return json_decode($response, true);
}

// Usage
$result = sendWhatsAppMessage('9647812345678', 'Hello from PHP!');
print_r($result);
?>
```

---

## Support

For support, please contact:
- Email: support@wassapi.com
- Documentation: https://docs.wassapi.com
- Dashboard: https://dashboard.wassapi.com

---

## Changelog

### Version 1.0.0 (2025-12-11)
- Initial API release
- Wallet balance system
- Single and bulk message sending
- API key authentication
- Transaction history

