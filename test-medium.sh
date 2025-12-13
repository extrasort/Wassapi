#!/bin/bash

# Medium Volume Test - 50 messages, 2 seconds apart (moderate)
# Tests sustained messaging rate

API_KEY="wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw"
API_BASE_URL="https://watanishield.up.railway.app"
RECIPIENT="${1:-9647814104097}"
MESSAGE_COUNT=50
DELAY_BETWEEN_MESSAGES=2
BATCH_SIZE=10

export API_KEY API_BASE_URL RECIPIENT MESSAGE_COUNT DELAY_BETWEEN_MESSAGES BATCH_SIZE
./test-high-volume.sh

