# High Volume Testing - cURL Examples

## Quick Test (10 messages, 2 seconds apart)
```bash
API_KEY="wass_your_api_key_here"
RECIPIENT="9647812345678"
BASE_URL="https://watanishield.up.railway.app"

for i in {1..10}; do
  echo "Sending message #$i..."
  curl -X POST "${BASE_URL}/api/v1/messages/send" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"recipient\": \"${RECIPIENT}\",
      \"message\": \"Test message #${i} - $(date +%H:%M:%S)\"
    }"
  echo ""
  sleep 2
done
```

## Moderate Volume Test (50 messages, 3 seconds apart)
```bash
API_KEY="wass_your_api_key_here"
RECIPIENT="9647812345678"
BASE_URL="https://watanishield.up.railway.app"

for i in {1..50}; do
  echo "[$i/50] Sending message..."
  curl -X POST "${BASE_URL}/api/v1/messages/send" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"recipient\": \"${RECIPIENT}\",
      \"message\": \"Test message #${i} - $(date +%H:%M:%S)\"
    }"
  echo ""
  
  # Wait 3 seconds between messages
  sleep 3
  
  # Wait 10 seconds after every 10 messages
  if [ $((i % 10)) -eq 0 ] && [ $i -lt 50 ]; then
    echo "Batch complete, waiting 10 seconds..."
    sleep 10
  fi
done
```

## High Volume Test (100 messages, 1 second apart)
```bash
API_KEY="wass_your_api_key_here"
RECIPIENT="9647812345678"
BASE_URL="https://watanishield.up.railway.app"

SUCCESS=0
FAILED=0
RATE_LIMITED=0

for i in {1..100}; do
  echo "[$i/100] Sending message..."
  
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/v1/messages/send" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"recipient\": \"${RECIPIENT}\",
      \"message\": \"Test message #${i} - $(date +%H:%M:%S)\"
    }")
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  
  case $HTTP_CODE in
    200|201)
      echo "✓ Success"
      ((SUCCESS++))
      ;;
    429)
      echo "⚠ Rate limited"
      ((RATE_LIMITED++))
      ;;
    402)
      echo "✗ Insufficient balance"
      ((FAILED++))
      ;;
    *)
      echo "✗ Error (HTTP $HTTP_CODE): $BODY"
      ((FAILED++))
      ;;
  esac
  
  sleep 1
  
  # Wait 15 seconds after every 20 messages
  if [ $((i % 20)) -eq 0 ] && [ $i -lt 100 ]; then
    echo "Batch complete, waiting 15 seconds..."
    sleep 15
  fi
done

echo ""
echo "=== Summary ==="
echo "Successful: $SUCCESS"
echo "Failed: $FAILED"
echo "Rate Limited: $RATE_LIMITED"
```

## Burst Test (10 messages in quick succession)
```bash
API_KEY="wass_your_api_key_here"
RECIPIENT="9647812345678"
BASE_URL="https://watanishield.up.railway.app"

echo "Sending 10 messages in quick succession..."
for i in {1..10}; do
  curl -X POST "${BASE_URL}/api/v1/messages/send" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"recipient\": \"${RECIPIENT}\",
      \"message\": \"Burst test message #${i}\"
    }" &
done

wait
echo "All messages sent (or attempted)"
```

## Testing with OTP Endpoint
```bash
API_KEY="wass_your_api_key_here"
RECIPIENT="9647812345678"
BASE_URL="https://watanishield.up.railway.app"

for i in {1..20}; do
  OTP=$(shuf -i 100000-999999 -n 1)
  echo "Sending OTP #$i: $OTP"
  
  curl -X POST "${BASE_URL}/api/v1/otp/send" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"recipient\": \"${RECIPIENT}\",
      \"otp\": \"${OTP}\",
      \"language\": \"en\"
    }"
  echo ""
  sleep 3
done
```

## Usage Tips

1. **Start Small**: Begin with 10-20 messages to test your setup
2. **Monitor Responses**: Watch for rate limit errors (HTTP 429)
3. **Check Balance**: Ensure you have enough wallet balance (10 IQD per message)
4. **Gradual Increase**: Gradually increase volume to find safe limits
5. **Respect Delays**: Don't send messages too quickly - WhatsApp may ban accounts
6. **Use Different Recipients**: Test with multiple recipients to simulate real usage

## Safe Rate Guidelines

- **Conservative**: 1 message every 5-10 seconds (6-12 messages/minute)
- **Moderate**: 1 message every 2-3 seconds (20-30 messages/minute)
- **Aggressive**: 1 message per second (60 messages/minute) - **RISKY**
- **Burst**: Multiple messages quickly - **VERY RISKY, may result in ban**

## Warning Signs

- HTTP 429 (Rate Limit) responses
- Messages not being delivered
- Account warnings from WhatsApp
- Sudden disconnections

If you see these, **immediately reduce your sending rate**.

