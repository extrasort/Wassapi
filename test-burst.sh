#!/bin/bash

# Overwhelming Burst Test - Simulates 100 concurrent users
# Sends 300 messages with concurrent bursts - EXTREMELY HIGH RISK OF BAN
# USE WITH EXTREME CAUTION - May result in immediate account ban!

API_KEY="wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw"
API_BASE_URL="https://watanishield.up.railway.app"
RECIPIENT="${1:-9647814104097}"

# Configuration for overwhelming test
TOTAL_MESSAGES=300           # Total messages to send
CONCURRENT_USERS=100         # Simulate 100 concurrent users
MESSAGES_PER_USER=3          # Each "user" sends 3 messages
BURST_DELAY=0.1              # Very small delay between concurrent sends (100ms)
BATCH_DELAY=5                # Delay between batches of concurrent users

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${RED}════════════════════════════════════════════════════════${NC}"
echo -e "${RED}  ⚠️  OVERWHELMING BURST TEST - EXTREME DANGER ⚠️${NC}"
echo -e "${RED}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}This test simulates 100 concurrent users all sending messages${NC}"
echo -e "${YELLOW}Total messages: ${TOTAL_MESSAGES}${NC}"
echo -e "${YELLOW}Concurrent users: ${CONCURRENT_USERS}${NC}"
echo -e "${YELLOW}Messages per user: ${MESSAGES_PER_USER}${NC}"
echo -e "${YELLOW}Burst delay: ${BURST_DELAY}s between concurrent sends${NC}"
echo ""
echo -e "${RED}⚠️  WARNING: This test has EXTREMELY HIGH RISK of:${NC}"
echo -e "${RED}   - Immediate account ban${NC}"
echo -e "${RED}   - Rate limiting${NC}"
echo -e "${RED}   - Service disruption${NC}"
echo ""
read -p "Type 'YES I UNDERSTAND THE RISK' to continue: " confirm

if [ "$confirm" != "YES I UNDERSTAND THE RISK" ]; then
    echo "Test cancelled."
    exit 0
fi

# Statistics
SUCCESS_COUNT=0
FAILED_COUNT=0
RATE_LIMIT_COUNT=0
ERROR_COUNT=0
TEMP_DIR=$(mktemp -d)
START_TIME=$(date +%s)

# Function to send a message (called in background)
send_message() {
    local user_id=$1
    local msg_num=$2
    local message_text="BURST TEST - User ${user_id} - Message ${msg_num} - $(date +%H:%M:%S.%3N)"
    local log_file="${TEMP_DIR}/user_${user_id}_msg_${msg_num}.log"
    
    local response=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE_URL}/api/v1/messages/send" \
        -H "X-API-Key: ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{
            \"recipient\": \"${RECIPIENT}\",
            \"message\": \"${message_text}\"
        }" 2>&1)
    
    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    echo "$http_code|$body" > "$log_file"
}

# Function to process results from log files
process_results() {
    for log_file in "${TEMP_DIR}"/*.log; do
        if [ -f "$log_file" ]; then
            local content=$(cat "$log_file")
            local http_code=$(echo "$content" | cut -d'|' -f1)
            local body=$(echo "$content" | cut -d'|' -f2-)
            
            case $http_code in
                200|201)
                    ((SUCCESS_COUNT++))
                    ;;
                429)
                    ((RATE_LIMIT_COUNT++))
                    ;;
                402)
                    ((FAILED_COUNT++))
                    ;;
                *)
                    ((ERROR_COUNT++))
                    ;;
            esac
        fi
    done
}

echo ""
echo -e "${BLUE}Starting overwhelming burst test...${NC}"
echo -e "${BLUE}Simulating ${CONCURRENT_USERS} concurrent users...${NC}"
echo ""

# Send messages in waves of concurrent users
WAVE=1
MESSAGE_ID=1

for user in $(seq 1 $CONCURRENT_USERS); do
    # Each user sends multiple messages in quick succession
    for msg in $(seq 1 $MESSAGES_PER_USER); do
        send_message $user $msg &
        MESSAGE_ID=$((MESSAGE_ID + 1))
        
        # Small delay between concurrent sends
        sleep $BURST_DELAY
        
        # Limit concurrent processes to avoid overwhelming system
        if [ $((MESSAGE_ID % 50)) -eq 0 ]; then
            wait
            echo -e "${YELLOW}Sent batch of 50 messages, processing results...${NC}"
            process_results
            sleep 2
        fi
    done
    
    # After each user, wait a bit
    if [ $((user % 20)) -eq 0 ]; then
        echo -e "${YELLOW}Completed ${user}/${CONCURRENT_USERS} users, waiting ${BATCH_DELAY}s...${NC}"
        wait
        process_results
        sleep $BATCH_DELAY
    fi
done

# Wait for all background processes to complete
echo ""
echo -e "${YELLOW}Waiting for all messages to complete...${NC}"
wait

# Process final results
process_results

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Clean up temp files
rm -rf "$TEMP_DIR"

# Print summary
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  TEST SUMMARY${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
echo "Total Messages Sent: $TOTAL_MESSAGES"
echo -e "${GREEN}Successful: $SUCCESS_COUNT${NC}"
echo -e "${RED}Failed: $FAILED_COUNT${NC}"
echo -e "${YELLOW}Rate Limited: $RATE_LIMIT_COUNT${NC}"
echo -e "${RED}Errors: $ERROR_COUNT${NC}"
echo "Total Duration: ${DURATION}s"
if [ $DURATION -gt 0 ]; then
    echo "Average Rate: $(echo "scale=2; $SUCCESS_COUNT / $DURATION * 60" | bc) messages/minute"
    echo "Peak Concurrent Users: $CONCURRENT_USERS"
fi

# Critical warnings
echo ""
echo -e "${RED}════════════════════════════════════════════════════════${NC}"
if [ $RATE_LIMIT_COUNT -gt 0 ]; then
    echo -e "${RED}⚠️  RATE LIMITING DETECTED!${NC}"
    echo -e "${RED}Your account may be at risk of ban.${NC}"
fi

if [ $ERROR_COUNT -gt 50 ]; then
    echo -e "${RED}⚠️  HIGH ERROR RATE DETECTED!${NC}"
    echo -e "${RED}Service may be overwhelmed or account may be restricted.${NC}"
fi

if [ $SUCCESS_COUNT -eq $TOTAL_MESSAGES ]; then
    echo -e "${GREEN}✓ All messages sent successfully${NC}"
    echo -e "${YELLOW}⚠️  But monitor your account for warnings from WhatsApp${NC}"
fi
echo -e "${RED}════════════════════════════════════════════════════════${NC}"

