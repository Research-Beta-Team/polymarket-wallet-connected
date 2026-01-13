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
  private currentPrice: number | null = null; // Current BTC/USD price
  private priceToBeat: number | null = null; // Price to Beat for active event
  private apiCredentials: { key: string; secret: string; passphrase: string } | null = null; // API credentials for order placement

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
    currentPrice: number | null,
    priceToBeat: number | null,
    activeEvent: EventDisplayData | null
  ): void {
    this.currentPrice = currentPrice;
    this.priceToBeat = priceToBeat;
    this.activeEvent = activeEvent;

    if (this.strategyConfig.enabled && this.status.isActive && activeEvent) {
      this.checkTradingConditions();
    }
  }

  /**
   * Set API credentials for order placement
   */
  setApiCredentials(credentials: { key: string; secret: string; passphrase: string } | null): void {
    this.apiCredentials = credentials;
  }

  /**
   * Get API credentials
   */
  getApiCredentials(): { key: string; secret: string; passphrase: string } | null {
    return this.apiCredentials;
  }

  /**
   * Check if we should place a limit order or if existing orders should fill/exit
   * Monitors both UP (YES) and DOWN (NO) tokens and places order on whichever reaches entry price first
   */
  private async checkTradingConditions(): Promise<void> {
    if (!this.strategyConfig.enabled || !this.status.isActive) {
      return;
    }

    if (!this.activeEvent) {
      return;
    }

    // Check Price Difference condition if configured
    if (this.strategyConfig.priceDifference !== null && this.strategyConfig.priceDifference !== undefined) {
      if (this.currentPrice === null || this.priceToBeat === null) {
        // Need both prices to check condition
        return;
      }

      const priceDiff = Math.abs(this.priceToBeat - this.currentPrice);
      const targetDiff = this.strategyConfig.priceDifference;
      const threshold = 0.01; // Small threshold for floating point comparison

      // Only proceed if price difference matches (within threshold)
      if (Math.abs(priceDiff - targetDiff) > threshold) {
        // Price difference condition not met, skip trading
        return;
      }
    }

    // Check if we have token IDs for the active event
    if (!this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
    const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

    if (!yesTokenId || !noTokenId) {
      return;
    }

    // If we have a position, check exit conditions
    if (this.status.currentPosition?.eventSlug === this.activeEvent.slug) {
      const positionTokenId = this.status.currentPosition.tokenId;
      await this.checkExitConditions(positionTokenId);
      return;
    }

    // Check pending limit orders for both tokens
    if (this.pendingLimitOrders.has(yesTokenId)) {
      await this.checkLimitOrderFill(yesTokenId);
      return;
    }
    if (this.pendingLimitOrders.has(noTokenId)) {
      await this.checkLimitOrderFill(noTokenId);
      return;
    }

    // Check both tokens and place limit order on whichever reaches entry price first
    await this.checkAndPlaceLimitOrder(yesTokenId, noTokenId);
  }

  /**
   * Check both UP and DOWN tokens and place limit order on whichever reaches entry price first
   */
  private async checkAndPlaceLimitOrder(yesTokenId: string, noTokenId: string): Promise<void> {
    try {
      const entryPrice = this.strategyConfig.entryPrice;

      // Get current market prices for both tokens
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'BUY'),
        this.clobClient.getPrice(noTokenId, 'BUY'),
      ]);

      if (!yesPrice || !noPrice) {
        return;
      }

      // Convert to percentage scale (0-100)
      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      // Calculate distance from entry price for both tokens
      const yesDistance = Math.abs(yesPricePercent - entryPrice);
      const noDistance = Math.abs(noPricePercent - entryPrice);

      // Determine which token is closer to or at entry price (within 0.5%)
      const threshold = 0.5;
      let tokenToTrade: string | null = null;
      let direction: 'UP' | 'DOWN' | null = null;

      if (yesDistance <= threshold && noDistance <= threshold) {
        // Both are at entry price, choose the one that's closer
        if (yesDistance <= noDistance) {
          tokenToTrade = yesTokenId;
          direction = 'UP';
        } else {
          tokenToTrade = noTokenId;
          direction = 'DOWN';
        }
      } else if (yesDistance <= threshold) {
        // YES token is at entry price
        tokenToTrade = yesTokenId;
        direction = 'UP';
      } else if (noDistance <= threshold) {
        // NO token is at entry price
        tokenToTrade = noTokenId;
        direction = 'DOWN';
      }

      // Place limit order on whichever token reached entry price first
      if (tokenToTrade && direction) {
        await this.placeLimitOrder(tokenToTrade, entryPrice, direction);
      }
    } catch (error) {
      console.error('Error checking for limit order placement:', error);
    }
  }

  /**
   * Place a limit order at the specified price
   * Uses API if credentials are available, otherwise simulates
   */
  private async placeLimitOrder(tokenId: string, limitPrice: number, direction: 'UP' | 'DOWN'): Promise<void> {
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
        reason: `Limit order placed at ${limitPrice.toFixed(2)} (${direction})`,
        orderType: 'LIMIT',
        limitPrice,
      };

      // If API credentials are available, place real order
      if (this.apiCredentials) {
        try {
          // Convert price from 0-100 scale to 0-1 decimal
          const decimalPrice = limitPrice / 100;
          
          // Calculate shares from USD size (size / price)
          const shares = this.strategyConfig.tradeSize / decimalPrice;

          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              tokenId,
              price: decimalPrice,
              size: shares,
              side: 'BUY',
              isMarketOrder: false,
              apiCredentials: this.apiCredentials,
              negRisk: false,
            }),
          });

          const data = await response.json();

          if (response.ok && data.orderId) {
            trade.status = 'filled';
            trade.transactionHash = data.orderId;
            trade.reason = `Real order placed: ${data.orderId} at ${limitPrice.toFixed(2)} (${direction})`;
            console.log(`Real limit order placed: ${data.orderId} at ${limitPrice.toFixed(2)}`);
            this.status.successfulTrades++;
          } else {
            trade.status = 'failed';
            trade.reason = `Order failed: ${data.error || 'Unknown error'}`;
            console.error('Order placement failed:', data.error);
            this.status.failedTrades++;
          }
        } catch (apiError) {
          console.error('Error placing real order:', apiError);
          trade.status = 'failed';
          trade.reason = `API error: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`;
          this.status.failedTrades++;
        }
      } else {
        // Simulation mode - store as pending limit order
        this.pendingLimitOrders.set(tokenId, trade);
        this.status.pendingLimitOrders = this.pendingLimitOrders.size;
        console.log(`Simulated limit order placed: ${trade.id} at ${limitPrice.toFixed(2)}`);
      }

      // Add to trade history
      this.trades.push(trade);
      this.status.totalTrades++;

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

        // Determine direction based on which token this is
        const direction = this.activeEvent?.clobTokenIds?.[0] === tokenId ? 'UP' : 'DOWN';
        
        // Create position
        this.status.currentPosition = {
          eventSlug: pendingOrder.eventSlug,
          tokenId: pendingOrder.tokenId,
          side: pendingOrder.side,
          entryPrice: currentPricePercent,
          size: pendingOrder.size,
          direction,
        };
        
        // Update trade with direction
        pendingOrder.direction = direction;

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
   * Uses API if credentials are available, otherwise simulates
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
        status: 'pending',
        profit,
        reason: `Exit: ${reason}`,
        orderType: 'MARKET',
      };

      // If API credentials are available, place real market order
      if (this.apiCredentials) {
        try {
          // Calculate shares from USD size
          const decimalPrice = exitPricePercent / 100;
          const shares = position.size / decimalPrice;

          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              tokenId: position.tokenId,
              size: shares,
              side: 'SELL',
              isMarketOrder: true,
              apiCredentials: this.apiCredentials,
              negRisk: false,
            }),
          });

          const data = await response.json();

          if (response.ok && data.orderId) {
            exitTrade.status = 'filled';
            exitTrade.transactionHash = data.orderId;
            exitTrade.reason = `Real exit order: ${data.orderId} - ${reason}`;
            console.log(`Real exit order placed: ${data.orderId} for ${reason}`);
            this.status.successfulTrades++;
          } else {
            exitTrade.status = 'failed';
            exitTrade.reason = `Exit failed: ${data.error || 'Unknown error'}`;
            console.error('Exit order placement failed:', data.error);
            this.status.failedTrades++;
          }
        } catch (apiError) {
          console.error('Error placing real exit order:', apiError);
          exitTrade.status = 'failed';
          exitTrade.reason = `API error: ${apiError instanceof Error ? apiError.message : 'Unknown error'}`;
          this.status.failedTrades++;
        }
      } else {
        // Simulation mode
        exitTrade.status = 'filled';
        exitTrade.transactionHash = `0x${Math.random().toString(16).substr(2, 64)}`;
        exitTrade.reason = `Simulated exit: ${reason}`;
        console.log(`Simulated position closed: ${reason}, Profit: $${profit.toFixed(2)}`);
        this.status.successfulTrades++;
      }

      this.trades.push(exitTrade);
      this.status.totalTrades++;
      this.status.totalProfit += profit;

      // Clear position
      this.status.currentPosition = undefined;

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
