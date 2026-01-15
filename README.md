# Polymarket BTC/USD Automated Trading Platform

A comprehensive real-time BTC/USD price streaming and automated trading platform built on Polymarket's infrastructure. This platform provides real-time price monitoring, automated trading strategies, wallet integration, and order management for Polymarket's BTC Up/Down 15-minute binary markets.

## 🚀 Features

### Core Features
- ✅ **Real-time Price Streaming**: Live BTC/USD price updates via Polymarket RTDS WebSocket
- ✅ **Event Tracking**: Automatic tracking of BTC Up/Down 15-minute binary markets
- ✅ **Automated Trading**: Configurable trading strategies with entry/exit conditions
- ✅ **Wallet Integration**: Magic Link wallet connection with proxy wallet support
- ✅ **Browser-side Order Placement**: Client-side order execution bypassing Cloudflare protection
- ✅ **Order Management**: Real-time order tracking, manual sell controls, and position management
- ✅ **Price Monitoring**: Live UP/DOWN token price display with automatic updates
- ✅ **Trade History**: Complete trade history with profit/loss tracking
- ✅ **Position Tracking**: Real-time position monitoring with unrealized P/L calculation

### Trading Features
- ✅ **Range-based Entry**: Enter positions when price is within `[entryPrice, entryPrice + 1]`
- ✅ **Automatic Direction Selection**: Automatically trades UP or DOWN based on price conditions
- ✅ **Order Splitting**: Large orders (>$50) automatically split across price range
- ✅ **Profit Target**: Automatic exit when profit target is reached
- ✅ **Stop Loss**: Adaptive stop loss with progressive price attempts
- ✅ **Price Difference Filter**: Optional condition based on BTC price movement

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Trading Strategy](#trading-strategy)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Documentation](#documentation)

## 🛠️ Installation

### Prerequisites

- **Node.js**: v18 or higher
- **npm**: v8 or higher (or yarn)
- **Vercel CLI** (for local development with API routes): `npm install -g vercel`

### Install Dependencies

```bash
npm install
```

## 🚀 Quick Start

### Development Mode

#### Option 1: Frontend Only (Limited Functionality)
```bash
npm run dev
```
Opens at `http://localhost:3000`

**Note**: Wallet connection and trading require API routes. Use Option 2 for full functionality.

#### Option 2: Full Stack (Recommended)
```bash
# Terminal 1: Start Vercel dev server (handles API routes)
vercel dev

# Terminal 2: Start Vite dev server (handles frontend)
npm run dev
```

### Production Build

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the root directory:

```env
# Required for trading
POLYMARKET_MAGIC_PK=your_private_key_here

# Optional: Polygon RPC URL (defaults to public RPC)
POLYGON_RPC_URL=https://polygon-rpc.com
```

### Trading Strategy Configuration

Configure your trading strategy in the UI:

1. **Entry Price** (0-100): Price range for entering positions
   - Bot enters when `entryPrice <= price <= entryPrice + 1`
   - Default: `96`

2. **Profit Target** (0-100): Price to exit with profit
   - Sells when price reaches this value
   - Default: `100`

3. **Stop Loss** (0-100): Price to exit with loss
   - Sells when price drops to this value (with adaptive selling)
   - Default: `91`

4. **Trade Size** (USD): Amount to trade per position
   - Large trades (>$50) are automatically split
   - Default: `50`

5. **Price Difference** (USD, Optional): Additional filter condition
   - Only trades when `|Price to Beat - Current BTC Price| == Price Difference`
   - Leave empty to disable

## 📈 Trading Strategy

### Entry Conditions

The bot enters positions when:
- **UP Token**: `yesPricePercent >= entryPrice && yesPricePercent <= entryPrice + 1`
- **DOWN Token**: `noPricePercent >= entryPrice && noPricePercent <= entryPrice + 1`
- **Direction**: Automatically selects UP or DOWN based on which token reaches entry range first

### Exit Conditions

#### Profit Target
- **UP Direction**: Sells when `yesPricePercent >= profitTarget`
- **DOWN Direction**: Sells when `noPricePercent >= profitTarget`
- **Execution**: Immediate market order (FAK)

#### Stop Loss
- **UP Direction**: Sells when `yesPricePercent <= stopLoss`
- **DOWN Direction**: Sells when `noPricePercent <= stopLoss`
- **Execution**: 
  1. Attempts immediate sell at current market price
  2. Falls back to adaptive selling (progressive price attempts: `stopLoss`, `stopLoss-1`, `stopLoss-2`, etc.)
  3. Final fallback: Market price sell

### Order Splitting

For large trade sizes (>$50 USD):
- **Buy Orders**: Split across `entryPrice`, `entryPrice + 1`, `entryPrice + 2`
- **Sell Orders**: Split into 3 equal parts
- **Average Entry Price**: Weighted average calculated automatically

### Price Monitoring

- **Entry/Exit Conditions**: Uses BUY side prices for condition checking
- **Order Execution**: 
  - BUY orders: Uses BUY side prices
  - SELL orders: Uses SELL side prices
- **Update Frequency**: Every 2 seconds

## 🏗️ Architecture

### Core Components

#### 1. StreamingPlatform (`src/streaming-platform.ts`)
Main orchestrator managing UI, user interactions, and component coordination.

**Key Responsibilities:**
- UI rendering and updates
- Wallet connection management
- Order display and management
- Price display updates
- Event countdown timers

#### 2. TradingManager (`src/trading-manager.ts`)
Automated trading logic and strategy execution.

**Key Features:**
- Entry/exit condition monitoring
- Order placement and execution
- Position tracking
- Trade history management
- Profit/loss calculations

#### 3. WebSocketClient (`src/websocket-client.ts`)
Real-time price streaming via Polymarket RTDS.

**Features:**
- WebSocket connection management
- Automatic reconnection
- Ping/pong keepalive
- Price update callbacks

#### 4. EventManager (`src/event-manager.ts`)
BTC Up/Down 15-minute event management.

**Features:**
- Event loading and caching
- Status tracking (active/expired/upcoming)
- Auto-refresh
- Token ID extraction

#### 5. CLOBClientWrapper (`src/clob-client.ts`)
Price fetching and market data wrapper.

#### 6. PolymarketAPI (`src/polymarket-api.ts`)
Event data fetching from Polymarket Gamma API.

### Data Flow

```
WebSocket → PriceUpdate → StreamingPlatform → UI Update
EventManager → PolymarketAPI → Event Data → UI Render
TradingManager → CLOBClient → Price Check → Order Placement
Browser ClobClient → Order Execution → Trade Update → UI Refresh
```

### Backend API (Vercel Serverless Functions)

#### `/api/orders`
- **GET**: Fetch user orders
- **POST**: Create orders (BUY/SELL, LIMIT/MARKET)
- **DELETE**: Cancel orders

#### `/api/wallet/*`
- `/initialize`: Initialize trading session
- `/balance`: Get wallet balance
- `/private-key`: Get private key (for browser ClobClient)

#### `/api/polymarket/*`
- Proxy to Polymarket Gamma API (CORS bypass)

#### `/api/polymarket/sign`
- Remote builder signing endpoint

## 🔌 API Reference

### TradingManager Methods

```typescript
// Start automated trading
tradingManager.startTrading()

// Stop trading
tradingManager.stopTrading()

// Update strategy configuration
tradingManager.setStrategyConfig({
  enabled: true,
  entryPrice: 96,
  profitTargetPrice: 100,
  stopLossPrice: 91,
  tradeSize: 50,
  priceDifference: null
})

// Get trading status
const status = tradingManager.getStatus()

// Get trade history
const trades = tradingManager.getTrades()

// Clear trade history
tradingManager.clearTrades()
```

### StrategyConfig Interface

```typescript
interface StrategyConfig {
  enabled: boolean;
  entryPrice: number;           // 0-100 scale
  profitTargetPrice: number;    // 0-100 scale
  stopLossPrice: number;        // 0-100 scale
  tradeSize: number;            // USD
  priceDifference?: number | null; // Optional USD filter
}
```

### TradingStatus Interface

```typescript
interface TradingStatus {
  isActive: boolean;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: number;
  pendingLimitOrders: number;
  currentPosition?: {
    eventSlug: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    size: number;
    currentPrice?: number;
    unrealizedProfit?: number;
    direction?: 'UP' | 'DOWN';
    filledOrders?: Array<{
      orderId: string;
      price: number;
      size: number;
      timestamp: number;
    }>;
  };
}
```

## 🚢 Deployment

### Vercel Deployment

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Deploy to Vercel"
   git push origin main
   ```

2. **Connect to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Import your GitHub repository
   - Configure environment variables:
     - `POLYMARKET_MAGIC_PK`: Your private key
     - `POLYGON_RPC_URL`: (Optional) Custom RPC URL

3. **Deploy**
   - Vercel automatically deploys on push
   - Or manually deploy from Vercel dashboard

### Environment Variables

Set these in Vercel dashboard:
- `POLYMARKET_MAGIC_PK`: Required for trading
- `POLYGON_RPC_URL`: Optional, defaults to public RPC

## 🐛 Troubleshooting

### Common Issues

#### 1. Wallet Connection Fails
**Problem**: Cannot connect wallet or initialize session

**Solutions**:
- Check browser console for errors
- Verify `POLYMARKET_MAGIC_PK` is set correctly
- Ensure API routes are accessible (check Vercel deployment)
- Try clearing browser cache

#### 2. Orders Not Placing
**Problem**: Orders fail to place or return no order ID

**Solutions**:
- Check API credentials are set correctly
- Verify wallet is connected and initialized
- Check browser console for Cloudflare errors
- Ensure browser ClobClient is initialized

#### 3. Price Updates Not Showing
**Problem**: Prices not updating in real-time

**Solutions**:
- Check WebSocket connection status
- Verify "Connect" button is clicked
- Check browser console for WebSocket errors
- Try disconnecting and reconnecting

#### 4. Entry Conditions Not Triggering
**Problem**: Bot not entering positions when conditions are met

**Solutions**:
- Verify strategy is enabled
- Check entry price range is correct
- Ensure active event has token IDs
- Check console logs for entry condition checks
- Verify price difference condition (if set)

#### 5. Build Errors
**Problem**: `npm run build` fails

**Solutions**:
- Run `npm install` to ensure dependencies are installed
- Check TypeScript errors: `npx tsc --noEmit`
- Clear `node_modules` and reinstall: `rm -rf node_modules && npm install`
- Check for version conflicts in `package.json`

### Debug Mode

Enable detailed logging by checking browser console:
- All trading operations are logged with `[TradingManager]` prefix
- Order operations logged with `[Orders]` prefix
- Price updates logged with `[WebSocket]` prefix

## 📁 Project Structure

```
polymarket-streaming/
├── src/                          # Frontend source code
│   ├── main.ts                   # Application entry point
│   ├── streaming-platform.ts     # Main platform orchestrator
│   ├── trading-manager.ts        # Automated trading logic
│   ├── websocket-client.ts       # WebSocket client
│   ├── event-manager.ts          # Event management
│   ├── polymarket-api.ts         # Polymarket API client
│   ├── clob-client.ts            # CLOB API wrapper
│   ├── clob-client-browser.ts   # Browser ClobClient utility
│   ├── event-utils.ts            # Event utilities
│   ├── types.ts                  # Type definitions
│   ├── trading-types.ts          # Trading types
│   └── styles.css                # Application styles
├── api/                          # Backend API (Vercel serverless)
│   ├── orders.ts                 # Order management
│   ├── wallet.ts                 # Wallet endpoints
│   ├── wallet/
│   │   ├── initialize.ts         # Session initialization
│   │   ├── balance.ts            # Balance fetching
│   │   └── private-key.ts        # Private key endpoint
│   ├── polymarket/
│   │   ├── [...path].ts          # Polymarket API proxy
│   │   └── sign.ts               # Builder signing
│   └── clob-proxy.ts             # CLOB API proxy
├── utils/                        # Utility functions
│   └── proxyWallet.ts            # Proxy wallet utilities
├── constants/                    # Constants
│   └── polymarket.ts             # Polymarket constants
├── index.html                    # HTML template
├── package.json                  # Dependencies
├── tsconfig.json                 # TypeScript config
├── vite.config.ts                # Vite configuration
├── vercel.json                   # Vercel deployment config
└── README.md                     # This file
```

## 📚 Documentation

### Additional Documentation Files

- **[CODEBASE_IMPROVEMENT_PLAN.md](./CODEBASE_IMPROVEMENT_PLAN.md)**: Comprehensive improvement plan
- **[TRADING_BOT_FLOW_EXAMPLES.md](./TRADING_BOT_FLOW_EXAMPLES.md)**: Detailed trading flow examples
- **[DATA_FETCHING_DOCUMENTATION.md](./DATA_FETCHING_DOCUMENTATION.md)**: Data fetching mechanisms
- **[WALLET_IMPLEMENTATION.md](./WALLET_IMPLEMENTATION.md)**: Wallet integration guide
- **[CLOUDFLARE_BYPASS_SOLUTION.md](./CLOUDFLARE_BYPASS_SOLUTION.md)**: Cloudflare bypass implementation
- **[VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md)**: Deployment guide
- **[LOCAL_DEVELOPMENT.md](./LOCAL_DEVELOPMENT.md)**: Local development setup

## 🔒 Security

### Best Practices

1. **Private Keys**: Never commit private keys to version control
2. **Environment Variables**: Use Vercel environment variables for secrets
3. **API Credentials**: Store securely, never expose in client-side code
4. **HTTPS**: Always use HTTPS in production
5. **CORS**: API routes handle CORS properly

### Wallet Security

- Private keys are stored server-side only
- Browser ClobClient uses remote signing
- Proxy wallet pattern for additional security
- No private keys exposed to client

## 🧪 Testing

### Manual Testing Checklist

- [ ] WebSocket connection establishes
- [ ] Price updates display correctly
- [ ] Events load and display
- [ ] Wallet connects successfully
- [ ] Trading session initializes
- [ ] Orders can be placed (BUY)
- [ ] Orders can be sold (SELL)
- [ ] Entry conditions trigger correctly
- [ ] Exit conditions trigger correctly
- [ ] Trade history displays correctly
- [ ] Position tracking works
- [ ] Unrealized P/L calculates correctly

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- **Polymarket**: For providing the trading infrastructure and APIs
- **Chainlink**: For reliable price oracle data
- **Vercel**: For serverless function hosting
- **Ethers.js & Viem**: For Ethereum/Polygon integration

## 📞 Support

For issues, questions, or contributions:
1. Check existing documentation files
2. Review troubleshooting section
3. Check browser console for errors
4. Open an issue on GitHub

## 🎯 Roadmap

### Completed ✅
- Real-time price streaming
- Automated trading strategies
- Wallet integration
- Browser-side order placement
- Order management
- Position tracking

### Planned 🔄
- Advanced order types (limit orders)
- Multiple strategy support
- Backtesting capabilities
- Performance analytics
- Mobile responsive UI
- Additional market support

---

**Built with ❤️ for the Polymarket community**
