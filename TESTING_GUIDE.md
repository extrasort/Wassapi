# High Volume Testing Guide

This directory contains scripts to test your WhatsApp messaging at different volumes to check for rate limiting and potential bans.

## ⚠️ Important Warnings

- **Start with small tests** to verify your setup
- **Monitor for rate limits** (HTTP 429 responses)
- **WhatsApp may ban accounts** that send too many messages too quickly
- **Use test recipient numbers** to avoid annoying real users
- **Have sufficient wallet balance** (10 IQD per message)

## Quick Start

All scripts are pre-configured with your API key. Just provide a recipient number:

```bash
# Small test (20 messages, 3 sec delays) - SAFE
./test-small.sh 9647812345678

# Medium test (50 messages, 2 sec delays) - MODERATE RISK
./test-medium.sh 9647812345678

# Large test (100 messages, 2 sec delays) - AGGRESSIVE
./test-large.sh 9647812345678

# Burst test (30 messages, 1 sec delays) - VERY RISKY
./test-burst.sh 9647812345678
```

## Test Scripts

### 1. `test-small.sh` - Conservative Test
- **Messages**: 20
- **Delay**: 3 seconds between messages
- **Batch size**: 5 messages per batch
- **Risk Level**: ✅ Low
- **Best for**: Initial testing, verifying setup

### 2. `test-medium.sh` - Moderate Test
- **Messages**: 50
- **Delay**: 2 seconds between messages
- **Batch size**: 10 messages per batch
- **Risk Level**: ⚠️ Moderate
- **Best for**: Testing sustained messaging rate

### 3. `test-large.sh` - Aggressive Test
- **Messages**: 100
- **Delay**: 2 seconds between messages
- **Batch size**: 20 messages per batch
- **Risk Level**: ⚠️⚠️ High
- **Best for**: Stress testing, finding limits

### 4. `test-burst.sh` - Very Aggressive Test
- **Messages**: 30
- **Delay**: 1 second between messages
- **Batch size**: 10 messages per batch
- **Risk Level**: 🚨 Very High - May result in ban!
- **Best for**: Testing burst capabilities (use with extreme caution)

## Custom Testing

Use `test-high-volume.sh` directly for custom configurations:

```bash
export API_KEY="wass_tL4LdF4oKJo6Pe-FS3HCrqrr5Jpv7-FEPnJvs-Ehqyw"
export RECIPIENT="9647812345678"
export MESSAGE_COUNT=75
export DELAY_BETWEEN_MESSAGES=2.5
export BATCH_SIZE=15

./test-high-volume.sh
```

## Understanding Results

### Success Indicators
- ✅ All messages return HTTP 200/201
- ✅ No rate limit errors
- ✅ All messages delivered successfully

### Warning Signs
- ⚠️ HTTP 429 (Rate Limit) responses
- ⚠️ Messages not being delivered
- ⚠️ Account warnings from WhatsApp

### Danger Signs
- 🚨 Sudden disconnections
- 🚨 Multiple rate limit errors in a row
- 🚨 Account blocked warnings

## Recommendations

1. **Start Small**: Always begin with `test-small.sh`
2. **Monitor Results**: Watch for rate limiting
3. **Gradual Increase**: Move to larger tests only if small tests succeed
4. **Respect Delays**: Don't modify delays to be shorter
5. **Test Recipients**: Use test numbers, not real customer numbers
6. **Check Balance**: Ensure sufficient wallet balance before testing

## Safe Production Rates

Based on testing results, recommended production rates:

- **Conservative**: 1 message per 5-10 seconds (6-12 msg/min)
- **Moderate**: 1 message per 2-3 seconds (20-30 msg/min)
- **Aggressive**: 1 message per 1-2 seconds (30-60 msg/min) - **RISKY**

## Troubleshooting

### "Insufficient balance" error
- Top up your wallet (10 IQD per message needed)

### "Rate limit exceeded" error
- Increase delay between messages
- Reduce batch size
- Wait longer between batches

### "Session not found" error
- Check WhatsApp session is connected in dashboard
- Reconnect if necessary

### All messages failing
- Verify API key is correct
- Check recipient number format (international format, no +)
- Ensure WhatsApp session is active

## Next Steps

After testing:
1. Document your safe rate limits
2. Implement these limits in production code
3. Monitor actual usage for rate limiting
4. Adjust rates based on real-world feedback

