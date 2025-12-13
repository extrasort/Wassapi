#!/bin/bash

# High Volume Message Testing Script
# This script tests sending multiple messages to check for rate limiting and potential bans
# WARNING: Use with caution - sending too many messages too quickly may result in account bans

# Configuration
API_BASE_URL="${API_BASE_URL:-https://watanishield.up.railway.app}"
API_KEY="${API_KEY:-wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw}"
RECIPIENT="${RECIPIENT:-9647814104097}"  # Test recipient number
MESSAGE_COUNT="${MESSAGE_COUNT:-50}"     # Number of messages to send
DELAY_BETWEEN_MESSAGES="${DELAY_BETWEEN_MESSAGES:-2}"  # Seconds between messages
BATCH_SIZE="${BATCH_SIZE:-10}"           # Messages per batch (with longer delay after batch)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== High Volume Message Testing Script ===${NC}"
echo "API URL: $API_BASE_URL"
echo "Recipient: $RECIPIENT"
echo "Total Messages: $MESSAGE_COUNT"
echo "Delay between messages: ${DELAY_BETWEEN_MESSAGES}s"
echo "Batch size: $BATCH_SIZE"
echo ""
read -p "Press Enter to start or Ctrl+C to cancel..."

# Statistics
SUCCESS_COUNT=0
FAILED_COUNT=0
RATE_LIMIT_COUNT=0
ERROR_COUNT=0
START_TIME=$(date +%s)

# Function to send a single message
send_message() {
    local message_num=$1
    local message_text="Test message #${message_num} - $(date +%H:%M:%S)"
    
    local response=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE_URL}/api/v1/messages/send" \
        -H "X-API-Key: ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{
            \"recipient\": \"${RECIPIENT}\",
            \"message\": \"${message_text}\"
        }")
    
    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    case $http_code in
        200|201)
            echo -e "${GREEN}✓${NC} Message #${message_num} sent successfully"
            ((SUCCESS_COUNT++))
            return 0
            ;;
        429)
            echo -e "${YELLOW}⚠${NC} Message #${message_num} - Rate limit exceeded (HTTP $http_code)"
            ((RATE_LIMIT_COUNT++))
            return 1
            ;;
        402)
            echo -e "${RED}✗${NC} Message #${message_num} - Insufficient balance (HTTP $http_code)"
            ((FAILED_COUNT++))
            return 1
            ;;
        400|404|503)
            echo -e "${RED}✗${NC} Message #${message_num} - Error (HTTP $http_code): $(echo $body | jq -r '.error // "Unknown error"' 2>/dev/null || echo $body)"
            ((ERROR_COUNT++))
            return 1
            ;;
        *)
            echo -e "${RED}✗${NC} Message #${message_num} - Unexpected response (HTTP $http_code): $body"
            ((ERROR_COUNT++))
            return 1
            ;;
    esac
}

# Main sending loop
echo -e "${YELLOW}Starting message sending...${NC}\n"

for i in $(seq 1 $MESSAGE_COUNT); do
    echo -n "[$i/$MESSAGE_COUNT] "
    send_message $i
    
    # Delay between messages
    if [ $i -lt $MESSAGE_COUNT ]; then
        sleep $DELAY_BETWEEN_MESSAGES
    fi
    
    # Longer delay after each batch
    if [ $((i % BATCH_SIZE)) -eq 0 ] && [ $i -lt $MESSAGE_COUNT ]; then
        echo -e "${YELLOW}--- Batch complete, waiting 10 seconds before next batch...${NC}"
        sleep 10
    fi
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Print summary
echo ""
echo -e "${YELLOW}=== Test Summary ===${NC}"
echo "Total Messages: $MESSAGE_COUNT"
echo -e "${GREEN}Successful: $SUCCESS_COUNT${NC}"
echo -e "${RED}Failed: $FAILED_COUNT${NC}"
echo -e "${YELLOW}Rate Limited: $RATE_LIMIT_COUNT${NC}"
echo -e "${RED}Errors: $ERROR_COUNT${NC}"
echo "Total Duration: ${DURATION}s"
echo "Average Rate: $(echo "scale=2; $SUCCESS_COUNT / $DURATION * 60" | bc) messages/minute"

# Recommendations
echo ""
echo -e "${YELLOW}=== Recommendations ===${NC}"
if [ $RATE_LIMIT_COUNT -gt 0 ]; then
    echo -e "${YELLOW}⚠ Rate limiting detected. Consider:${NC}"
    echo "  - Increasing delay between messages (current: ${DELAY_BETWEEN_MESSAGES}s)"
    echo "  - Reducing batch size (current: $BATCH_SIZE)"
    echo "  - Checking your rate limit settings in the dashboard"
fi

if [ $SUCCESS_COUNT -eq $MESSAGE_COUNT ]; then
    echo -e "${GREEN}✓ All messages sent successfully!${NC}"
    echo "  - Your current rate is safe"
    echo "  - Consider gradually increasing volume for production"
fi

if [ $FAILED_COUNT -gt 0 ] || [ $ERROR_COUNT -gt 0 ]; then
    echo -e "${RED}✗ Some messages failed. Check:${NC}"
    echo "  - Wallet balance"
    echo "  - WhatsApp session status"
    echo "  - API key validity"
fi

