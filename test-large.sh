#!/bin/bash

# Large Volume Test - 100 messages, 2 seconds apart (aggressive)
# Tests high-volume capabilities - USE WITH CAUTION

API_KEY="wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw"
API_BASE_URL="https://watanishield.up.railway.app"
RECIPIENT="${1:-9647814104097}"
MESSAGE_COUNT=100
DELAY_BETWEEN_MESSAGES=2
BATCH_SIZE=20

export API_KEY API_BASE_URL RECIPIENT MESSAGE_COUNT DELAY_BETWEEN_MESSAGES BATCH_SIZE
./test-high-volume.sh

