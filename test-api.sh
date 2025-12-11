#!/bin/bash
# Test Wassapi API

API_KEY="wass_5bxMH6vh3vgt6VCq4oWGPq1igV8XrdyNqXjELkN1OOM"
BASE_URL="https://watanishield.up.railway.app"

echo "Testing API with key: ${API_KEY:0:20}..."
echo ""

# Test 1: Send a message
echo "Test 1: Send Message"
curl -X POST "${BASE_URL}/api/v1/messages/send" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "9647812345678", "message": "Hello from Wassapi!"}'

echo ""
echo ""
echo "Test 2: Get Wallet Balance"
curl -X GET "${BASE_URL}/api/v1/wallet/balance" \
  -H "X-API-Key: ${API_KEY}"

echo ""
echo ""

