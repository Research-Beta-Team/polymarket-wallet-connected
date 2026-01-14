import type { StrategyConfig, Trade, TradingStatus } from './trading-types';
import { CLOBClientWrapper } from './clob-client';
import type { EventDisplayData } from './event-manager';
import type { ClobClient } from '@polymarket/clob-client';

/**
 * Converts Polymarket price from decimal (0-1) to percentage (0-100)
 */
function toPercentage(price: number): number {
  return price * 100;
}

export class TradingManager {
  private clobClient: CLOBClientWrapper;
  private browserClobClient: ClobClient | null = null; // Browser ClobClient for order placement (bypasses Cloudflare)
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
  private isPlacingOrder: boolean = false; // Flag to prevent multiple simultaneous orders
  private isPlacingSplitOrders: boolean = false; // Flag to track if we're placing split orders

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
   * Set browser ClobClient for client-side order placement (bypasses Cloudflare)
   */
  setBrowserClobClient(clobClient: ClobClient | null): void {
    this.browserClobClient = clobClient;
    if (clobClient) {
      console.log('[TradingManager] Browser ClobClient set - orders will be placed from browser (bypasses Cloudflare)');
    } else {
      console.log('[TradingManager] Browser ClobClient cleared - will fall back to server-side API');
    }
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

    // Prevent multiple simultaneous orders
    if (this.isPlacingOrder) {
      return;
    }

    // Check pending limit orders for both tokens (legacy support - market orders are immediate)
    // Note: Market orders (FAK) execute immediately, so we don't need to check for pending orders
    // This check is kept for backward compatibility with any existing pending limit orders
    if (this.pendingLimitOrders.has(yesTokenId)) {
      await this.checkLimitOrderFill(yesTokenId);
      return;
    }
    if (this.pendingLimitOrders.has(noTokenId)) {
      await this.checkLimitOrderFill(noTokenId);
      return;
    }

    // Check both tokens and place market order (Fill or Kill) on whichever reaches entry price first
    // Market orders execute immediately with builder attribution via remote signing
    await this.checkAndPlaceMarketOrder(yesTokenId, noTokenId);
  }

  /**
   * Check both UP and DOWN tokens and place market order when price equals entry price
   * Order is filled when UP or DOWN value exactly equals entryPrice
   */
  private async checkAndPlaceMarketOrder(yesTokenId: string, noTokenId: string): Promise<void> {
    try {
      const entryPrice = this.strategyConfig.entryPrice;
      const priceTolerance = 0.1; // Small tolerance for floating point comparison

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

      // Check if either token price exactly equals entry price (with small tolerance)
      let tokenToTrade: string | null = null;
      let direction: 'UP' | 'DOWN' | null = null;

      // Check UP token first (YES token) - exact match
      if (Math.abs(yesPricePercent - entryPrice) <= priceTolerance) {
        tokenToTrade = yesTokenId;
        direction = 'UP';
      }
      // Check DOWN token (NO token) - exact match, only if UP token hasn't matched
      else if (Math.abs(noPricePercent - entryPrice) <= priceTolerance) {
        tokenToTrade = noTokenId;
        direction = 'DOWN';
      }

      // Place market order when price exactly equals entry price
      if (tokenToTrade && direction) {
        await this.placeMarketOrder(tokenToTrade, entryPrice, direction);
      }
    } catch (error) {
      console.error('Error checking for market order placement:', error);
    }
  }

  /**
   * Calculate order splits for large trade sizes
   * For tradeSize > 50 USD, split across entryPrice to entryPrice + 2
   */
  private calculateOrderSplits(tradeSize: number, entryPrice: number): Array<{ price: number; size: number }> {
    if (tradeSize <= 50) {
      // Single order at entry price
      return [{ price: entryPrice, size: tradeSize }];
    }

    // For large orders, split across entryPrice to entryPrice + 2
    const numSplits = 3; // Split into 3 orders: entryPrice, entryPrice + 1, entryPrice + 2
    const sizePerSplit = tradeSize / numSplits;

    const splits: Array<{ price: number; size: number }> = [];
    for (let i = 0; i < numSplits; i++) {
      splits.push({
        price: entryPrice + i,
        size: sizePerSplit,
      });
    }

    return splits;
  }

  /**
   * Calculate weighted average entry price from multiple filled orders
   */
  private calculateWeightedAverageEntryPrice(filledOrders: Array<{ price: number; size: number }>): number {
    if (filledOrders.length === 0) return 0;
    
    let totalValue = 0;
    let totalSize = 0;
    
    for (const order of filledOrders) {
      totalValue += order.price * order.size;
      totalSize += order.size;
    }
    
    return totalSize > 0 ? totalValue / totalSize : 0;
  }

  /**
   * Place a single market order (part of split orders for large trade sizes)
   */
  private async placeSingleMarketOrder(
    tokenId: string,
    targetPrice: number,
    orderSize: number,
    _direction: 'UP' | 'DOWN',
    orderIndex: number,
    totalOrders: number
  ): Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }> {
    try {
      if (!this.apiCredentials) {
        return { success: false, error: 'No API credentials' };
      }

      if (this.browserClobClient) {
        const { OrderType, Side } = await import('@polymarket/clob-client');
        
        // Get current market price
        const askPriceResponse = await this.browserClobClient.getPrice(tokenId, Side.SELL);
        const askPrice = parseFloat(askPriceResponse.price);
        
        if (isNaN(askPrice) || askPrice <= 0 || askPrice >= 1) {
          return { success: false, error: 'Invalid market price' };
        }

        // Get fee rate
        let feeRateBps: number;
        try {
          feeRateBps = await this.browserClobClient.getFeeRateBps(tokenId);
          if (!feeRateBps || feeRateBps === 0) {
            feeRateBps = 1000;
          }
        } catch (error) {
          feeRateBps = 1000;
        }

        const marketOrder = {
          tokenID: tokenId,
          amount: orderSize,
          side: Side.BUY,
          feeRateBps: feeRateBps,
        };

        console.log(`[TradingManager] Placing split order ${orderIndex + 1}/${totalOrders} at target price ${targetPrice.toFixed(2)}:`, {
          targetPrice: targetPrice.toFixed(2),
          currentPrice: toPercentage(askPrice).toFixed(2),
          orderSize: orderSize.toFixed(2),
        });

        const response = await this.browserClobClient.createAndPostMarketOrder(
          marketOrder,
          { negRisk: false },
          OrderType.FAK
        );

        if (response?.orderID) {
          return {
            success: true,
            orderId: response.orderID,
            fillPrice: toPercentage(askPrice),
          };
        } else {
          return { success: false, error: 'No order ID returned' };
        }
      } else {
        // Fallback to server-side API
        const askPrice = await this.clobClient.getPrice(tokenId, 'SELL');
        if (!askPrice || isNaN(askPrice) || askPrice <= 0 || askPrice >= 1) {
          return { success: false, error: 'Invalid market price' };
        }

        const shares = orderSize / askPrice;

        const response = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tokenId,
            size: shares,
            side: 'BUY',
            isMarketOrder: true,
            apiCredentials: this.apiCredentials,
            negRisk: false,
          }),
        });

        const data = await response.json();
        if (response.ok && data.orderId) {
          return {
            success: true,
            orderId: data.orderId,
            fillPrice: toPercentage(askPrice),
          };
        } else {
          return { success: false, error: data.error || 'Order failed' };
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Place a market order (Fill or Kill) when trading conditions match
   * For large trade sizes (>50 USD), splits orders across entryPrice to entryPrice + 2
   * Uses builder attribution via remote signing through /api/orders endpoint
   */
  private async placeMarketOrder(tokenId: string, entryPrice: number, direction: 'UP' | 'DOWN'): Promise<void> {
    // Prevent multiple simultaneous orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      console.log('[TradingManager] Order already being placed, skipping...');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    try {
      const tradeSize = this.strategyConfig.tradeSize;
      const orderSplits = this.calculateOrderSplits(tradeSize, entryPrice);
      const isLargeOrder = tradeSize > 50;

      console.log('[TradingManager] Placing market order:', {
        tokenId,
        direction,
        entryPrice,
        tradeSize,
        isLargeOrder,
        numSplits: orderSplits.length,
        splits: orderSplits,
      });

      if (!this.apiCredentials) {
        // Simulation mode
        const trade: Trade = {
          id: `market-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: this.activeEvent!.slug,
          tokenId,
          side: 'BUY',
          size: tradeSize,
          price: entryPrice,
          timestamp: Date.now(),
          status: 'filled',
          transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
          reason: `Simulated market order (FAK) filled at ${entryPrice.toFixed(2)} (${direction})`,
          orderType: 'MARKET',
          direction,
        };

        this.status.currentPosition = {
          eventSlug: trade.eventSlug,
          tokenId: trade.tokenId,
          side: trade.side,
          size: tradeSize,
          entryPrice: entryPrice,
          direction,
          filledOrders: [{ orderId: trade.transactionHash!, price: entryPrice, size: tradeSize, timestamp: Date.now() }],
        };

        this.trades.push(trade);
        this.status.totalTrades++;
        this.status.successfulTrades++;
        this.notifyTradeUpdate(trade);
        this.notifyStatusUpdate();
        return;
      }

      // Place real orders (single or split)
      const filledOrders: Array<{ orderId: string; price: number; size: number; timestamp: number }> = [];
      let totalFilledSize = 0;

      for (let i = 0; i < orderSplits.length; i++) {
        const split = orderSplits[i];
        const result = await this.placeSingleMarketOrder(
          tokenId,
          split.price,
          split.size,
          direction,
          i,
          orderSplits.length
        );

        if (result.success && result.orderId && result.fillPrice !== undefined) {
          filledOrders.push({
            orderId: result.orderId,
            price: result.fillPrice,
            size: split.size,
            timestamp: Date.now(),
          });
          totalFilledSize += split.size;

          // Create trade record for each filled order
          const trade: Trade = {
            id: `market-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`,
            eventSlug: this.activeEvent!.slug,
            tokenId,
            side: 'BUY',
            size: split.size,
            price: result.fillPrice,
            timestamp: Date.now(),
            status: 'filled',
            transactionHash: result.orderId,
            reason: `Market order ${isLargeOrder ? `(${i + 1}/${orderSplits.length}) ` : ''}filled at ${result.fillPrice.toFixed(2)} (${direction})`,
            orderType: 'MARKET',
            direction,
          };

          this.trades.push(trade);
          this.status.totalTrades++;
          this.notifyTradeUpdate(trade);
        } else {
          console.error(`[TradingManager] ❌ Split order ${i + 1}/${orderSplits.length} failed:`, result.error);
          // Continue with other orders even if one fails
        }

        // Small delay between split orders to avoid rate limiting
        if (i < orderSplits.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (filledOrders.length > 0) {
        // Calculate weighted average entry price
        const avgEntryPrice = this.calculateWeightedAverageEntryPrice(
          filledOrders.map(o => ({ price: o.price, size: o.size }))
        );

        // Create or update position
        this.status.currentPosition = {
          eventSlug: this.activeEvent!.slug,
          tokenId,
          side: 'BUY',
          size: totalFilledSize,
          entryPrice: avgEntryPrice,
          direction,
          filledOrders,
        };

        this.status.successfulTrades++;
        console.log('[TradingManager] ✅ Position created:', {
          direction,
          totalSize: totalFilledSize.toFixed(2),
          avgEntryPrice: avgEntryPrice.toFixed(2),
          numOrders: filledOrders.length,
        });
      } else {
        console.error('[TradingManager] ❌ All orders failed');
        this.status.failedTrades++;
      }

      this.notifyStatusUpdate();
    } catch (error) {
      console.error('[TradingManager] ❌ Error placing market order:', error);
      this.status.failedTrades++;
    } finally {
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
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
   * Check exit conditions: profit target and stop loss
   * For UP direction:
   *   - Profit Target: Sell when UP value exactly equals profit target
   *   - Stop Loss: Sell when UP value >= stop loss (with adaptive selling)
   * For DOWN direction:
   *   - Profit Target: Sell when DOWN value >= profit target
   *   - Stop Loss: Sell when DOWN value <= stop loss (with adaptive selling)
   */
  private async checkExitConditions(tokenId: string): Promise<void> {
    if (!this.status.currentPosition) {
      return;
    }

    // Prevent multiple simultaneous exit orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
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
      const priceTolerance = 0.1; // Small tolerance for floating point comparison
      const direction = this.status.currentPosition.direction;

      // Update current position
      this.status.currentPosition.currentPrice = currentPricePercent;
      
      // Calculate unrealized profit/loss properly
      // For UP direction: profit when price goes up (currentPrice > entryPrice)
      // For DOWN direction: profit when price goes down (currentPrice < entryPrice, but DOWN token price increases)
      let unrealizedProfit: number;
      if (direction === 'UP') {
        // UP token: profit when price increases
        const priceDiff = currentPricePercent - entryPrice;
        unrealizedProfit = (priceDiff / entryPrice) * this.status.currentPosition.size;
      } else {
        // DOWN token: profit when DOWN token price increases (which means BTC price goes down)
        // For DOWN, higher price = more profit
        const priceDiff = currentPricePercent - entryPrice;
        unrealizedProfit = (priceDiff / entryPrice) * this.status.currentPosition.size;
      }
      
      this.status.currentPosition.unrealizedProfit = unrealizedProfit;

      // Check exit conditions based on direction
      if (direction === 'UP') {
        // UP direction: 
        // - Profit target: exact match
        // - Stop loss: when UP price drops TO or BELOW stop loss (sell immediately or adaptive selling as fallback)
        if (Math.abs(currentPricePercent - profitTarget) <= priceTolerance) {
          await this.closePosition(`Profit target reached at ${currentPricePercent.toFixed(2)}`);
        } else if (currentPricePercent <= stopLoss) {
          // UP price dropped to stop loss - try to sell immediately, use adaptive selling as fallback
          console.log(`[TradingManager] UP stop loss triggered: current price ${currentPricePercent.toFixed(2)} <= stop loss ${stopLoss.toFixed(2)}`);
          await this.closePositionWithAdaptiveSelling(`Stop loss triggered at ${currentPricePercent.toFixed(2)}`, stopLoss, false);
        }
      } else {
        // DOWN direction:
        // - Profit target: when DOWN price >= profit target
        // - Stop loss: when DOWN price drops TO or BELOW stop loss (after decreasing from entry) - sell immediately or adaptive selling as fallback
        if (currentPricePercent >= profitTarget) {
          await this.closePosition(`Profit target reached at ${currentPricePercent.toFixed(2)}`);
        } else if (currentPricePercent <= stopLoss) {
          // DOWN price dropped to stop loss - try to sell immediately, use adaptive selling as fallback
          console.log(`[TradingManager] DOWN stop loss triggered: current price ${currentPricePercent.toFixed(2)} <= stop loss ${stopLoss.toFixed(2)}`);
          await this.closePositionWithAdaptiveSelling(`Stop loss triggered at ${currentPricePercent.toFixed(2)}`, stopLoss, true);
        }
      }

      this.notifyStatusUpdate();
    } catch (error) {
      console.error('Error checking exit conditions:', error);
    }
  }

  /**
   * Close position with adaptive selling for stop loss
   * First tries to sell immediately at current market price
   * If that fails, uses adaptive selling as fallback:
   *   - For UP direction: Tries progressively lower prices (stopLoss, stopLoss-1, stopLoss-2, etc.)
   *   - For DOWN direction: Tries to sell at market price (price already dropped, just sell)
   */
  private async closePositionWithAdaptiveSelling(reason: string, stopLossPrice: number, isDownDirection: boolean = false): Promise<void> {
    if (!this.status.currentPosition) {
      return;
    }

    // Prevent multiple simultaneous exit orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    try {
      const position = this.status.currentPosition;
      
      console.log('[TradingManager] Stop loss triggered - attempting immediate sell:', {
        stopLossPrice,
        direction: isDownDirection ? 'DOWN' : 'UP',
        reason,
      });

      // First, try to sell immediately at current market price
      try {
        const currentMarketPrice = await this.clobClient.getPrice(position.tokenId, 'SELL');
        if (currentMarketPrice) {
          const currentPricePercent = toPercentage(currentMarketPrice);
          console.log(`[TradingManager] Attempting immediate sell at current market price: ${currentPricePercent.toFixed(2)}`);
          
          // Try immediate sell
          this.isPlacingOrder = false;
          this.isPlacingSplitOrders = false;
          await this.closePosition(`${reason} - Immediate sell at ${currentPricePercent.toFixed(2)}`);
          return;
        }
      } catch (error) {
        console.warn('[TradingManager] Immediate sell failed, falling back to adaptive selling:', error);
      }

      // If immediate sell failed, use adaptive selling as fallback
      this.isPlacingOrder = true;
      this.isPlacingSplitOrders = true;
      
      const maxAttempts = 5;
      console.log('[TradingManager] Using adaptive selling as fallback:', {
        stopLossPrice,
        maxAttempts,
        isDownDirection,
      });

      // For UP: try progressively lower prices (stopLoss, stopLoss-1, stopLoss-2, etc.)
      // For DOWN: price already dropped, just try to sell at market or slightly above stop loss
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let targetPrice: number;
        if (isDownDirection) {
          // For DOWN: price dropped to stop loss, try to sell at stop loss or slightly above
          targetPrice = stopLossPrice + (attempt * 0.5); // Try stopLoss, stopLoss+0.5, stopLoss+1, etc.
        } else {
          // For UP: try progressively lower prices
          targetPrice = stopLossPrice - attempt; // stopLoss, stopLoss-1, stopLoss-2, etc.
        }
        
        if (targetPrice < 0 || targetPrice > 100) {
          console.warn('[TradingManager] Target price out of range, using market price');
          this.isPlacingOrder = false;
          this.isPlacingSplitOrders = false;
          await this.closePosition(reason);
          return;
        }

        try {
          console.log(`[TradingManager] Adaptive attempt ${attempt + 1}/${maxAttempts}: Trying to sell at price ${targetPrice.toFixed(2)}`);
          
          // Get current market price
          const currentMarketPrice = await this.clobClient.getPrice(position.tokenId, 'SELL');
          if (!currentMarketPrice) {
            throw new Error('Could not get market price');
          }

          const currentPricePercent = toPercentage(currentMarketPrice);
          
          // For UP: sell when price is at/below target (price dropped to stop loss)
          // For DOWN: sell when price is at/above target (can sell at stop loss or slightly above)
          const canSell = isDownDirection 
            ? currentPricePercent >= targetPrice  // DOWN: can sell if price is at/above target
            : currentPricePercent <= targetPrice; // UP: price dropped to/below target
            
          if (canSell) {
            console.log(`[TradingManager] Current price ${currentPricePercent.toFixed(2)} meets target ${targetPrice.toFixed(2)}, proceeding with sale`);
            this.isPlacingOrder = false;
            this.isPlacingSplitOrders = false;
            await this.closePosition(`${reason} - Adaptive sell at ${currentPricePercent.toFixed(2)} (target was ${targetPrice.toFixed(2)})`);
            return;
          } else {
            const directionText = isDownDirection ? 'below' : 'above';
            console.log(`[TradingManager] Current price ${currentPricePercent.toFixed(2)} is ${directionText} target ${targetPrice.toFixed(2)}, will try ${isDownDirection ? 'higher' : 'lower'} price on next attempt`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.error(`[TradingManager] Error on adaptive attempt ${attempt + 1}:`, error);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // If all adaptive attempts failed, sell at current market price anyway (must stop the loss)
      console.warn('[TradingManager] All adaptive attempts failed, selling at current market price to stop loss');
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      await this.closePosition(`${reason} - All attempts failed, selling at market price to stop loss`);
    } catch (error) {
      console.error('[TradingManager] Error in adaptive selling:', error);
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      // Fall back to regular close position
      await this.closePosition(reason);
    }
  }

  /**
   * Place a single SELL order (part of split sells for large positions)
   */
  private async placeSingleSellOrder(
    tokenId: string,
    sellSize: number,
    _direction: 'UP' | 'DOWN',
    orderIndex: number,
    totalOrders: number
  ): Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }> {
    try {
      if (!this.apiCredentials) {
        return { success: false, error: 'No API credentials' };
      }

      if (this.browserClobClient) {
        const { OrderType, Side } = await import('@polymarket/clob-client');
        
        // Get bid price for SELL orders
        const bidPriceResponse = await this.browserClobClient.getPrice(tokenId, Side.BUY);
        const bidPrice = parseFloat(bidPriceResponse.price);
        
        if (isNaN(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
          return { success: false, error: 'Invalid market price' };
        }

        // Get fee rate
        let feeRateBps: number;
        try {
          feeRateBps = await this.browserClobClient.getFeeRateBps(tokenId);
          if (!feeRateBps || feeRateBps === 0) {
            feeRateBps = 1000;
          }
        } catch (error) {
          feeRateBps = 1000;
        }

        // Calculate shares from USD size
        const shares = sellSize / bidPrice;

        const marketOrder = {
          tokenID: tokenId,
          amount: shares,
          side: Side.SELL,
          feeRateBps: feeRateBps,
        };

        console.log(`[TradingManager] Placing split SELL order ${orderIndex + 1}/${totalOrders}:`, {
          currentPrice: toPercentage(bidPrice).toFixed(2),
          sellSizeUSD: sellSize.toFixed(2),
          shares: shares.toFixed(2),
        });

        const response = await this.browserClobClient.createAndPostMarketOrder(
          marketOrder,
          { negRisk: false },
          OrderType.FAK
        );

        if (response?.orderID) {
          return {
            success: true,
            orderId: response.orderID,
            fillPrice: toPercentage(bidPrice),
          };
        } else {
          return { success: false, error: 'No order ID returned' };
        }
      } else {
        // Fallback to server-side API
        const bidPrice = await this.clobClient.getPrice(tokenId, 'BUY');
        if (!bidPrice || isNaN(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
          return { success: false, error: 'Invalid market price' };
        }

        const shares = sellSize / bidPrice;

        const response = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tokenId,
            size: shares,
            side: 'SELL',
            isMarketOrder: true,
            apiCredentials: this.apiCredentials,
            negRisk: false,
          }),
        });

        const data = await response.json();
        if (response.ok && data.orderId) {
          return {
            success: true,
            orderId: data.orderId,
            fillPrice: toPercentage(bidPrice),
          };
        } else {
          return { success: false, error: data.error || 'Order failed' };
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Close current position with market order
   * For large positions (>50 USD), splits sell orders into multiple trades
   * Uses API if credentials are available, otherwise simulates
   */
  private async closePosition(reason: string): Promise<void> {
    if (!this.status.currentPosition) {
      return;
    }

    // Prevent multiple simultaneous exit orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    try {
      const position = this.status.currentPosition;
      const positionSize = position.size;
      const isLargePosition = positionSize > 50;
      const direction = position.direction || 'UP';

      // Calculate sell splits for large positions
      const numSplits = isLargePosition ? 3 : 1; // Split into 3 for large positions
      const sizePerSplit = positionSize / numSplits;

      console.log('[TradingManager] Closing position (SELL):', {
        tokenId: position.tokenId,
        size: positionSize,
        entryPrice: position.entryPrice,
        isLargePosition,
        numSplits,
        direction,
      });

      if (!this.apiCredentials) {
        // Simulation mode
        const exitPricePercent = position.entryPrice; // Use entry price for simulation
        const priceDiff = exitPricePercent - position.entryPrice;
        const profit = (priceDiff / position.entryPrice) * positionSize;

        const exitTrade: Trade = {
          id: `exit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: position.eventSlug,
          tokenId: position.tokenId,
          side: 'SELL',
          size: positionSize,
          price: exitPricePercent,
          timestamp: Date.now(),
          status: 'filled',
          transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
          profit,
          reason: `Simulated exit: ${reason}`,
          orderType: 'MARKET',
          direction,
        };

        this.trades.push(exitTrade);
        this.status.totalTrades++;
        this.status.totalProfit += profit;
        this.status.successfulTrades++;
        this.status.currentPosition = undefined;
        this.notifyTradeUpdate(exitTrade);
        this.notifyStatusUpdate();
        return;
      }

      // Place real sell orders (single or split)
      let totalProfit = 0;
      let totalFilledSize = 0;
      const exitTrades: Trade[] = [];

      for (let i = 0; i < numSplits; i++) {
        const result = await this.placeSingleSellOrder(
          position.tokenId,
          sizePerSplit,
          direction,
          i,
          numSplits
        );

        if (result.success && result.orderId && result.fillPrice !== undefined) {
          const priceDiff = result.fillPrice - position.entryPrice;
          const splitProfit = (priceDiff / position.entryPrice) * sizePerSplit;
          totalProfit += splitProfit;
          totalFilledSize += sizePerSplit;

          const exitTrade: Trade = {
            id: `exit-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`,
            eventSlug: position.eventSlug,
            tokenId: position.tokenId,
            side: 'SELL',
            size: sizePerSplit,
            price: result.fillPrice,
            timestamp: Date.now(),
            status: 'filled',
            transactionHash: result.orderId,
            profit: splitProfit,
            reason: `Exit ${isLargePosition ? `(${i + 1}/${numSplits}) ` : ''}${reason}`,
            orderType: 'MARKET',
            direction,
          };

          exitTrades.push(exitTrade);
          this.trades.push(exitTrade);
          this.status.totalTrades++;
          this.notifyTradeUpdate(exitTrade);
        } else {
          console.error(`[TradingManager] ❌ Split sell order ${i + 1}/${numSplits} failed:`, result.error);
        }

        // Small delay between split orders
        if (i < numSplits - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (totalFilledSize > 0) {
        this.status.successfulTrades++;
        this.status.totalProfit += totalProfit;
        console.log('[TradingManager] ✅ Position closed:', {
          direction,
          totalFilledSize: totalFilledSize.toFixed(2),
          totalProfit: totalProfit.toFixed(2),
          numOrders: exitTrades.length,
        });
      } else {
        console.error('[TradingManager] ❌ All sell orders failed');
        this.status.failedTrades++;
      }

      // Clear position
      this.status.currentPosition = undefined;
      this.notifyStatusUpdate();
    } catch (error) {
      console.error('[TradingManager] ❌ Error closing position:', error);
      this.status.failedTrades++;
    } finally {
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
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
