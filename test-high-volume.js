#!/usr/bin/env node

/**
 * High Volume Message Testing Script (Node.js)
 * Tests sending multiple messages to check for rate limiting and potential bans
 * 
 * Usage:
 *   API_KEY=your_key RECIPIENT=9647812345678 MESSAGE_COUNT=50 node test-high-volume.js
 * 
 * Or set environment variables:
 *   export API_BASE_URL=https://watanishield.up.railway.app
 *   export API_KEY=wass_xxxxxxxxxxxxx
 *   export RECIPIENT=9647812345678
 *   export MESSAGE_COUNT=50
 *   export DELAY_BETWEEN_MESSAGES=2
 *   export BATCH_SIZE=10
 */

const https = require('https');
const http = require('http');

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'https://watanishield.up.railway.app';
const API_KEY = process.env.API_KEY || 'your_api_key_here';
const RECIPIENT = process.env.RECIPIENT || '9647812345678';
const MESSAGE_COUNT = parseInt(process.env.MESSAGE_COUNT || '50', 10);
const DELAY_BETWEEN_MESSAGES = parseInt(process.env.DELAY_BETWEEN_MESSAGES || '2', 10) * 1000; // Convert to ms
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);

// Statistics
let stats = {
    success: 0,
    failed: 0,
    rateLimited: 0,
    errors: 0,
    startTime: null,
    endTime: null
};

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// Function to make HTTP request
function sendMessage(messageNum) {
    return new Promise((resolve, reject) => {
        const messageText = `Test message #${messageNum} - ${new Date().toLocaleTimeString()}`;
        const url = new URL(`${API_BASE_URL}/api/v1/messages/send`);
        
        const postData = JSON.stringify({
            recipient: RECIPIENT,
            message: messageText
        });

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'X-API-Key': API_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const client = url.protocol === 'https:' ? https : http;
        
        const req = client.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const body = JSON.parse(data);
                    resolve({
                        statusCode: res.statusCode,
                        body: body
                    });
                } catch (e) {
                    resolve({
                        statusCode: res.statusCode,
                        body: { error: data }
                    });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

// Function to delay execution
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function
async function runTest() {
    log('=== High Volume Message Testing Script ===', 'yellow');
    log(`API URL: ${API_BASE_URL}`);
    log(`Recipient: ${RECIPIENT}`);
    log(`Total Messages: ${MESSAGE_COUNT}`);
    log(`Delay between messages: ${DELAY_BETWEEN_MESSAGES / 1000}s`);
    log(`Batch size: ${BATCH_SIZE}`);
    log('');

    if (API_KEY === 'your_api_key_here') {
        log('ERROR: Please set API_KEY environment variable', 'red');
        process.exit(1);
    }

    log('Starting message sending...\n', 'yellow');
    stats.startTime = Date.now();

    for (let i = 1; i <= MESSAGE_COUNT; i++) {
        process.stdout.write(`[${i}/${MESSAGE_COUNT}] `);
        
        try {
            const response = await sendMessage(i);
            
            switch (response.statusCode) {
                case 200:
                case 201:
                    log(`✓ Message #${i} sent successfully`, 'green');
                    stats.success++;
                    break;
                case 429:
                    log(`⚠ Message #${i} - Rate limit exceeded (HTTP ${response.statusCode})`, 'yellow');
                    stats.rateLimited++;
                    break;
                case 402:
                    log(`✗ Message #${i} - Insufficient balance (HTTP ${response.statusCode})`, 'red');
                    stats.failed++;
                    break;
                case 400:
                case 404:
                case 503:
                    log(`✗ Message #${i} - Error (HTTP ${response.statusCode}): ${response.body.error || 'Unknown error'}`, 'red');
                    stats.errors++;
                    break;
                default:
                    log(`✗ Message #${i} - Unexpected response (HTTP ${response.statusCode}): ${JSON.stringify(response.body)}`, 'red');
                    stats.errors++;
            }
        } catch (error) {
            log(`✗ Message #${i} - Network error: ${error.message}`, 'red');
            stats.errors++;
        }

        // Delay between messages
        if (i < MESSAGE_COUNT) {
            await delay(DELAY_BETWEEN_MESSAGES);
        }

        // Longer delay after each batch
        if (i % BATCH_SIZE === 0 && i < MESSAGE_COUNT) {
            log('--- Batch complete, waiting 10 seconds before next batch...', 'yellow');
            await delay(10000);
        }
    }

    stats.endTime = Date.now();
    const duration = (stats.endTime - stats.startTime) / 1000;
    const avgRate = (stats.success / duration * 60).toFixed(2);

    // Print summary
    log('\n=== Test Summary ===', 'yellow');
    log(`Total Messages: ${MESSAGE_COUNT}`);
    log(`Successful: ${stats.success}`, 'green');
    log(`Failed: ${stats.failed}`, 'red');
    log(`Rate Limited: ${stats.rateLimited}`, 'yellow');
    log(`Errors: ${stats.errors}`, 'red');
    log(`Total Duration: ${duration.toFixed(2)}s`);
    log(`Average Rate: ${avgRate} messages/minute`);

    // Recommendations
    log('\n=== Recommendations ===', 'yellow');
    if (stats.rateLimited > 0) {
        log('⚠ Rate limiting detected. Consider:', 'yellow');
        log('  - Increasing delay between messages');
        log('  - Reducing batch size');
        log('  - Checking your rate limit settings in the dashboard');
    }

    if (stats.success === MESSAGE_COUNT) {
        log('✓ All messages sent successfully!', 'green');
        log('  - Your current rate is safe');
        log('  - Consider gradually increasing volume for production');
    }

    if (stats.failed > 0 || stats.errors > 0) {
        log('✗ Some messages failed. Check:', 'red');
        log('  - Wallet balance');
        log('  - WhatsApp session status');
        log('  - API key validity');
    }
}

// Run the test
runTest().catch(error => {
    log(`Fatal error: ${error.message}`, 'red');
    process.exit(1);
});

