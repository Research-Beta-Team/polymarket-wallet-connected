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
    entryPrice: number; // Price in 0-100 scale
    size: number;
    currentPrice?: number; // Price in 0-100 scale
    unrealizedProfit?: number;
    direction?: 'UP' | 'DOWN'; // Direction (UP = YES token, DOWN = NO token)
  };
}

export interface TradeExecutionResult {
  success: boolean;
  trade?: Trade;
  error?: string;
  transactionHash?: string;
}
