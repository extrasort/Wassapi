#!/usr/bin/env node

const http = require('http');

const BACKEND_URL = process.env.BACKEND_URL || 'https://watanishield.up.railway.app';
const ORIGIN = 'https://watanishield.netlify.app';

console.log('🧪 Testing CORS for Railway Backend...\n');
console.log(`Backend: ${BACKEND_URL}`);
console.log(`Origin: ${ORIGIN}\n`);

// Test OPTIONS preflight
function testOPTIONS() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BACKEND_URL}/api/whatsapp/connect`);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'OPTIONS',
      headers: {
        'Origin': ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type'
      }
    };

    const protocol = url.protocol === 'https:' ? require('https') : http;
    
    const req = protocol.request(options, (res) => {
      console.log(`\n📤 OPTIONS Request:`);
      console.log(`Status: ${res.statusCode}`);
      console.log(`Headers:`);
      console.log(`  Access-Control-Allow-Origin: ${res.headers['access-control-allow-origin'] || 'MISSING'}`);
      console.log(`  Access-Control-Allow-Methods: ${res.headers['access-control-allow-methods'] || 'MISSING'}`);
      console.log(`  Access-Control-Allow-Headers: ${res.headers['access-control-allow-headers'] || 'MISSING'}`);
      
      if (res.statusCode === 204 && res.headers['access-control-allow-origin']) {
        console.log('\n✅ CORS is working!');
        resolve(true);
      } else {
        console.log('\n❌ CORS is NOT working correctly');
        reject(new Error('CORS headers missing or incorrect'));
      }
    });

    req.on('error', (err) => {
      console.error('❌ Request failed:', err.message);
      reject(err);
    });

    req.end();
  });
}

// Test actual POST request
function testPOST() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BACKEND_URL}/health`);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: {
        'Origin': ORIGIN
      }
    };

    const protocol = url.protocol === 'https:' ? require('https') : http;
    
    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`\n📤 GET Request:`);
        console.log(`Status: ${res.statusCode}`);
        console.log(`Access-Control-Allow-Origin: ${res.headers['access-control-allow-origin'] || 'MISSING'}`);
        console.log(`Response: ${data}`);
        
        if (res.headers['access-control-allow-origin']) {
          console.log('\n✅ CORS headers present!');
          resolve(true);
        } else {
          console.log('\n❌ CORS headers missing');
          reject(new Error('CORS headers missing'));
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ Request failed:', err.message);
      reject(err);
    });

    req.end();
  });
}

// Run tests
async function runTests() {
  try {
    await testOPTIONS();
    await testPOST();
    console.log('\n✅ All CORS tests passed!');
    process.exit(0);
  } catch (error) {
    console.log('\n❌ CORS tests failed!');
    console.log('Error:', error.message);
    process.exit(1);
  }
}

runTests();

