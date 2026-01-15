# Cloudflare Bypass Plan

## Problem Analysis

### Current Issue
- **403 Forbidden from Cloudflare** when placing orders via Vercel serverless functions
- Cloudflare blocks requests from serverless function IPs (detected as bots)
- The `@polymarket/clob-client` library makes requests internally, which we can't directly modify

### Key Difference: Example vs Our Implementation

**Example Codebase (wallet-connection/magic-safe-builder-example):**
- ✅ ClobClient runs **in the browser** (client-side)
- ✅ Requests come from **user's IP address** (not serverless function IP)
- ✅ Browser has proper headers, cookies, and fingerprinting
- ✅ No Cloudflare blocking

**Our Implementation:**
- ❌ ClobClient runs **in Vercel serverless function** (server-side)
- ❌ Requests come from **Vercel IP addresses** (flagged as bots)
- ❌ Missing browser-like headers and fingerprinting
- ❌ Cloudflare blocks the requests

## Solution Strategy

### Option 1: Full Proxy Endpoint (Recommended)
Create a proxy endpoint that:
1. Receives order parameters from frontend
2. Constructs the order request manually
3. Makes HTTP request with browser-like headers
4. Forwards the response back

**Pros:**
- Full control over headers
- Can add Cloudflare bypass headers
- Keeps private key secure on server
- Works with existing architecture

**Cons:**
- Need to manually construct order requests
- More complex implementation

### Option 2: Client-Side Order Placement
Move ClobClient to browser (like example):
1. Initialize ClobClient in frontend
2. Use user's wallet/signer (if available)
3. Place orders directly from browser

**Pros:**
- Matches example implementation
- No Cloudflare blocking
- Simpler architecture

**Cons:**
- Requires user wallet connection
- Private key management complexity
- May not work with our current wallet setup

### Option 3: Enhanced Proxy with Browser Headers
Create a proxy that adds proper browser headers to ClobClient requests:
1. Intercept ClobClient's HTTP requests
2. Add browser-like headers
3. Use a proxy service or VPN

**Pros:**
- Minimal code changes
- Works with existing ClobClient

**Cons:**
- ClobClient uses axios internally - hard to intercept
- May not fully bypass Cloudflare

## Recommended Implementation: Option 1 - Full Proxy Endpoint

### Implementation Plan

#### Step 1: Create Order Proxy Endpoint
Create `/api/orders-proxy.ts` that:
- Receives order parameters (tokenId, size, side, etc.)
- Constructs the order object
- Signs the order using the private key
- Makes HTTP request to CLOB API with proper headers
- Returns the response

#### Step 2: Add Browser-Like Headers
Include headers that make the request look like it's from a browser:
```typescript
{
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
  'Origin': 'https://polymarket.com',
  'Referer': 'https://polymarket.com/',
}
```

#### Step 3: Handle Authentication
- Use User API Credentials for authentication
- Use Builder credentials for attribution
- Sign orders properly with EIP-712

#### Step 4: Error Handling
- Detect Cloudflare blocks (403 with HTML response)
- Retry with exponential backoff
- Return clear error messages

### Technical Details

#### Order Construction
Based on ClobClient's internal implementation:
1. Create order object with all required fields
2. Sign the order using EIP-712
3. Add builder attribution headers
4. Make POST request to `/order` endpoint

#### Headers Required
- `POLY_ADDRESS`: User's proxy address
- `POLY_SIGNATURE`: EIP-712 signature
- `POLY_TIMESTAMP`: Signature timestamp
- `POLY_API_KEY`: User API key
- `POLY_PASSPHRASE`: User API passphrase
- `POLY_BUILDER_SIGNATURE`: Builder HMAC signature
- `POLY_BUILDER_TIMESTAMP`: Builder timestamp
- `POLY_BUILDER_API_KEY`: Builder API key
- `POLY_BUILDER_PASSPHRASE`: Builder passphrase

### Code Structure

```
api/
  orders-proxy.ts          # New proxy endpoint
  orders.ts                 # Keep existing (fallback)
  polymarket/
    sign.ts                 # Builder signing (existing)
```

### Implementation Steps

1. **Create orders-proxy.ts**
   - Manual order construction
   - Browser-like headers
   - Proper signing
   - Error handling

2. **Update trading-manager.ts**
   - Use new proxy endpoint
   - Handle responses
   - Error handling

3. **Test**
   - Verify orders go through
   - Check Cloudflare bypass
   - Monitor logs

## Alternative: Use Proxy Service

If manual implementation is too complex, consider:
- **Bright Data** (formerly Luminati)
- **Smartproxy**
- **Oxylabs**
- **ScraperAPI**

These services provide rotating IPs and Cloudflare bypass.

## Root Cause Analysis

### Why the Example Works
The example codebase (`wallet-connection/magic-safe-builder-example`) works because:
- **ClobClient runs in the browser** (client-side JavaScript)
- HTTP requests come from **user's IP address** (not serverless function IP)
- Browser automatically includes proper headers, cookies, and fingerprinting
- Cloudflare sees legitimate browser traffic

### Why Our Implementation Fails
Our implementation fails because:
- **ClobClient runs in Vercel serverless function** (server-side)
- HTTP requests come from **Vercel IP addresses** (AWS/GCP data centers)
- These IPs are flagged by Cloudflare as bot traffic
- Missing browser fingerprinting and headers

### The Fundamental Problem
The `@polymarket/clob-client` library uses `axios` internally to make HTTP requests. We cannot:
- Easily intercept or modify these requests
- Add custom headers to the axios instance
- Change the source IP address

## Practical Solutions

### Solution 1: Client-Side Order Placement (Best - Matches Example)
Move ClobClient to the browser, similar to the example:

**Implementation:**
1. Initialize ClobClient in frontend with user's wallet/signer
2. Place orders directly from browser
3. Use remote signing endpoint for builder attribution

**Pros:**
- ✅ Matches example implementation exactly
- ✅ No Cloudflare blocking (user's IP)
- ✅ Simpler architecture
- ✅ Better user experience

**Cons:**
- ⚠️ Requires user wallet connection
- ⚠️ Need to handle private key or use Magic Link
- ⚠️ Requires refactoring current implementation

### Solution 2: Contact Polymarket Support
Request IP whitelisting for Vercel serverless functions:

**Steps:**
1. Get Vercel IP ranges (AWS/GCP)
2. Contact Polymarket support
3. Request whitelisting for your builder API key
4. Provide use case and documentation

**Pros:**
- ✅ No code changes needed
- ✅ Works with existing implementation
- ✅ Official solution

**Cons:**
- ⚠️ Requires Polymarket cooperation
- ⚠️ May take time to implement
- ⚠️ IP ranges may change

### Solution 3: Use Proxy Service
Use a residential proxy service that bypasses Cloudflare:

**Services:**
- Bright Data (formerly Luminati)
- Smartproxy
- Oxylabs
- ScraperAPI

**Implementation:**
1. Route ClobClient requests through proxy
2. Proxy provides residential IPs
3. Cloudflare sees legitimate traffic

**Pros:**
- ✅ Works with existing code
- ✅ Reliable bypass
- ✅ No Polymarket changes needed

**Cons:**
- ⚠️ Additional cost
- ⚠️ May add latency
- ⚠️ Need to configure proxy

### Solution 4: Manual Order Construction (Complex)
Manually construct order requests with EIP-712 signing:

**Implementation:**
1. Create order object
2. Sign with EIP-712
3. Make HTTP request with browser headers
4. Handle builder attribution

**Pros:**
- ✅ Full control over headers
- ✅ Can bypass Cloudflare
- ✅ No external dependencies

**Cons:**
- ❌ Very complex implementation
- ❌ Error-prone (EIP-712 signing)
- ❌ Need to maintain order format
- ❌ May break with API changes

## Recommended Approach

**Short-term:** Use Solution 2 (Contact Polymarket) + Solution 3 (Proxy Service) as fallback

**Long-term:** Migrate to Solution 1 (Client-Side) to match the example

## Implementation Status

1. ✅ Created `CLOUDFLARE_BYPASS_PLAN.md` with analysis
2. ✅ Enhanced error handling in `api/orders.ts` with retry logic
3. ✅ Added detailed logging for Cloudflare detection
4. ⏳ Created `api/orders-proxy.ts` (needs manual order construction for full bypass)
5. ⏳ Update trading manager to use proxy endpoint

## Next Steps

1. **Immediate:** Contact Polymarket support to whitelist Vercel IPs
2. **Short-term:** Implement proxy service as fallback
3. **Long-term:** Consider migrating to client-side order placement (like example)
