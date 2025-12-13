#!/bin/bash

# Extreme Overwhelming Test - Maximum concurrent load
# Simulates 100 users all sending messages simultaneously
# Sends 500 messages with maximum concurrency
# HIGHEST RISK - Use only if you want to test absolute limits

API_KEY="wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw"
API_BASE_URL="https://watanishield.up.railway.app"
RECIPIENT="${1:-9647814104097}"

TOTAL_MESSAGES=500
CONCURRENT_USERS=100
MESSAGES_PER_USER=5

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${RED}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║  🚨 EXTREME OVERWHELMING TEST - MAXIMUM LOAD 🚨      ║${NC}"
echo -e "${RED}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}This will send ${TOTAL_MESSAGES} messages simulating ${CONCURRENT_USERS} concurrent users${NC}"
echo -e "${YELLOW}Messages will be sent with maximum concurrency (almost simultaneously)${NC}"
echo ""
echo -e "${RED}THIS TEST HAS EXTREME RISK OF IMMEDIATE ACCOUNT BAN${NC}"
read -p "Type 'BAN RISK ACCEPTED' to continue: " confirm

if [ "$confirm" != "BAN RISK ACCEPTED" ]; then
    echo "Test cancelled."
    exit 0
fi

TEMP_DIR=$(mktemp -d)
START_TIME=$(date +%s)
SUCCESS=0
FAILED=0
RATE_LIMITED=0

send_msg() {
    local user=$1
    local msg=$2
    local log="${TEMP_DIR}/u${user}_m${msg}.log"
    
    curl -s -w "\n%{http_code}" -X POST "${API_BASE_URL}/api/v1/messages/send" \
        -H "X-API-Key: ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"recipient\": \"${RECIPIENT}\", \"message\": \"EXTREME TEST - User ${user} Message ${msg} - $(date +%s%3N)\"}" \
        > "$log" 2>&1
}

echo "Launching ${TOTAL_MESSAGES} concurrent requests..."

# Launch all messages almost simultaneously
for user in $(seq 1 $CONCURRENT_USERS); do
    for msg in $(seq 1 $MESSAGES_PER_USER); do
        send_msg $user $msg &
    done
done

echo "All requests launched. Waiting for completion..."
wait

# Process results
for log in "${TEMP_DIR}"/*.log; do
    if [ -f "$log" ]; then
        CODE=$(tail -n1 "$log")
        case $CODE in
            200|201) ((SUCCESS++)) ;;
            429) ((RATE_LIMITED++)) ;;
            *) ((FAILED++)) ;;
        esac
    fi
done

rm -rf "$TEMP_DIR"
DURATION=$(($(date +%s) - START_TIME))

echo ""
echo "=== EXTREME TEST RESULTS ==="
echo "Successful: $SUCCESS"
echo "Failed: $FAILED"
echo "Rate Limited: $RATE_LIMITED"
echo "Duration: ${DURATION}s"
echo ""
echo -e "${RED}⚠️ Check your WhatsApp account immediately for warnings or restrictions${NC}"

