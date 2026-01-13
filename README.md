# BTC/USD Streaming Platform

A real-time BTC/USD price streaming platform using Polymarket's Real-Time Data Socket (RTDS) with automated trading capabilities.

## Features

- Real-time BTC/USD price updates from Polymarket
- Chainlink oracle network data source
- Automatic reconnection on connection loss
- Price change indicators
- Modern, responsive UI
- BTC Up/Down 15m events tracking
- Active event display with countdown timer
- Price to Beat tracking for events
- Event details (Condition ID, Question ID, CLOB Token IDs)
- Automated trading with configurable strategies
- Real-time UP/DOWN token price monitoring

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser and navigate to `http://localhost:3000`

### Usage

1. Click "Connect" to start streaming BTC/USD prices
2. View real-time price updates in the main display
3. Monitor active BTC Up/Down 15m events
4. Configure and enable automated trading strategies
5. Click "Disconnect" to stop streaming

## Project Structure

```
polymarket-streaming/
├── src/                          # Frontend source code
│   ├── main.ts                   # Application entry point
│   ├── streaming-platform.ts     # Main platform orchestrator
│   ├── websocket-client.ts       # WebSocket client for RTDS
│   ├── event-manager.ts          # Event loading and management
│   ├── trading-manager.ts        # Automated trading logic
│   ├── polymarket-api.ts         # Polymarket API client
│   ├── clob-client.ts            # CLOB API wrapper
│   ├── event-utils.ts            # Event utility functions
│   ├── types.ts                  # TypeScript type definitions
│   ├── trading-types.ts          # Trading-specific types
│   └── styles.css                # Application styles
├── api/                          # Backend API (Vercel serverless functions)
│   ├── polymarket/
│   │   └── [...path].ts           # Polymarket API proxy
│   ├── clob-proxy.ts             # CLOB API proxy
│   ├── hello.ts                  # Test endpoint
│   └── test.ts                   # Test endpoint
├── index.html                    # HTML template
├── package.json                  # Project dependencies
├── tsconfig.json                 # TypeScript configuration
├── vite.config.ts                # Vite configuration
└── vercel.json                   # Vercel deployment config
```

## Architecture Documentation

### Frontend Architecture

#### Core Components

**1. StreamingPlatform (`src/streaming-platform.ts`)**
- Main orchestrator class that coordinates all components
- Manages UI rendering and user interactions
- Handles price updates and event tracking
- Coordinates between WebSocket client, Event Manager, and Trading Manager

**Key Responsibilities:**
- Initialize and render the UI
- Handle user interactions (connect/disconnect, trading controls)
- Update price displays and event information
- Manage countdown timers for active events
- Track "Price to Beat" for events
- Update UP/DOWN token prices in real-time

**2. WebSocketClient (`src/websocket-client.ts`)**
- Manages WebSocket connection to Polymarket RTDS
- Handles subscription to BTC/USD price feed
- Implements automatic reconnection logic
- Sends ping messages to keep connection alive

**Key Methods:**
- `connect()`: Establish WebSocket connection
- `disconnect()`: Close connection
- `setCallbacks()`: Register price update and status change handlers
- `isConnected()`: Check connection status

**3. EventManager (`src/event-manager.ts`)**
- Loads and manages BTC Up/Down 15m events
- Fetches event data from Polymarket API
- Tracks event status (active, expired, upcoming)
- Auto-refreshes events periodically

**Key Methods:**
- `loadEvents(count)`: Load specified number of events
- `getEvents()`: Get all loaded events
- `getCurrentEventIndex()`: Get index of active event
- `startAutoRefresh(interval)`: Start automatic event refresh

**4. TradingManager (`src/trading-manager.ts`)**
- Implements automated trading strategies
- Monitors market conditions and places limit orders
- Tracks positions and manages exits (profit target/stop loss)
- Maintains trade history and statistics

**Key Features:**
- Configurable entry price, profit target, and stop loss
- Automatic direction selection (UP or DOWN based on price)
- Limit order placement and monitoring
- Position tracking with unrealized P/L
- Trade history with profit/loss calculations

**5. PolymarketAPI (`src/polymarket-api.ts`)**
- Client for Polymarket Gamma API
- Fetches event data by slug
- Handles API response parsing and field extraction
- Manages CORS through proxy endpoints

**6. CLOBClientWrapper (`src/clob-client.ts`)**
- Wrapper around Polymarket CLOB Client SDK
- Provides price fetching functionality
- Handles order book queries
- Note: Currently read-only (no order placement implemented)

#### Data Flow

1. **Price Streaming:**
   ```
   WebSocketClient → PriceUpdate → StreamingPlatform → UI Update
   ```

2. **Event Loading:**
   ```
   EventManager → PolymarketAPI → Backend Proxy → Polymarket API
   EventManager → EventDisplayData → StreamingPlatform → UI Render
   ```

3. **Trading:**
   ```
   TradingManager → CLOBClientWrapper → Backend Proxy → CLOB API
   TradingManager → Trade → StreamingPlatform → UI Update
   ```

#### State Management

- **Price State**: Managed in `StreamingPlatform` (currentPrice, priceHistory)
- **Event State**: Managed in `EventManager` (events array, currentEventIndex)
- **Trading State**: Managed in `TradingManager` (strategy config, trades, positions)
- **Connection State**: Managed in `WebSocketClient` (connection status, errors)

### Backend Architecture

#### API Endpoints (Vercel Serverless Functions)

**1. Polymarket API Proxy (`api/polymarket/[...path].ts`)**
- **Purpose**: Proxy requests to Polymarket Gamma API to avoid CORS issues
- **Route**: `/api/polymarket/*`
- **Method**: GET, POST, PUT, DELETE, OPTIONS
- **Target**: `https://gamma-api.polymarket.com`

**Features:**
- Catch-all route handler for any Polymarket API path
- CORS headers for cross-origin requests
- Query parameter forwarding
- Error handling and logging

**Example Usage:**
```
GET /api/polymarket/events/slug/btc-updown-15m-1234567890
→ Proxies to: https://gamma-api.polymarket.com/events/slug/btc-updown-15m-1234567890
```

**2. CLOB API Proxy (`api/clob-proxy.ts`)**
- **Purpose**: Proxy requests to Polymarket CLOB API for price data
- **Route**: `/api/clob-proxy`
- **Method**: GET, OPTIONS
- **Target**: `https://clob.polymarket.com/price`

**Query Parameters:**
- `side`: "BUY" or "SELL"
- `token_id`: CLOB token ID

**Example Usage:**
```
GET /api/clob-proxy?side=BUY&token_id=0x123...
→ Proxies to: https://clob.polymarket.com/price?side=BUY&token_id=0x123...
```

**Response Format:**
```json
{
  "price": "0.96",
  "size": "1000"
}
```

#### Development vs Production

**Development (Vite Dev Server):**
- Uses Vite proxy configuration in `vite.config.ts`
- Proxies `/api/polymarket/*` and `/api/clob-proxy` to backend
- No serverless functions needed locally

**Production (Vercel):**
- Uses Vercel serverless functions
- Functions deployed automatically from `api/` directory
- Runtime: `@vercel/node@5.5.16`

### Configuration

#### Vite Configuration (`vite.config.ts`)
- Development server on port 3000
- Proxy configuration for API endpoints
- Automatic browser opening

#### Vercel Configuration (`vercel.json`)
- Serverless function runtime configuration
- Build command and output directory
- Function routing rules

### Data Models

#### PriceUpdate
```typescript
{
  topic: string;           // "crypto_prices_chainlink"
  type: string;            // Message type
  timestamp: number;       // Unix timestamp
  payload: {
    symbol: string;        // "btc/usd"
    timestamp: number;     // Price timestamp
    value: number;         // BTC/USD price
  }
}
```

#### EventDisplayData
```typescript
{
  slug: string;            // Event slug (e.g., "btc-updown-15m-1234567890")
  title: string;           // Event title
  startDate: string;       // ISO date string
  endDate: string;        // ISO date string
  status: 'active' | 'expired' | 'upcoming';
  conditionId?: string;    // Polymarket condition ID
  questionId?: string;    // Polymarket question ID
  clobTokenIds?: string[]; // CLOB token IDs [UP, DOWN]
  formattedStartDate: string;
  formattedEndDate: string;
  timestamp: number;       // Unix timestamp
  lastPrice?: number;      // Price at end of previous event
}
```

#### Trade
```typescript
{
  id: string;              // Unique trade ID
  eventSlug: string;       // Associated event
  tokenId: string;         // CLOB token ID
  side: 'BUY' | 'SELL';
  size: number;            // Trade size in USD
  price: number;           // Execution price (0-100 scale)
  timestamp: number;       // Unix timestamp
  status: 'pending' | 'filled' | 'cancelled' | 'failed';
  reason: string;          // Trade reason/description
  orderType: 'LIMIT' | 'MARKET';
  limitPrice?: number;     // Limit order price
  direction?: 'UP' | 'DOWN';
  profit?: number;         // Profit/loss in USD
  transactionHash?: string;
}
```

#### StrategyConfig
```typescript
{
  enabled: boolean;         // Strategy enabled flag
  entryPrice: number;      // Entry price (0-100 scale)
  profitTargetPrice: number; // Take profit price (0-100)
  stopLossPrice: number;   // Stop loss price (0-100)
  tradeSize: number;       // Trade size in USD
  priceDifference?: number | null; // Optional: Only trade when |Price to Beat - Current BTC Price| equals this value (in USD)
}
```

## Technologies

### Frontend
- **TypeScript**: Type-safe JavaScript
- **Vite**: Fast build tool and dev server
- **WebSocket**: Real-time communication with Polymarket RTDS
- **@polymarket/clob-client**: Polymarket CLOB SDK

### Backend
- **Vercel Serverless Functions**: API proxy endpoints
- **@vercel/node**: Node.js runtime for serverless functions

## Data Sources

### Chainlink Price Feed
- **Topic**: `crypto_prices_chainlink`
- **Symbol**: `btc/usd`
- **Format**: Slash-separated pairs
- **WebSocket Endpoint**: `wss://ws-live-data.polymarket.com`
- Provides reliable BTC/USD price data from Chainlink oracle networks

### Polymarket APIs
- **Gamma API**: `https://gamma-api.polymarket.com` - Event data
- **CLOB API**: `https://clob.polymarket.com` - Market data and trading

## Trading Strategy

The platform supports automated trading with the following strategy:

### Basic Strategy

1. **Entry**: Place limit order when UP or DOWN token price reaches entry price (default: 96)
2. **Direction**: Automatically selects UP or DOWN based on which reaches entry price first
3. **Exit Conditions**:
   - **Profit Target**: Sell when price reaches profit target (default: 100)
   - **Stop Loss**: Sell when price drops to stop loss (default: 91)
4. **Position Management**: Tracks unrealized P/L and manages exits automatically

### Price Difference Strategy (Optional)

The platform includes an optional **Price Difference** condition that adds an additional filter before placing trades:

- **Price Difference**: When configured, the strategy only activates when the absolute difference between "Price to Beat" and "Current BTC Price" equals the configured Price Difference value.
- **Condition**: `|Price to Beat - Current BTC Price| == Price Difference`
- **Behavior**: 
  - If Price Difference is set, trading only occurs when this condition is met
  - If Price Difference is empty/not set, the strategy works normally without this condition
  - Once the condition is met, normal trading logic applies:
    - Place limit order when UP/DOWN token reaches entry price
    - Exit when price reaches profit target (entire position sold for take profit)

**Example:**
- Price to Beat: $50,000
- Current BTC Price: $50,100
- Price Difference: $100
- Condition: |$50,000 - $50,100| = $100 ✓ (condition met, trading enabled)
- If Current BTC Price was $50,050, condition would not be met (difference is $50, not $100)

## Development

### Running Locally

#### Option 1: Frontend Only (Limited Functionality)

```bash
# Install dependencies
npm install

# Start dev server (frontend only)
npm run dev
```

**Note**: Wallet connection and trading features require API routes. Use Option 2 for full functionality.

#### Option 2: Full Stack (Recommended)

For full functionality including wallet connection and trading:

```bash
# Install dependencies
npm install

# Install Vercel CLI globally (if not already installed)
npm install -g vercel

# In one terminal - Run Vercel dev server (handles API routes)
vercel dev

# In another terminal - Run Vite dev server (handles frontend)
npm run dev
```

The Vercel dev server will handle API routes (wallet, orders, etc.) while Vite handles the frontend.

#### Build for Production

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

### Environment Variables

No environment variables required for basic functionality. For production trading, you may need:
- Private key or wallet connection for order placement
- API keys (if required by Polymarket)

## Deployment

### Vercel Deployment

The project is configured for Vercel deployment:

1. Push code to GitHub
2. Connect repository to Vercel
3. Deploy automatically

The `vercel.json` configuration handles:
- Serverless function routing
- Build commands
- Output directory

## API Reference

### Frontend API

#### StreamingPlatform Methods
- `initialize()`: Initialize the platform and load events
- `render()`: Render the UI
- `handlePriceUpdate(update)`: Process price updates
- `handleStatusChange(status)`: Handle connection status changes

#### EventManager Methods
- `loadEvents(count)`: Load events from API
- `getEvents()`: Get all events
- `getCurrentEventIndex()`: Get active event index
- `startAutoRefresh(interval)`: Start auto-refresh

#### TradingManager Methods
- `startTrading()`: Start automated trading
- `stopTrading()`: Stop trading
- `setStrategyConfig(config)`: Update strategy configuration
- `getStatus()`: Get trading status
- `getTrades()`: Get trade history

### Backend API

#### GET `/api/polymarket/*`
Proxies requests to Polymarket Gamma API.

#### GET `/api/clob-proxy`
Proxies requests to Polymarket CLOB API for price data.

**Query Parameters:**
- `side`: "BUY" or "SELL" (required)
- `token_id`: CLOB token ID (required)

## Additional Documentation

For detailed information on data fetching mechanisms, see:
- **[Data Fetching Documentation](./DATA_FETCHING_DOCUMENTATION.md)** - Complete guide on how Price to Beat, CLOB Token IDs, and UP/DOWN prices are fetched

## License

MIT

#   p o l y m a r k e t - w i t h - w a l l e t  
 #   p o l y m a r k e t - w a l l e t - c o n n e c t e d  
 