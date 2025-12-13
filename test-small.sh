#!/bin/bash

# Small Volume Test - 20 messages, 3 seconds apart (conservative)
# Safe for testing account limits

API_KEY="wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw"
API_BASE_URL="https://watanishield.up.railway.app"
RECIPIENT="${1:-9647814104097}"
MESSAGE_COUNT=20
DELAY_BETWEEN_MESSAGES=3
BATCH_SIZE=5

export API_KEY API_BASE_URL RECIPIENT MESSAGE_COUNT DELAY_BETWEEN_MESSAGES BATCH_SIZE
./test-high-volume.sh

