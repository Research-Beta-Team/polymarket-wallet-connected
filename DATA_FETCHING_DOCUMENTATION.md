# Data Fetching Documentation

Complete documentation on how Price to Beat, CLOB Token IDs, and UP/DOWN prices are fetched and managed in the application.

## Table of Contents

1. [Price to Beat](#price-to-beat)
2. [CLOB Token IDs](#clob-token-ids)
3. [UP/DOWN Prices](#updown-prices)
4. [Data Flow Diagrams](#data-flow-diagrams)
5. [API Endpoints](#api-endpoints)

---

## Price to Beat

### Overview

**Price to Beat** is the BTC/USD price at the moment an event becomes active. It serves as the reference price for determining whether the BTC price has moved up or down during the event period.

### How It's Captured

#### 1. **Initial Capture** (`capturePriceForActiveEvent()`)

**Location**: `src/streaming-platform.ts:155-161`

```typescript
private capturePriceForActiveEvent(): void {
  if (this.currentPrice === null) return;

  const events = this.eventManager.getEvents();
  const activeEvent = events.find(e => e.status === 'active');
  
  if (activeEvent) {
    // If we don't have a price to beat for this event yet, capture it
    if (!this.eventPriceToBeat.has(activeEvent.slug)) {
      this.eventPriceToBeat.set(activeEvent.slug, this.currentPrice);
      // Re-render active event to show the price
      this.renderActiveEvent();
    }
  }
}
```

**Process**:
1. Checks if there's a current BTC price available (from WebSocket stream)
2. Finds the currently active event
3. If no Price to Beat exists for this event, captures the current BTC price
4. Stores it in `eventPriceToBeat` Map with event slug as key

#### 2. **When It's Called**

- **On Price Updates**: Every time a new BTC price arrives via WebSocket (`handlePriceUpdate()`)
- **On Event Load**: When events are loaded and an active event is found
- **On Event Status Change**: When an event transitions from "upcoming" to "active"

#### 3. **Storage**

**Data Structure**: `Map<string, number>`
- **Key**: Event slug (e.g., `"btc-updown-15m-1234567890"`)
- **Value**: BTC/USD price in USD (e.g., `50000.50`)

**Location**: `src/streaming-platform.ts:21`
```typescript
private eventPriceToBeat: Map<string, number> = new Map();
```

#### 4. **Usage**

- **Display**: Shown in the active event display as "Price to Beat: $50,000.00"
- **Trading Strategy**: Used in Price Difference strategy to determine if trading should activate
- **Event Table**: Displayed in the events table for reference

#### 5. **Retrieval**

```typescript
// Get price to beat for active event
const events = this.eventManager.getEvents();
const activeEvent = events.find(e => e.status === 'active');
const priceToBeat = activeEvent ? this.eventPriceToBeat.get(activeEvent.slug) : null;
```

### Data Source

The Price to Beat uses the **current BTC/USD price** from the WebSocket stream:
- **Source**: Polymarket Real-Time Data Socket (RTDS)
- **Topic**: `crypto_prices_chainlink`
- **Symbol**: `btc/usd`
- **Format**: Real-time price updates via WebSocket

---

## CLOB Token IDs

### Overview

**CLOB Token IDs** are unique identifiers for the UP (YES) and DOWN (NO) tokens in a Polymarket event. These tokens represent the two possible outcomes of the prediction market.

### How They're Fetched

#### 1. **Event Loading Flow**

**Step 1: Generate Event Slugs**
- **Location**: `src/event-manager.ts:106-114`
- Generates event slugs based on 15-minute intervals
- Format: `btc-updown-15m-{timestamp}`

**Step 2: Fetch Event Data from Polymarket API**
- **Location**: `src/polymarket-api.ts:36-60`
- **Endpoint**: `/api/polymarket/events/slug/{slug}`
- **Backend Proxy**: `api/polymarket/[...path].ts`
- **Target API**: `https://gamma-api.polymarket.com/events/slug/{slug}`

**Request Example**:
```typescript
GET /api/polymarket/events/slug/btc-updown-15m-1234567890
```

**Response Structure** (from Polymarket API):
```json
{
  "slug": "btc-updown-15m-1234567890",
  "title": "BTC Up/Down 15m - ...",
  "markets": [
    {
      "clobTokenIds": ["0x123...", "0x456..."],
      "tokens": [
        { "token_id": "0x123..." },
        { "token_id": "0x456..." }
      ],
      "conditionId": "0x789...",
      "questionID": "0xabc..."
    }
  ]
}
```

#### 2. **Token ID Extraction**

**Location**: `src/polymarket-api.ts:99-210`

The extraction logic tries multiple locations in the API response:

**Priority Order**:
1. **`markets[0].clobTokenIds`** (array or JSON string)
2. **`markets[0].tokens[]`** (extract `token_id`, `tokenId`, or `id` from each token)
3. **Top-level `clobTokenIds`** (array or JSON string)
4. **Top-level `clob_token_ids`** (array or JSON string)
5. **Top-level `tokens[]`** (extract token IDs)
6. **`outcomes[]`** (extract token IDs)

**Extraction Code**:
```typescript
const extractClobTokenIds = (d: any): string[] | undefined => {
  // Check markets array first (most common location)
  if (d.markets && Array.isArray(d.markets) && d.markets.length > 0) {
    const market = d.markets[0];
    
    // Try clobTokenIds in market
    if (market.clobTokenIds) {
      if (Array.isArray(market.clobTokenIds)) {
        return market.clobTokenIds;
      } else if (typeof market.clobTokenIds === 'string') {
        return JSON.parse(market.clobTokenIds);
      }
    }
    
    // Try tokens array in market
    if (market.tokens && Array.isArray(market.tokens)) {
      const tokenIds = market.tokens
        .map((t: any) => t.token_id || t.tokenId || t.id || t.clobTokenId)
        .filter(Boolean);
      if (tokenIds.length > 0) {
        return tokenIds;
      }
    }
  }
  
  // ... fallback to other locations
};
```

#### 3. **Storage in Event Data**

**Location**: `src/event-manager.ts:30-104`

After extraction, token IDs are stored in `EventDisplayData`:

```typescript
interface EventDisplayData {
  slug: string;
  clobTokenIds?: string[];  // [UP token ID, DOWN token ID]
  // ... other fields
}
```

**Token Order**:
- **Index 0**: UP token (YES token) - represents BTC price going up
- **Index 1**: DOWN token (NO token) - represents BTC price going down

#### 4. **Usage**

Token IDs are used for:
- Fetching UP/DOWN token prices
- Placing trades (limit orders)
- Displaying in the UI (event details)

### API Endpoints

#### Frontend → Backend Proxy
```
GET /api/polymarket/events/slug/{slug}
```

#### Backend Proxy → Polymarket API
```
GET https://gamma-api.polymarket.com/events/slug/{slug}
```

**Headers**:
- `Accept: application/json`
- `User-Agent: Mozilla/5.0`

**Response**: JSON object with event data including markets and tokens

---

## UP/DOWN Prices

### Overview

**UP/DOWN Prices** are the current market prices for the UP (YES) and DOWN (NO) tokens, displayed on a 0-100 scale (representing probability/price in cents).

### How They're Fetched

#### 1. **Price Update Flow**

**Location**: `src/streaming-platform.ts:357-415`

**Process**:
1. Get active event and extract CLOB token IDs
2. Fetch prices for both tokens in parallel
3. Convert prices from decimal (0-1) to percentage (0-100) scale
4. Update UI display

#### 2. **Fetching Prices**

**Method**: `updateUpDownPrices()`

```typescript
private async updateUpDownPrices(): Promise<void> {
  const events = this.eventManager.getEvents();
  const activeEvent = events.find(e => e.status === 'active');

  if (!activeEvent || !activeEvent.clobTokenIds || activeEvent.clobTokenIds.length < 2) {
    this.upPrice = null;
    this.downPrice = null;
    return;
  }

  const upTokenId = activeEvent.clobTokenIds[0];   // First token = UP
  const downTokenId = activeEvent.clobTokenIds[1]; // Second token = DOWN

  // Fetch prices in parallel
  const [upPriceResult, downPriceResult] = await Promise.all([
    fetch(`/api/clob-proxy?side=BUY&token_id=${upTokenId}`),
    fetch(`/api/clob-proxy?side=BUY&token_id=${downTokenId}`),
  ]);
}
```

#### 3. **API Request Details**

**Frontend Request**:
```
GET /api/clob-proxy?side=BUY&token_id={tokenId}
```

**Query Parameters**:
- `side`: `"BUY"` (always BUY to get the price to buy the token)
- `token_id`: CLOB token ID (e.g., `"0x123..."`)

**Backend Proxy** (`api/clob-proxy.ts`):
- Validates parameters
- Forwards request to CLOB API
- Handles CORS

**CLOB API Request**:
```
GET https://clob.polymarket.com/price?side=BUY&token_id={tokenId}
```

**Response Format**:
```json
{
  "price": "0.96",
  "size": "1000"
}
```

#### 4. **Price Conversion**

**Location**: `src/streaming-platform.ts:384, 396`

Prices are converted from decimal (0-1) to percentage (0-100) scale:

```typescript
// API returns: { price: "0.96" } (decimal format, 0-1)
// Convert to: 96 (percentage format, 0-100)
this.upPrice = upData.price ? parseFloat(upData.price) * 100 : null;
this.downPrice = downData.price ? parseFloat(downData.price) * 100 : null;
```

**Display Format**:
- Stored as: `96` (number, 0-100 scale)
- Displayed as: `96¢` (cents format)

#### 5. **Update Frequency**

**Location**: `src/streaming-platform.ts:468-476`

Prices are updated:
- **Immediately**: When active event changes
- **Periodically**: Every 1 second via `setInterval`

```typescript
private startPriceUpdates(): void {
  this.stopPriceUpdates();
  // Update immediately
  this.updateUpDownPrices();
  // Then update every 1 second
  this.priceUpdateInterval = window.setInterval(() => {
    this.updateUpDownPrices();
  }, 1000);
}
```

#### 6. **Fallback Mechanism**

**Location**: `src/streaming-platform.ts:413-437`

If the proxy fails, the system attempts a direct API call:

```typescript
private async fetchPriceDirectly(tokenId: string, type: 'up' | 'down'): Promise<void> {
  const response = await fetch(`https://clob.polymarket.com/price?side=BUY&token_id=${tokenId}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    mode: 'cors',
  });
  // ... handle response
}
```

### Storage

**Location**: `src/streaming-platform.ts:23-24`

```typescript
private upPrice: number | null = null;   // Current UP token price (0-100 scale)
private downPrice: number | null = null; // Current DOWN token price (0-100 scale)
```

### Display

**Location**: `src/streaming-platform.ts:442-463`

Prices are displayed in the active event section:
- **UP Price**: Shows current price to buy UP token (e.g., `96¢`)
- **DOWN Price**: Shows current price to buy DOWN token (e.g., `4¢`)

**Formatting**:
```typescript
private formatUpDownPrice(price: number): string {
  const cents = Math.round(price);
  return `${cents}¢`;
}
```

---

## Data Flow Diagrams

### Price to Beat Flow

```
WebSocket Stream (BTC/USD Price)
    ↓
handlePriceUpdate()
    ↓
capturePriceForActiveEvent()
    ↓
Check if active event exists
    ↓
Store in eventPriceToBeat Map
    ↓
Display in UI
```

### CLOB Token IDs Flow

```
EventManager.loadEvents()
    ↓
Generate event slugs (15-min intervals)
    ↓
PolymarketAPI.fetchEventBySlug(slug)
    ↓
GET /api/polymarket/events/slug/{slug}
    ↓
Backend Proxy → Polymarket Gamma API
    ↓
Extract clobTokenIds from response
    ↓
Store in EventDisplayData
    ↓
Available in activeEvent.clobTokenIds[]
```

### UP/DOWN Prices Flow

```
startPriceUpdates() (every 1 second)
    ↓
updateUpDownPrices()
    ↓
Get activeEvent.clobTokenIds
    ↓
Parallel fetch:
  GET /api/clob-proxy?side=BUY&token_id={upTokenId}
  GET /api/clob-proxy?side=BUY&token_id={downTokenId}
    ↓
Backend Proxy → CLOB API
    ↓
Parse response: { price: "0.96" }
    ↓
Convert: 0.96 * 100 = 96
    ↓
Store in upPrice / downPrice
    ↓
Update UI display
```

---

## API Endpoints

### 1. Polymarket Event API (via Proxy)

**Endpoint**: `GET /api/polymarket/events/slug/{slug}`

**Backend Handler**: `api/polymarket/[...path].ts`

**Target**: `https://gamma-api.polymarket.com/events/slug/{slug}`

**Response Fields Used**:
- `markets[0].clobTokenIds` or `markets[0].tokens[]`
- `conditionId` / `condition_id`
- `questionID` / `questionId`

### 2. CLOB Price API (via Proxy)

**Endpoint**: `GET /api/clob-proxy`

**Backend Handler**: `api/clob-proxy.ts`

**Query Parameters**:
- `side`: `"BUY"` or `"SELL"` (required)
- `token_id`: CLOB token ID (required)

**Target**: `https://clob.polymarket.com/price?side={side}&token_id={token_id}`

**Response**:
```json
{
  "price": "0.96",  // Decimal format (0-1)
  "size": "1000"    // Available size
}
```

### 3. WebSocket Price Stream

**Endpoint**: `wss://ws-live-data.polymarket.com`

**Subscription**:
```json
{
  "action": "subscribe",
  "subscriptions": [
    {
      "topic": "crypto_prices_chainlink",
      "type": "*",
      "filters": "{\"symbol\":\"btc/usd\"}"
    }
  ]
}
```

**Message Format**:
```json
{
  "topic": "crypto_prices_chainlink",
  "type": "update",
  "timestamp": 1234567890,
  "payload": {
    "symbol": "btc/usd",
    "timestamp": 1234567890,
    "value": 50000.50
  }
}
```

---

## Error Handling

### Price to Beat
- If `currentPrice` is `null`, capture is skipped
- If no active event exists, no capture occurs
- Already captured prices are not overwritten

### CLOB Token IDs
- If API returns 404, event is marked as `null`
- Extraction tries multiple fallback locations
- If extraction fails, `clobTokenIds` remains `undefined`
- Events without token IDs cannot fetch UP/DOWN prices

### UP/DOWN Prices
- If proxy fails, attempts direct API call
- If both fail, prices remain `null` and display as `"--"`
- Missing token IDs prevent price fetching
- Network errors are logged but don't crash the app

---

## Summary

1. **Price to Beat**: Captured from WebSocket BTC/USD stream when event becomes active
2. **CLOB Token IDs**: Fetched from Polymarket Gamma API via proxy, extracted from nested response structure
3. **UP/DOWN Prices**: Fetched from CLOB API via proxy every 1 second, converted from decimal to percentage scale

All data flows through backend proxy endpoints to avoid CORS issues and provide a unified API interface.
