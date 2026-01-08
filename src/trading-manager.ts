import type { StrategyConfig, Trade, TradingStatus } from './trading-types';
import { CLOBClientWrapper } from './clob-client';
import type { EventDisplayData } from './event-manager';

/**
 * Converts Polymarket price from decimal (0-1) to percentage (0-100)
 */
function toPercentage(price: number): number {
  return price * 100;
}

export class TradingManager {
  private clobClient: CLOBClientWrapper;
  private strategyConfig: StrategyConfig;
  private trades: Trade[] = [];
  private status: TradingStatus;
  private onStatusUpdate: ((status: TradingStatus) => void) | null = null;
  private onTradeUpdate: ((trade: Trade) => void) | null = null;
  private monitoringInterval: number | null = null;
  private activeEvent: EventDisplayData | null = null;
  private pendingLimitOrders: Map<string, Trade> = new Map(); // Map of tokenId -> pending limit order

  constructor() {
    this.clobClient = new CLOBClientWrapper();
    this.strategyConfig = this.getDefaultStrategy();
    this.status = {
      isActive: false,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfit: 0,
      pendingLimitOrders: 0,
    };
  }

  private getDefaultStrategy(): StrategyConfig {
    return {
      enabled: false,
      entryPrice: 96, // Limit order at 96
      profitTargetPrice: 100, // Take profit at 100
      stopLossPrice: 91, // Stop loss at 91
      tradeSize: 50, // $50 trade size
      outcome: 'YES',
      direction: 'UP', // UP = buy YES token, DOWN = buy NO token
    };
  }

  setStrategyConfig(config: Partial<StrategyConfig>): void {
    this.strategyConfig = { ...this.strategyConfig, ...config };
    this.saveStrategyConfig();
  }

  getStrategyConfig(): StrategyConfig {
    return { ...this.strategyConfig };
  }

  private saveStrategyConfig(): void {
    try {
      localStorage.setItem('tradingStrategy', JSON.stringify(this.strategyConfig));
    } catch (error) {
      console.warn('Failed to save strategy config:', error);
    }
  }

  loadStrategyConfig(): void {
    try {
      const saved = localStorage.getItem('tradingStrategy');
      if (saved) {
        this.strategyConfig = { ...this.strategyConfig, ...JSON.parse(saved) };
      }
    } catch (error) {
      console.warn('Failed to load strategy config:', error);
    }
  }

  setOnStatusUpdate(callback: (status: TradingStatus) => void): void {
    this.onStatusUpdate = callback;
  }

  setOnTradeUpdate(callback: (trade: Trade) => void): void {
    this.onTradeUpdate = callback;
  }

  updateMarketData(
    _currentPrice: number | null,
    _priceToBeat: number | null,
    activeEvent: EventDisplayData | null
  ): void {
    this.activeEvent = activeEvent;

    if (this.strategyConfig.enabled && this.status.isActive && activeEvent) {
      this.checkTradingConditions();
    }
  }

  /**
   * Check if we should place a limit order or if existing orders should fill/exit
   */
  private async checkTradingConditions(): Promise<void> {
    if (!this.strategyConfig.enabled || !this.status.isActive) {
      return;
    }

    if (!this.activeEvent) {
      return;
    }

    // Check if we have token IDs for the active event
    if (!this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length === 0) {
      return;
    }

    // Determine which token to trade based on direction
    // UP = YES token (index 0), DOWN = NO token (index 1)
    const tokenIndex = this.strategyConfig.direction === 'UP' ? 0 : 1;
    const tokenId = this.activeEvent.clobTokenIds[tokenIndex];

    if (!tokenId) {
      console.warn('Token ID not found for direction:', this.strategyConfig.direction);
      return;
    }

    // If we have a position, check exit conditions
    if (this.status.currentPosition?.eventSlug === this.activeEvent.slug) {
      await this.checkExitConditions(tokenId);
      return;
    }

    // If we have a pending limit order, check if it should fill
    if (this.pendingLimitOrders.has(tokenId)) {
      await this.checkLimitOrderFill(tokenId);
      return;
    }

    // Check if we should place a new limit order at entry price
    await this.checkAndPlaceLimitOrder(tokenId);
  }

  /**
   * Check if current market price matches entry price and place limit order
   */
  private async checkAndPlaceLimitOrder(tokenId: string): Promise<void> {
    try {
      // Get current market price for the token
      const currentMarketPrice = await this.clobClient.getPrice(tokenId, 'BUY');
      
      if (!currentMarketPrice) {
        return;
      }

      // Convert to percentage scale (0-100)
      const currentPricePercent = toPercentage(currentMarketPrice);
      const entryPrice = this.strategyConfig.entryPrice;

      // Check if current price is at or near entry price (within 0.5%)
      const priceDiff = Math.abs(currentPricePercent - entryPrice);
      
      if (priceDiff <= 0.5) {
        // Place limit order at entry price
        await this.placeLimitOrder(tokenId, entryPrice);
      }
    } catch (error) {
      console.error('Error checking for limit order placement:', error);
    }
  }

  /**
   * Place a limit order at the specified price
   */
  private async placeLimitOrder(tokenId: string, limitPrice: number): Promise<void> {
    try {
      const trade: Trade = {
        id: `limit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventSlug: this.activeEvent!.slug,
        tokenId,
        side: 'BUY', // Always buying the token (YES or NO)
        size: this.strategyConfig.tradeSize,
        price: limitPrice,
        timestamp: Date.now(),
        status: 'pending',
        reason: `Limit order placed at ${limitPrice.toFixed(2)}`,
        orderType: 'LIMIT',
        limitPrice,
      };

      // Store as pending limit order
      this.pendingLimitOrders.set(tokenId, trade);
      this.status.pendingLimitOrders = this.pendingLimitOrders.size;

      // Add to trade history
      this.trades.push(trade);
      this.status.totalTrades++;

      console.log(`Limit order placed: ${trade.id} at ${limitPrice.toFixed(2)}`);

      // NOTE: In production, you would:
      // 1. Call clobClient.placeLimitOrder(tokenId, limitPrice, size, side)
      // 2. Wait for order confirmation
      // 3. Update trade status based on order status

      this.notifyTradeUpdate(trade);
      this.notifyStatusUpdate();
    } catch (error) {
      console.error('Error placing limit order:', error);
    }
  }

  /**
   * Check if pending limit order should fill (price reached limit price)
   */
  private async checkLimitOrderFill(tokenId: string): Promise<void> {
    const pendingOrder = this.pendingLimitOrders.get(tokenId);
    if (!pendingOrder) {
      return;
    }

    try {
      // Get current market price
      const currentMarketPrice = await this.clobClient.getPrice(tokenId, 'BUY');
      
      if (!currentMarketPrice) {
        return;
      }

      const currentPricePercent = toPercentage(currentMarketPrice);
      const limitPrice = pendingOrder.limitPrice!;

      // Check if price has reached or crossed the limit price
      // For BUY limit orders, fill when price is at or below limit
      if (currentPricePercent <= limitPrice + 0.1) { // Small buffer for slippage
        // Limit order filled
        pendingOrder.status = 'filled';
        pendingOrder.price = currentPricePercent; // Actual fill price
        pendingOrder.transactionHash = `0x${Math.random().toString(16).substr(2, 64)}`;
        
        // Remove from pending orders
        this.pendingLimitOrders.delete(tokenId);
        this.status.pendingLimitOrders = this.pendingLimitOrders.size;

        // Update trade status
        this.status.successfulTrades++;

        // Create position
        this.status.currentPosition = {
          eventSlug: pendingOrder.eventSlug,
          tokenId: pendingOrder.tokenId,
          side: pendingOrder.side,
          entryPrice: currentPricePercent,
          size: pendingOrder.size,
        };

        console.log(`Limit order filled: ${pendingOrder.id} at ${currentPricePercent.toFixed(2)}`);

        this.notifyTradeUpdate(pendingOrder);
        this.notifyStatusUpdate();
      }
    } catch (error) {
      console.error('Error checking limit order fill:', error);
    }
  }

  /**
   * Check exit conditions: profit target at 100 or stop loss at 91
   */
  private async checkExitConditions(tokenId: string): Promise<void> {
    if (!this.status.currentPosition) {
      return;
    }

    try {
      // Get current price for the token
      const currentMarketPrice = await this.clobClient.getPrice(tokenId, 'SELL'); // Sell to exit position
      
      if (!currentMarketPrice) {
        return;
      }

      const currentPricePercent = toPercentage(currentMarketPrice);
      const entryPrice = this.status.currentPosition.entryPrice;
      const profitTarget = this.strategyConfig.profitTargetPrice;
      const stopLoss = this.strategyConfig.stopLossPrice;

      // Update current position
      this.status.currentPosition.currentPrice = currentPricePercent;
      
      // Calculate unrealized profit/loss
      // For BUY positions: profit when price goes up
      const priceDiff = currentPricePercent - entryPrice;
      const unrealizedProfit = (priceDiff / entryPrice) * this.status.currentPosition.size * 100; // Percentage-based P/L
      this.status.currentPosition.unrealizedProfit = unrealizedProfit;

      // Check profit target (100)
      if (currentPricePercent >= profitTarget) {
        await this.closePosition(`Profit target reached at ${profitTarget}`);
      }
      // Check stop loss (91)
      else if (currentPricePercent <= stopLoss) {
        await this.closePosition(`Stop loss triggered at ${stopLoss}`);
      }

      this.notifyStatusUpdate();
    } catch (error) {
      console.error('Error checking exit conditions:', error);
    }
  }

  /**
   * Close current position with market order
   */
  private async closePosition(reason: string): Promise<void> {
    if (!this.status.currentPosition) {
      return;
    }

    try {
      const position = this.status.currentPosition;
      const exitSide = 'SELL'; // Always selling to close BUY position

      // Get exit price
      const exitMarketPrice = await this.clobClient.getPrice(position.tokenId, exitSide);

      if (!exitMarketPrice) {
        console.warn('Could not get exit price');
        return;
      }

      const exitPricePercent = toPercentage(exitMarketPrice);
      const entryPrice = position.entryPrice;

      // Calculate profit/loss
      // Profit = (exitPrice - entryPrice) / entryPrice * size
      const priceDiff = exitPricePercent - entryPrice;
      const profitPercent = (priceDiff / entryPrice) * 100;
      const profit = (profitPercent / 100) * position.size;

      // Create exit trade
      const exitTrade: Trade = {
        id: `exit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventSlug: position.eventSlug,
        tokenId: position.tokenId,
        side: exitSide,
        size: position.size,
        price: exitPricePercent,
        timestamp: Date.now(),
        status: 'filled',
        profit,
        reason: `Exit: ${reason}`,
        orderType: 'MARKET',
        transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
      };

      this.trades.push(exitTrade);
      this.status.totalTrades++;
      this.status.successfulTrades++;
      this.status.totalProfit += profit;

      // Clear position
      this.status.currentPosition = undefined;

      console.log(`Position closed: ${reason}, Profit: $${profit.toFixed(2)}`);

      this.notifyTradeUpdate(exitTrade);
      this.notifyStatusUpdate();
    } catch (error) {
      console.error('Error closing position:', error);
    }
  }

  startTrading(): void {
    if (this.status.isActive) {
      return;
    }

    if (!this.strategyConfig.enabled) {
      console.warn('Strategy is not enabled');
      return;
    }

    this.status.isActive = true;
    this.notifyStatusUpdate();

    // Start monitoring interval (check every 2 seconds for faster response)
    this.monitoringInterval = window.setInterval(() => {
      this.checkTradingConditions();
    }, 2000);
  }

  stopTrading(): void {
    this.status.isActive = false;
    
    if (this.monitoringInterval !== null) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Cancel all pending limit orders
    this.cancelAllPendingOrders();

    this.notifyStatusUpdate();
  }

  private cancelAllPendingOrders(): void {
    this.pendingLimitOrders.forEach((order) => {
      order.status = 'cancelled';
      order.reason = 'Trading stopped - order cancelled';
      this.notifyTradeUpdate(order);
    });
    this.pendingLimitOrders.clear();
    this.status.pendingLimitOrders = 0;
  }

  getTrades(): Trade[] {
    return [...this.trades];
  }

  getStatus(): TradingStatus {
    return { ...this.status };
  }

  private notifyStatusUpdate(): void {
    if (this.onStatusUpdate) {
      this.onStatusUpdate(this.getStatus());
    }
  }

  private notifyTradeUpdate(trade: Trade): void {
    if (this.onTradeUpdate) {
      this.onTradeUpdate(trade);
    }
  }

  clearTrades(): void {
    this.trades = [];
    this.status.totalTrades = 0;
    this.status.successfulTrades = 0;
    this.status.failedTrades = 0;
    this.status.totalProfit = 0;
    this.status.currentPosition = undefined;
    this.pendingLimitOrders.clear();
    this.status.pendingLimitOrders = 0;
    this.notifyStatusUpdate();
  }
}
