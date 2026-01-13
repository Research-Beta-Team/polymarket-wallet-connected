# Trading Bot Flow Examples

This document provides detailed examples of how the automated trading bot works, including entry, position management, and exit scenarios.

## Overview

The bot monitors BTC/USD price movements and places trades on Polymarket's BTC Up/Down markets based on configured strategy parameters.

## Configuration Example

```typescript
StrategyConfig {
  enabled: true,
  entryPrice: 96,           // Buy when UP or DOWN price = 96
  profitTargetPrice: 100,   // Sell when price = 100
  stopLossPrice: 90,        // Sell when price >= 90 (with adaptive selling)
  tradeSize: 50,            // Trade $50 per position
  priceDifference: null     // Optional: Only trade if |Price to Beat - Current BTC| = this value
}
```

---

## Example Flow 1: Successful Trade (Profit Target)

### Initial State
- **Current BTC Price**: $65,000
- **Price to Beat**: $64,500 (from previous event)
- **Active Event**: `btc-updown-15m-1768320000`
- **UP Token Price**: 95.5%
- **DOWN Token Price**: 4.5%
- **Position**: None

### Step 1: Monitoring
```
[TradingManager] Monitoring prices...
- UP Token: 95.5%
- DOWN Token: 4.5%
- Entry Price: 96
- No match yet, continuing to monitor...
```

### Step 2: Entry Trigger
```
[TradingManager] UP Token price reached entry price!
- UP Token: 96.0% (exactly matches entryPrice = 96)
- DOWN Token: 4.0%
- Entry condition met: UP price = 96

[TradingManager] Placing market order (FAK):
- Token: YES/UP token
- Direction: UP
- Entry Price: 96.0%
- Trade Size: $50
- Order Type: FAK (Fill and Kill)
```

### Step 3: Order Execution
```
[TradingManager] ✅ Browser market order (FAK) placed successfully:
- Order ID: abc123...
- Fill Price: 96.0%
- Direction: UP
- Trade Size: $50
- Status: FILLED

[TradingManager] Position created:
- Event: btc-updown-15m-1768320000
- Token: YES/UP token
- Direction: UP
- Entry Price: 96.0%
- Size: $50
```

### Step 4: Position Monitoring
```
[TradingManager] Monitoring position...
- Current Price: 97.5%
- Entry Price: 96.0%
- Unrealized Profit: +$0.78
- Profit Target: 100
- Stop Loss: 90
- No exit conditions met yet...
```

### Step 5: Profit Target Reached
```
[TradingManager] Profit target reached!
- Current Price: 100.0% (exactly matches profitTarget = 100)
- Entry Price: 96.0%
- Profit: +$2.08

[TradingManager] Closing position (SELL):
- Token: YES/UP token
- Exit Price: 100.0%
- Reason: Profit target reached at 100.00

[TradingManager] ✅ Browser SELL order (FAK) placed successfully:
- Order ID: xyz789...
- Fill Price: 100.0%
- Profit: +$2.08
- Status: FILLED
```

### Final Result
```
✅ Trade Completed Successfully
- Entry: 96.0% (UP)
- Exit: 100.0% (Profit Target)
- Profit: +$2.08
- Duration: ~3 minutes
```

---

## Example Flow 2: Stop Loss with Adaptive Selling

### Initial State
- **Position**: Active
- **Entry Price**: 96.0% (UP direction)
- **Current Price**: 94.5%
- **Stop Loss**: 90

### Step 1: Price Drops Below Stop Loss
```
[TradingManager] Monitoring position...
- Current Price: 91.0%
- Entry Price: 96.0%
- Unrealized Loss: -$2.60
- Stop Loss: 90

[TradingManager] Stop loss triggered!
- Current Price: 91.0% (>= stopLoss = 90)
- Starting adaptive selling...
```

### Step 2: Adaptive Selling Attempt 1
```
[TradingManager] Starting adaptive stop loss selling:
- Stop Loss Price: 90
- Max Attempts: 5
- Reason: Stop loss triggered at 91.00

[TradingManager] Attempt 1/5: Trying to sell at price 90.00
- Current Price: 91.0%
- Target Price: 90.0%
- Current price (91.0%) is above target (90.0%), will try lower price on next attempt
- Waiting 500ms before next attempt...
```

### Step 3: Adaptive Selling Attempt 2
```
[TradingManager] Attempt 2/5: Trying to sell at price 89.00
- Current Price: 90.5%
- Target Price: 89.0%
- Current price (90.5%) is above target (89.0%), will try lower price on next attempt
- Waiting 500ms before next attempt...
```

### Step 4: Adaptive Selling Attempt 3 (Success)
```
[TradingManager] Attempt 3/5: Trying to sell at price 88.00
- Current Price: 87.8%
- Target Price: 88.0%
- Current price (87.8%) is at/below target (88.0%), proceeding with sale

[TradingManager] Closing position (SELL):
- Token: YES/UP token
- Exit Price: 87.8%
- Reason: Stop loss triggered at 91.00 - Sold at 87.80 (target was 88.00)

[TradingManager] ✅ Browser SELL order (FAK) placed successfully:
- Order ID: def456...
- Fill Price: 87.8%
- Loss: -$4.27
- Status: FILLED
```

### Final Result
```
⚠️ Trade Closed with Stop Loss
- Entry: 96.0% (UP)
- Exit: 87.8% (Adaptive Stop Loss - Attempt 3)
- Loss: -$4.27
- Stop Loss Price: 90 (tried 90, 89, then sold at 88)
```

---

## Example Flow 3: DOWN Direction Trade

### Initial State
- **Current BTC Price**: $65,200
- **UP Token Price**: 94.0%
- **DOWN Token Price**: 6.0%
- **Entry Price**: 96
- **Position**: None

### Step 1: DOWN Token Reaches Entry
```
[TradingManager] Monitoring prices...
- UP Token: 94.0%
- DOWN Token: 6.0%
- Entry Price: 96

[TradingManager] DOWN Token price reached entry price!
- UP Token: 94.0%
- DOWN Token: 96.0% (exactly matches entryPrice = 96)
- Entry condition met: DOWN price = 96

[TradingManager] Placing market order (FAK):
- Token: NO/DOWN token
- Direction: DOWN
- Entry Price: 96.0%
- Trade Size: $50
```

### Step 2: Order Execution
```
[TradingManager] ✅ Browser market order (FAK) placed successfully:
- Order ID: ghi789...
- Fill Price: 96.0%
- Direction: DOWN
- Trade Size: $50
- Status: FILLED

[TradingManager] Position created:
- Event: btc-updown-15m-1768320000
- Token: NO/DOWN token
- Direction: DOWN
- Entry Price: 96.0%
- Size: $50
```

### Step 3: Price Movement (DOWN token price increases = BTC price going down)
```
[TradingManager] Monitoring position...
- Current Price: 98.5% (DOWN token price increased)
- Entry Price: 96.0%
- Unrealized Profit: +$1.30
- Profit Target: 100
- Stop Loss: 90
```

### Step 4: Profit Target Reached
```
[TradingManager] Profit target reached!
- Current Price: 100.0% (DOWN token = 100%)
- Entry Price: 96.0%
- Profit: +$2.08

[TradingManager] ✅ Browser SELL order (FAK) placed successfully:
- Order ID: jkl012...
- Fill Price: 100.0%
- Profit: +$2.08
- Status: FILLED
```

### Final Result
```
✅ Trade Completed Successfully (DOWN Direction)
- Entry: 96.0% (DOWN)
- Exit: 100.0% (Profit Target)
- Profit: +$2.08
- Direction: DOWN (betting BTC price goes down)
```

---

## Example Flow 4: Stop Loss - All Adaptive Attempts Fail

### Initial State
- **Position**: Active
- **Entry Price**: 96.0% (UP)
- **Current Price**: 92.0%
- **Stop Loss**: 90

### Step 1: Stop Loss Triggered
```
[TradingManager] Stop loss triggered!
- Current Price: 92.0% (>= stopLoss = 90)
- Starting adaptive selling...
```

### Step 2-6: All Adaptive Attempts
```
[TradingManager] Attempt 1/5: Trying to sell at price 90.00
- Current Price: 92.0% > 90.0%, trying lower...

[TradingManager] Attempt 2/5: Trying to sell at price 89.00
- Current Price: 91.5% > 89.0%, trying lower...

[TradingManager] Attempt 3/5: Trying to sell at price 88.00
- Current Price: 90.8% > 88.0%, trying lower...

[TradingManager] Attempt 4/5: Trying to sell at price 87.00
- Current Price: 89.2% > 87.0%, trying lower...

[TradingManager] Attempt 5/5: Trying to sell at price 86.00
- Current Price: 88.5% > 86.0%, all attempts failed
```

### Step 7: Fallback to Market Price
```
[TradingManager] All adaptive attempts failed, selling at current market price
- Current Price: 88.5%
- Reason: Stop loss triggered at 92.00 - Adaptive selling failed, using market price

[TradingManager] ✅ Browser SELL order (FAK) placed successfully:
- Order ID: mno345...
- Fill Price: 88.5%
- Loss: -$3.91
- Status: FILLED
```

### Final Result
```
⚠️ Trade Closed with Stop Loss (Market Price Fallback)
- Entry: 96.0% (UP)
- Exit: 88.5% (Market Price - All adaptive attempts failed)
- Loss: -$3.91
- Note: Tried to sell at 90, 89, 88, 87, 86, but price never dropped low enough
```

---

## Example Flow 5: Price Difference Strategy

### Configuration
```typescript
StrategyConfig {
  entryPrice: 96,
  profitTargetPrice: 100,
  stopLossPrice: 90,
  tradeSize: 50,
  priceDifference: 100  // Only trade if |Price to Beat - Current BTC| = 100
}
```

### Initial State
- **Price to Beat**: $64,500 (from previous event)
- **Current BTC Price**: $64,400
- **Price Difference**: |64,500 - 64,400| = $100 ✅ (matches priceDifference = 100)
- **UP Token Price**: 96.0%
- **DOWN Token Price**: 4.0%

### Step 1: Price Difference Check
```
[TradingManager] Checking price difference condition...
- Price to Beat: $64,500
- Current BTC Price: $64,400
- Price Difference: $100
- Target Difference: $100
- ✅ Condition met: |64,500 - 64,400| = 100
```

### Step 2: Entry Trigger
```
[TradingManager] Price difference condition met AND entry price reached!
- UP Token: 96.0% (exactly matches entryPrice = 96)
- Placing order...
```

### Step 3: Trade Execution
```
[TradingManager] ✅ Browser market order (FAK) placed successfully:
- Order ID: pqr678...
- Fill Price: 96.0%
- Direction: UP
- Price Difference: $100 (condition met)
```

---

## Key Behaviors

### 1. Entry Logic
- **Exact Match**: Only buys when UP or DOWN price **exactly equals** entry price (with 0.1% tolerance)
- **Direction**: Automatically determines UP or DOWN based on which token reaches entry price first
- **Single Order**: Only one order is placed at a time (prevents duplicates)

### 2. Profit Target Logic
- **Exact Match**: Only sells when price **exactly equals** profit target (with 0.1% tolerance)
- **Immediate Execution**: Uses FAK market order for immediate fill

### 3. Stop Loss Logic
- **Trigger**: Sells when price **>= stop loss** (not exact match)
- **Adaptive Selling**: Tries multiple price levels (stopLoss, stopLoss-1, stopLoss-2, etc.)
- **Fallback**: If all adaptive attempts fail, sells at current market price to stop loss
- **Maximum Attempts**: Up to 5 attempts before fallback

### 4. Order Types
- **FAK (Fill and Kill)**: All orders use FAK for immediate execution
- **Market Orders**: No limit orders, all orders execute at market price
- **Builder Attribution**: All orders include builder attribution via remote signing

### 5. Price Monitoring
- **Frequency**: Checks prices every few seconds (based on monitoring interval)
- **Real-time**: Uses WebSocket for real-time price updates
- **Both Tokens**: Monitors both UP (YES) and DOWN (NO) tokens simultaneously

---

## State Transitions

```
[No Position]
    ↓
[Monitoring Prices]
    ↓
[Entry Condition Met] → [Placing Order] → [Order Filled] → [Position Active]
                                                                    ↓
                                                          [Monitoring Position]
                                                                    ↓
                                    ┌───────────────────────────────┴───────────────────────────────┐
                                    ↓                                                               ↓
                        [Profit Target = Current Price]                              [Current Price >= Stop Loss]
                                    ↓                                                               ↓
                            [Sell at Profit Target]                                    [Adaptive Selling]
                                    ↓                                                               ↓
                            [Position Closed]                                          [Sell at Best Price]
                                    ↓                                                               ↓
                            [Trade Complete]                                          [Position Closed]
```

---

## Error Handling

### Order Placement Failures
- **Retry Logic**: Automatic retry with exponential backoff for Cloudflare blocks
- **Fallback**: Falls back to server-side API if browser client fails
- **Logging**: Detailed error logging for debugging

### Price Fetch Failures
- **Skip Check**: If price cannot be fetched, skips that check cycle
- **Continue Monitoring**: Continues monitoring on next cycle

### Network Issues
- **Graceful Degradation**: Falls back to simulation mode if API unavailable
- **Error Messages**: Clear error messages displayed to user

---

## Example Timeline

```
00:00 - Bot starts monitoring
00:15 - UP price reaches 96.0% → BUY order placed
00:16 - Order filled at 96.0% → Position created
00:20 - Price moves to 97.5% → Monitoring (no exit)
00:30 - Price moves to 99.0% → Monitoring (no exit)
00:35 - Price reaches 100.0% → Profit target met → SELL order placed
00:36 - Order filled at 100.0% → Position closed → Profit: +$2.08
```

---

## Notes

1. **Exact Matching**: Entry and profit target use exact matching (not ranges)
2. **Adaptive Stop Loss**: Stop loss uses adaptive selling to minimize losses
3. **Single Order**: Only one order is active at a time
4. **Direction Independence**: UP and DOWN logic are identical, only direction differs
5. **Real-time Execution**: All orders execute immediately (FAK market orders)
6. **Builder Attribution**: All orders include builder attribution for revenue sharing
