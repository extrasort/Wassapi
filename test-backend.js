#!/usr/bin/env node

const http = require('http');

const API_URL = process.env.API_URL || 'http://localhost:5000';

console.log('🧪 Testing Wassapi Backend...\n');

// Test health endpoint
function testHealth() {
  return new Promise((resolve, reject) => {
    const url = `${API_URL}/health`;
    console.log(`Testing: ${url}`);
    
    http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Health check passed!');
          console.log('Response:', JSON.parse(data));
          resolve(true);
        } else {
          console.log(`❌ Health check failed with status: ${res.statusCode}`);
          reject(new Error(`Status: ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      console.log('❌ Connection failed!');
      console.log('Error:', err.message);
      console.log('\n💡 Make sure the backend is running:');
      console.log('   cd backend && npm start');
      reject(err);
    });
  });
}

// Test API endpoint
function testAPI() {
  return new Promise((resolve, reject) => {
    const url = `${API_URL}/api/test`;
    console.log(`\nTesting: ${url}`);
    
    http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ API test passed!');
          console.log('Response:', JSON.parse(data));
          resolve(true);
        } else {
          console.log(`❌ API test failed with status: ${res.statusCode}`);
          reject(new Error(`Status: ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      console.log('❌ Connection failed!');
      console.log('Error:', err.message);
      reject(err);
    });
  });
}

// Run tests
async function runTests() {
  try {
    await testHealth();
    await testAPI();
    console.log('\n✅ All tests passed! Backend is healthy.');
    process.exit(0);
  } catch (error) {
    console.log('\n❌ Tests failed!');
    process.exit(1);
  }
}

runTests();

