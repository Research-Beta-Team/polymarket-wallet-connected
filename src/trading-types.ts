export interface StrategyConfig {
  enabled: boolean;
  // Entry price for limit order (0-100 scale for Polymarket binary markets)
  entryPrice: number; // e.g., 96
  // Profit target price (0-100 scale)
  profitTargetPrice: number; // e.g., 100
  // Stop loss price (0-100 scale)
  stopLossPrice: number; // e.g., 91
  // Trade size (in USD)
  tradeSize: number;
  // Price Difference (in USD) - Strategy only activates when |Price to Beat - Current BTC Price| equals this value
  // If not set (null/undefined), strategy works without this condition
  priceDifference?: number | null; // e.g., 100 (only trade if BTC price moved $100 from Price to Beat)
  // Direction is automatically determined by which token (UP/DOWN) reaches entry price first
}

export interface Trade {
  id: string;
  eventSlug: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number; // Price in 0-100 scale
  timestamp: number;
  status: 'pending' | 'filled' | 'failed' | 'cancelled';
  transactionHash?: string;
  profit?: number;
  reason: string; // Why the trade was executed
  orderType: 'LIMIT' | 'MARKET';
  limitPrice?: number; // Limit price if orderType is LIMIT
  direction?: 'UP' | 'DOWN'; // Direction determined automatically (UP = YES token, DOWN = NO token)
}

export interface TradingStatus {
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
    entryPrice: number; // Average entry price in 0-100 scale (weighted by size)
    size: number; // Total position size in USD
    currentPrice?: number; // Price in 0-100 scale
    unrealizedProfit?: number;
    direction?: 'UP' | 'DOWN'; // Direction (UP = YES token, DOWN = NO token)
    filledOrders?: Array<{
      orderId: string;
      price: number; // Fill price in 0-100 scale
      size: number; // Size in USD
      timestamp: number;
    }>; // Track individual filled orders for large positions
  };
}

export interface TradeExecutionResult {
  success: boolean;
  trade?: Trade;
  error?: string;
  transactionHash?: string;
}
