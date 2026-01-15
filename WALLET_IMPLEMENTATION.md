# Wallet Connection & Builder Attribution Implementation

This document describes the implementation of proper wallet management, trading session initialization, and builder attribution for order placement.

## Overview

The implementation follows the Polymarket Magic Link integration pattern, providing:
- **Proper proxy wallet derivation** using CREATE2
- **Builder authentication** for order attribution
- **Remote signing** for secure order placement
- **Backward compatibility** with existing trading simulation

## Architecture

### Backend API Endpoints

#### 1. Wallet Connection (`/api/wallet`)
- **Method**: GET
- **Returns**: EOA address and derived proxy wallet address
- **Uses**: Proper CREATE2 proxy derivation from `utils/proxyWallet.ts`

#### 2. Trading Session Initialization (`/api/wallet/initialize`)
- **Method**: POST
- **Returns**: API credentials (key, secret, passphrase)
- **Process**:
  1. Tries to derive existing API credentials
  2. Creates new credentials if derivation fails
  3. Returns credentials for order placement

#### 3. Balance Fetching (`/api/wallet/balance`)
- **Method**: GET
- **Returns**: USDC.e balance from proxy wallet
- **Uses**: Proper proxy address derivation

#### 4. Builder Signing (`/api/polymarket/sign`)
- **Method**: POST
- **Purpose**: Remote signing for builder attribution
- **Required Env Vars**:
  - `POLYMARKET_BUILDER_API_KEY`
  - `POLYMARKET_BUILDER_SECRET`
  - `POLYMARKET_BUILDER_PASSPHRASE`

#### 5. Order Placement (`/api/orders`)
- **Method**: POST (create), DELETE (cancel)
- **Features**:
  - Market orders (FOK - Fill or Kill)
  - Limit orders (GTC - Good Till Cancelled)
  - Builder attribution via remote signing
  - Uses proxy wallet for all transactions

## Key Components

### Proxy Wallet Derivation

**File**: `utils/proxyWallet.ts`

Uses CREATE2 deterministic address generation:

```typescript
import { keccak256, getCreate2Address, encodePacked } from "viem";

export function deriveProxyAddress(eoaAddress: string): string {
  return getCreate2Address({
    bytecodeHash: PROXY_INIT_CODE_HASH,
    from: PROXY_FACTORY,
    salt: keccak256(encodePacked(["address"], [eoaAddress.toLowerCase()])),
  });
}
```

**Constants**:
- `PROXY_FACTORY`: `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052`
- `PROXY_INIT_CODE_HASH`: `0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b`

### Builder Attribution

Orders are placed with builder attribution using the `BuilderConfig`:

```typescript
const builderConfig = new BuilderConfig({
  remoteBuilderConfig: { url: getSigningUrl(request) },
});

const clobClient = new ClobClient(
  CLOB_API_URL,
  POLYGON_CHAIN_ID,
  wallet,
  apiCredentials,
  1,
  proxyAddress,
  undefined,
  false,
  builderConfig  // Builder attribution
);
```

The signing endpoint (`/api/polymarket/sign`) handles HMAC signature generation for builder authentication.

### Trading Manager Integration

The `TradingManager` class now supports both:
1. **Real order placement** (when API credentials are available)
2. **Simulation mode** (when credentials are not available)

**API Credentials Flow**:
1. User connects wallet → Gets EOA and proxy addresses
2. User initializes trading session → Gets API credentials
3. Credentials stored in `TradingManager` via `setApiCredentials()`
4. Orders placed via `/api/orders` with builder attribution

## Environment Variables

### Required

```bash
# Magic wallet private key (from reveal.magic.link/polymarket)
POLYMARKET_MAGIC_PK=0x...your_private_key_here

# Builder credentials for order attribution
POLYMARKET_BUILDER_API_KEY=your_builder_api_key
POLYMARKET_BUILDER_SECRET=your_builder_secret
POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase
```

### Optional

```bash
# Custom Polygon RPC URL
POLYGON_RPC_URL=https://polygon-rpc.com
```

## Usage Flow

### 1. Connect Wallet
```typescript
// Frontend calls
GET /api/wallet
// Returns: { eoaAddress, proxyAddress }
```

### 2. Initialize Trading Session
```typescript
// Frontend calls
POST /api/wallet/initialize
// Returns: { credentials: { key, secret, passphrase } }
```

### 3. Place Orders
```typescript
// Trading manager calls (when credentials available)
POST /api/orders
{
  tokenId: "0x...",
  price: 0.96,  // Decimal (0-1)
  size: 100,     // Shares
  side: "BUY",
  isMarketOrder: false,
  apiCredentials: { key, secret, passphrase }
}
```

### 4. Fetch Balance
```typescript
// Frontend calls
GET /api/wallet/balance
// Returns: { balance: 1000.50, currency: "USDC.e" }
```

## Order Types

### Market Orders (FOK)
- Execute immediately or cancel
- Used for exits (profit target/stop loss)
- Price determined by current market

### Limit Orders (GTC)
- Good Till Cancelled
- Used for entries
- Price specified by user

## Backward Compatibility

The implementation maintains backward compatibility:
- **Without credentials**: Trading manager works in simulation mode
- **With credentials**: Real orders are placed via API
- **Existing functionality**: All existing features continue to work

## Security Notes

1. **Private keys**: Never exposed to client, only used server-side
2. **API credentials**: Stored in memory (client-side) after initialization
3. **Builder credentials**: Stored in environment variables (server-side)
4. **Remote signing**: Builder signatures generated server-side

## Dependencies Added

```json
{
  "@polymarket/builder-signing-sdk": "^0.0.8",
  "viem": "^2.39.2"
}
```

## Files Created/Modified

### Created
- `utils/proxyWallet.ts` - Proxy wallet derivation
- `constants/polymarket.ts` - Polymarket constants
- `api/polymarket/sign.ts` - Builder signing endpoint
- `api/orders.ts` - Order placement with builder attribution

### Modified
- `api/wallet.ts` - Proper proxy derivation
- `api/wallet/initialize.ts` - API credentials generation
- `api/wallet/balance.ts` - Proper proxy address usage
- `src/trading-manager.ts` - Real order placement support
- `src/streaming-platform.ts` - Credentials storage
- `package.json` - Added dependencies

## Testing

1. **Wallet Connection**: Verify EOA and proxy addresses are correct
2. **Session Initialization**: Check API credentials are generated
3. **Balance Fetching**: Verify balance shows from proxy wallet
4. **Order Placement**: Test with real credentials (requires funded wallet)
5. **Builder Attribution**: Verify orders include builder signature

## Troubleshooting

### "Wallet not configured"
- Ensure `POLYMARKET_MAGIC_PK` is set in environment variables

### "Builder credentials not configured"
- Set `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, and `POLYMARKET_BUILDER_PASSPHRASE`

### "Order submission failed"
- Check API credentials are initialized
- Verify proxy wallet has USDC.e balance
- Check builder credentials are valid

### Balance shows $0.00
- Ensure funds are sent to **proxy wallet**, not EOA
- Verify proxy wallet address is correct (use deriveProxyAddress)

## References

- [Polymarket CLOB Client Docs](https://docs.polymarket.com/developers/CLOB/clients)
- [Builder Signing SDK](https://github.com/Polymarket/builder-signing-sdk)
- [Proxy Wallet Documentation](https://docs.polymarket.com/developers/proxy-wallet)
