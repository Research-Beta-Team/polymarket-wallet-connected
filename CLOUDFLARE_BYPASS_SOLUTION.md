# Cloudflare Bypass Solution

## Problem Summary

The auto trading bot is getting **403 Forbidden** errors from Cloudflare when placing orders via Vercel serverless functions. This happens because:

1. **Serverless function IPs are flagged** - Vercel functions run on AWS/GCP IPs that Cloudflare blocks
2. **ClobClient makes requests internally** - The `@polymarket/clob-client` library uses axios internally, which we can't easily modify
3. **Missing browser fingerprinting** - Serverless functions don't have browser headers/cookies

## Why the Example Works

The reference example (`wallet-connection/magic-safe-builder-example`) works because:

- ✅ **ClobClient runs in the browser** (client-side)
- ✅ **Requests come from user's IP** (not serverless function IP)
- ✅ **Browser provides proper headers** automatically
- ✅ **No Cloudflare blocking**

## Solution Options

### Option 1: Client-Side Order Placement (Recommended - Matches Example)

**How it works:**
- Initialize ClobClient in the browser (frontend)
- Use user's wallet/signer for order signing
- Place orders directly from browser
- Use remote signing endpoint for builder attribution

**Implementation:**
```typescript
// In frontend (browser)
import { ClobClient } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

// Get user's wallet/signer (from Magic Link or similar)
const ethersSigner = await getWalletSigner();

// Initialize ClobClient in browser
const builderConfig = new BuilderConfig({
  remoteBuilderConfig: {
    url: '/api/polymarket/sign', // Remote signing for builder attribution
  },
});

const clobClient = new ClobClient(
  'https://clob.polymarket.com',
  137,
  ethersSigner, // User's signer (browser)
  userApiCredentials,
  2, // signatureType
  proxyAddress,
  undefined,
  false,
  builderConfig
);

// Place order from browser - no Cloudflare blocking!
const response = await clobClient.createAndPostMarketOrder(
  marketOrder,
  { negRisk: false },
  OrderType.FOK
);
```

**Pros:**
- ✅ Matches example implementation
- ✅ No Cloudflare blocking
- ✅ Better user experience
- ✅ Simpler architecture

**Cons:**
- ⚠️ Requires user wallet connection
- ⚠️ Need to refactor current implementation

### Option 2: Contact Polymarket Support (Easiest)

**Steps:**
1. Get Vercel IP ranges:
   - AWS IP ranges: https://ip-ranges.amazonaws.com/ip-ranges.json
   - GCP IP ranges: https://www.gstatic.com/ipranges/cloud.json
2. Contact Polymarket support
3. Request whitelisting for your builder API key
4. Provide use case documentation

**Pros:**
- ✅ No code changes
- ✅ Official solution
- ✅ Works with existing code

**Cons:**
- ⚠️ Requires Polymarket cooperation
- ⚠️ May take time

### Option 3: Use Proxy Service (Quick Fix)

Use a residential proxy service:

**Services:**
- Bright Data
- Smartproxy
- Oxylabs
- ScraperAPI

**Implementation:**
```typescript
// Configure proxy in environment
PROXY_URL=https://your-proxy-service.com

// Use proxy for ClobClient requests
// (Requires modifying ClobClient's axios instance or using proxy)
```

**Pros:**
- ✅ Works immediately
- ✅ No Polymarket changes needed

**Cons:**
- ⚠️ Additional cost
- ⚠️ May add latency
- ⚠️ Complex to implement with ClobClient

## Current Implementation Status

### What We Have
1. ✅ Enhanced error handling with retry logic
2. ✅ Cloudflare detection and logging
3. ✅ Detailed error messages
4. ✅ Retry with exponential backoff

### What's Missing
1. ❌ Actual Cloudflare bypass (ClobClient still blocked)
2. ❌ Client-side order placement
3. ❌ Proxy service integration

## Recommended Action Plan

### Immediate (Today)
1. **Contact Polymarket Support**
   - Email: support@polymarket.com
   - Subject: "Request for Vercel IP Whitelisting for Builder API"
   - Include:
     - Your builder API key
     - Vercel deployment URL
     - Use case description
     - Request for IP whitelisting

### Short-term (This Week)
2. **Set up Proxy Service** (as fallback)
   - Sign up for proxy service
   - Configure proxy endpoint
   - Test order placement

### Long-term (Next Sprint)
3. **Migrate to Client-Side** (like example)
   - Refactor to initialize ClobClient in browser
   - Use user's wallet for signing
   - Keep builder attribution via remote signing

## Code Changes Needed for Client-Side

### 1. Frontend ClobClient Initialization
```typescript
// src/clob-client-browser.ts (new file)
import { ClobClient } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

export function createBrowserClobClient(
  ethersSigner: any,
  apiCredentials: { key: string; secret: string; passphrase: string },
  proxyAddress: string
): ClobClient {
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: {
      url: '/api/polymarket/sign',
    },
  });

  return new ClobClient(
    'https://clob.polymarket.com',
    137,
    ethersSigner,
    apiCredentials,
    1, // or 2 if using Safe
    proxyAddress,
    undefined,
    false,
    builderConfig
  );
}
```

### 2. Update Trading Manager
```typescript
// Instead of calling /api/orders, use ClobClient directly
if (this.clobClient && this.apiCredentials) {
  const response = await this.clobClient.createAndPostMarketOrder(
    marketOrder,
    { negRisk: false },
    OrderType.FOK
  );
  // Handle response
}
```

### 3. Initialize in StreamingPlatform
```typescript
// After wallet connection and API credentials obtained
const clobClient = createBrowserClobClient(
  ethersSigner, // From wallet connection
  apiCredentials,
  proxyAddress
);

// Pass to TradingManager
tradingManager.setClobClient(clobClient);
```

## Testing

After implementing client-side approach:
1. ✅ Orders should place successfully
2. ✅ No Cloudflare 403 errors
3. ✅ Builder attribution still works
4. ✅ All features functional

## Conclusion

The **best solution** is to match the example: **client-side order placement**. This requires refactoring but provides the most reliable solution. For immediate relief, contact Polymarket support to whitelist Vercel IPs.
