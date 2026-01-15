import type { StrategyConfig, Trade, TradingStatus, Position } from './trading-types';
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
  private isMonitoring: boolean = false; // Flag to control continuous monitoring loop
  private activeEvent: EventDisplayData | null = null;
  private pendingLimitOrders: Map<string, Trade> = new Map(); // Map of tokenId -> pending limit order
  private currentPrice: number | null = null; // Current BTC/USD price
  private priceToBeat: number | null = null; // Price to Beat for active event
  private apiCredentials: { key: string; secret: string; passphrase: string } | null = null; // API credentials for order placement
  private isPlacingOrder: boolean = false; // Flag to prevent multiple simultaneous orders
  private isPlacingSplitOrders: boolean = false; // Flag to track if we're placing split orders
  private positions: Position[] = []; // Array of positions instead of single currentPosition
  private priceBelowEntry: boolean = false; // Track if price dropped below entry after position

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
      positions: [],
    };
  }

  private getDefaultStrategy(): StrategyConfig {
    return {
      enabled: false,
      entryPrice: 96, // Limit order at 96
      profitTargetPrice: 99, // Take profit at 100
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

  /**
   * Set wallet balance and calculate max position size (50% of balance)
   */
  setWalletBalance(balance: number): void {
    // Calculate max position size (50% of balance)
    if (balance) {
      this.status.maxPositionSize = balance * 0.5;
      this.status.walletBalance = balance;
    }
    this.notifyStatusUpdate();
  }

  /**
   * Get all active positions for the current event
   */
  getActivePositions(): Position[] {
    if (!this.activeEvent) {
      return [];
    }
    return this.positions.filter(p => p.eventSlug === this.activeEvent!.slug);
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

    // Check if we have token IDs for the active event
    if (!this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
    const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

    if (!yesTokenId || !noTokenId) {
      return;
    }

    // If we have positions, check exit conditions FIRST (regardless of price difference)
    // Price difference check only applies to entry conditions, not exit conditions
    const activePositions = this.getActivePositions();
    if (activePositions.length > 0) {
      await this.checkExitConditions();
      return;
    }

    // ADDITIONAL SAFEGUARD: Check if order is already being placed (prevents race condition)
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      return; // Don't check entry conditions if order is being placed
    }

    // Price Difference condition check - only applies to entry conditions (when no position exists)
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
   * Order is filled when UP or DOWN value equals entryPrice (exact match)
   */
  private async checkAndPlaceMarketOrder(yesTokenId: string, noTokenId: string): Promise<void> {
    try {
      // Check if already placing an order (additional safeguard against race condition)
      if (this.isPlacingOrder || this.isPlacingSplitOrders) {
        console.log('[TradingManager] Order already being placed, skipping checkAndPlaceMarketOrder...');
        return;
      }

      // Get active positions for this event
      const activePositions = this.getActivePositions();
      const totalPositionSize = activePositions.reduce((sum, p) => sum + p.size, 0);

      // Check if we've reached 50% limit
      if (this.status.maxPositionSize && totalPositionSize >= this.status.maxPositionSize) {
        console.log(`[TradingManager] Max position size reached: ${totalPositionSize.toFixed(2)} >= ${this.status.maxPositionSize.toFixed(2)}`);
        return;
      }

      // Check if adding new position would exceed 50% limit
      const tradeSize = this.strategyConfig.tradeSize;
      if (this.status.maxPositionSize && (totalPositionSize + tradeSize) > this.status.maxPositionSize) {
        console.log(`[TradingManager] Adding position would exceed limit. Current: ${totalPositionSize.toFixed(2)}, Adding: ${tradeSize.toFixed(2)}, Max: ${this.status.maxPositionSize.toFixed(2)}`);
        return;
      }

      const entryPrice = this.strategyConfig.entryPrice;

      // Get current market prices for both tokens (BUY side for entry condition checking)
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

      // Check if either token price equals entry price (exact match with small tolerance for floating point)
      let tokenToTrade: string | null = null;
      let direction: 'UP' | 'DOWN' | null = null;
      const tolerance = 0.01; // Small tolerance for floating point comparison

      // Check UP token first (YES token)
      if (Math.abs(yesPricePercent - entryPrice) <= tolerance) {
        tokenToTrade = yesTokenId;
        direction = 'UP';
        console.log(`[TradingManager] Entry condition met: yesTokenPrice ${yesPricePercent.toFixed(2)} == entryPrice ${entryPrice.toFixed(2)} → Filling UP position`);
      }
      // Check DOWN token (NO token) - only if UP token hasn't matched
      else if (Math.abs(noPricePercent - entryPrice) <= tolerance) {
        tokenToTrade = noTokenId;
        direction = 'DOWN';
        console.log(`[TradingManager] Entry condition met: noTokenPrice ${noPricePercent.toFixed(2)} == entryPrice ${entryPrice.toFixed(2)} → Filling DOWN position`);
      } else {
        // Price is not equal to entry - mark that we can re-enter if it comes back to entry price
        // Only set flag if price is BELOW entry (not just not equal)
        if (activePositions.length > 0) {
          const currentPrice = yesPricePercent >= noPricePercent ? yesPricePercent : noPricePercent;
          if (currentPrice < entryPrice) {
            this.priceBelowEntry = true;
          }
        }
        // Log why entry condition wasn't met for debugging
        console.log(`[TradingManager] Entry condition not met:`, {
          yesPricePercent: yesPricePercent.toFixed(2),
          noPricePercent: noPricePercent.toFixed(2),
          entryPrice: entryPrice.toFixed(2),
          yesMet: Math.abs(yesPricePercent - entryPrice) <= tolerance,
          noMet: Math.abs(noPricePercent - entryPrice) <= tolerance,
        });
        return;
      }

      // Check if we should enter (re-entry logic)
      if (activePositions.length > 0) {
        // We have positions - check if price dropped below entry and came back to exact entry price
        if (!this.priceBelowEntry) {
          // Price never dropped below entry, don't re-enter
          console.log(`[TradingManager] Price never dropped below entry, not re-entering. Current positions: ${activePositions.length}`);
          return;
        }
        // Price dropped below entry and came back to exact entry price - allow re-entry
        console.log(`[TradingManager] Price dropped below entry and came back to exact entry price, allowing re-entry. Current positions: ${activePositions.length}`);
        this.priceBelowEntry = false; // Reset flag
      }

      // Place market order when price reaches entry price
      if (tokenToTrade && direction) {
        // Set flags IMMEDIATELY to prevent race condition
        // This prevents another call from entering while we're placing the order
        this.isPlacingOrder = true;
        this.isPlacingSplitOrders = true;
        
        try {
          await this.placeMarketOrder(tokenToTrade, entryPrice, direction);
        } catch (error) {
          // Reset flags on error so we can retry
          console.error('[TradingManager] Error in placeMarketOrder, resetting flags:', error);
          this.isPlacingOrder = false;
          this.isPlacingSplitOrders = false;
          throw error;
        }
        // Note: placeMarketOrder will reset isPlacingOrder in its finally block
      }
    } catch (error) {
      console.error('[TradingManager] Error checking for market order placement:', error);
      // Ensure flags are reset on error
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
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
        
        // For BUY orders, use BUY side to get ask price
        const askPriceResponse = await this.browserClobClient.getPrice(tokenId, Side.BUY);
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
        // For BUY orders, use BUY side to get ask price
        const askPrice = await this.clobClient.getPrice(tokenId, 'BUY');
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
    // Note: isPlacingOrder and isPlacingSplitOrders should already be set in checkAndPlaceMarketOrder
    // before calling this method to prevent race conditions.
    // If flags are not set (shouldn't happen), set them as fallback for safety
    if (!this.isPlacingOrder || !this.isPlacingSplitOrders) {
      console.warn('[TradingManager] Flags not set, setting them now (fallback)');
      this.isPlacingOrder = true;
      this.isPlacingSplitOrders = true;
    }

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

        // Create new position in simulation mode
        const newPosition: Position = {
          id: `position-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: trade.eventSlug,
          tokenId: trade.tokenId,
          side: trade.side,
          size: tradeSize,
          entryPrice: entryPrice,
          direction,
          filledOrders: [{ orderId: trade.transactionHash!, price: entryPrice, size: tradeSize, timestamp: Date.now() }],
          entryTimestamp: Date.now(),
        };

        this.positions.push(newPosition);
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);

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

        // Create NEW position (don't overwrite existing)
        const newPosition: Position = {
          id: `position-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: this.activeEvent!.slug,
          tokenId,
          side: 'BUY',
          size: totalFilledSize,
          entryPrice: avgEntryPrice,
          direction,
          filledOrders,
          entryTimestamp: Date.now(),
        };

        // Add to positions array
        this.positions.push(newPosition);
        
        // Update status
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        
        this.status.successfulTrades++;
        console.log('[TradingManager] ✅ New position created:', {
          positionId: newPosition.id,
          direction,
          totalSize: totalFilledSize.toFixed(2),
          avgEntryPrice: avgEntryPrice.toFixed(2),
          numOrders: filledOrders.length,
          totalPositions: this.positions.length,
          totalPositionSize: this.status.totalPositionSize.toFixed(2),
        });
        
        // After all orders are placed, fetch order details to show in orders table
        // Delay to ensure orders are registered in the system
        console.log('[TradingManager] All buy orders placed, will fetch order details in 2 seconds...');
        setTimeout(() => {
          // Trigger order fetch via trade update callback
          if (this.onTradeUpdate && filledOrders.length > 0) {
            // Create a synthetic trade update to trigger order fetch
            const lastTrade = this.trades[this.trades.length - 1];
            if (lastTrade) {
              console.log('[TradingManager] Triggering order fetch after buy orders...');
              this.onTradeUpdate(lastTrade);
            }
          }
        }, 2000); // 2 second delay to ensure orders are registered
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
   * Uses the same variables as entry condition (yesPricePercent, noPricePercent)
   * For UP direction:
   *   - Profit Target: Sell when UP value >= profit target
   *   - Stop Loss: Sell when UP value <= stop loss (with adaptive selling)
   * For DOWN direction:
   *   - Profit Target: Sell when DOWN value >= profit target
   *   - Stop Loss: Sell when DOWN value <= stop loss (with adaptive selling)
   */
  private async checkExitConditions(): Promise<void> {
    // Get all active positions for this event
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return;
    }

    // Prevent multiple simultaneous exit orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      return;
    }

    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      return;
    }

    try {
      const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
      const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

      if (!yesTokenId || !noTokenId) {
        return;
      }

      // Get current market prices for both tokens (same as entry condition)
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'BUY'),
        this.clobClient.getPrice(noTokenId, 'BUY'),
      ]);

      if (!yesPrice || !noPrice) {
        return;
      }

      // Convert to percentage scale (0-100) - same variables as entry condition
      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      const profitTarget = this.strategyConfig.profitTargetPrice;
      const stopLoss = this.strategyConfig.stopLossPrice;

      // Check exit conditions for ALL positions
      // We exit ALL positions when ANY position meets exit condition
      let shouldExit = false;
      let exitReason = '';
      let useAdaptiveSelling = false;
      let isDownDirection = false;
      let triggeringPosition: Position | null = null;

      // First, update all positions' current prices and unrealized P/L
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;

        // Update position current price and unrealized P/L
        position.currentPrice = currentPrice;
        const priceDiff = currentPrice - position.entryPrice;
        position.unrealizedProfit = (priceDiff / position.entryPrice) * position.size;
      }

      // Then, check exit conditions for ALL positions
      // Exit ALL positions if ANY position meets profit target or stop loss
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;

        // Check profit target condition
        if (currentPrice >= profitTarget) {
          shouldExit = true;
          exitReason = `Profit target reached at ${currentPrice.toFixed(2)} (Position: ${position.id.substring(0, 8)}...)`;
          triggeringPosition = position;
          console.log(`[TradingManager] 🎯 Profit target triggered by position ${position.id.substring(0, 8)}... at price ${currentPrice.toFixed(2)}. Will close ALL ${activePositions.length} position(s).`);
          break; // Exit all positions on profit target
        }
        
        // Check stop loss condition
        if (currentPrice <= stopLoss) {
          shouldExit = true;
          exitReason = `Stop loss triggered at ${currentPrice.toFixed(2)} (Position: ${position.id.substring(0, 8)}...)`;
          useAdaptiveSelling = true;
          isDownDirection = direction === 'DOWN';
          triggeringPosition = position;
          console.log(`[TradingManager] 🛑 Stop loss triggered by position ${position.id.substring(0, 8)}... at price ${currentPrice.toFixed(2)}. Will close ALL ${activePositions.length} position(s).`);
          break; // Exit all positions on stop loss
        }
      }

      // Log exit condition check
      if (!shouldExit) {
        // Only log detailed info if no exit condition was met (to reduce log noise)
        console.log(`[TradingManager] Checking exit conditions for ${activePositions.length} position(s):`, {
          yesPricePercent: yesPricePercent.toFixed(2),
          noPricePercent: noPricePercent.toFixed(2),
          profitTarget: profitTarget.toFixed(2),
          stopLoss: stopLoss.toFixed(2),
          positions: activePositions.map(p => ({
            id: p.id.substring(0, 8),
            direction: p.direction,
            entryPrice: p.entryPrice.toFixed(2),
            currentPrice: p.currentPrice?.toFixed(2),
            unrealizedProfit: p.unrealizedProfit?.toFixed(2),
          })),
        });
      }

      if (shouldExit) {
        console.log(`[TradingManager] 🚨 EXIT CONDITION MET - Closing ALL ${activePositions.length} position(s):`, {
          exitReason,
          triggeringPosition: triggeringPosition ? {
            id: triggeringPosition.id.substring(0, 8),
            direction: triggeringPosition.direction,
            entryPrice: triggeringPosition.entryPrice.toFixed(2),
            currentPrice: triggeringPosition.currentPrice?.toFixed(2),
          } : null,
          allPositions: activePositions.map(p => ({
            id: p.id.substring(0, 8),
            direction: p.direction,
            size: p.size.toFixed(2),
            entryPrice: p.entryPrice.toFixed(2),
          })),
          useAdaptiveSelling,
        });

        if (useAdaptiveSelling) {
          await this.closeAllPositionsWithAdaptiveSelling(exitReason, stopLoss, isDownDirection, yesPricePercent, noPricePercent);
        } else {
          await this.closeAllPositions(exitReason);
        }
      }

      this.notifyStatusUpdate();
    } catch (error) {
      console.error('Error checking exit conditions:', error);
    }
  }

  /**
   * Place a single SELL order (part of split sells for large positions)
   * Uses yesPricePercent and noPricePercent (same as adaptive selling) for consistency
   */
  private async placeSingleSellOrder(
    tokenId: string,
    sellSize: number,
    direction: 'UP' | 'DOWN',
    orderIndex: number,
    totalOrders: number,
    yesPricePercent: number,
    noPricePercent: number
  ): Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }> {
    try {
      if (!this.apiCredentials) {
        return { success: false, error: 'No API credentials' };
      }

      // Use the appropriate price based on direction (same as adaptive selling)
      const currentPricePercent = direction === 'UP' ? yesPricePercent : noPricePercent;
      
      // Convert percentage back to decimal (0-1) for API calls
      const bidPrice = currentPricePercent / 100;
      
      if (isNaN(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
        return { success: false, error: 'Invalid market price' };
      }

      if (this.browserClobClient) {
        const { OrderType, Side } = await import('@polymarket/clob-client');

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
          direction,
          currentPrice: currentPricePercent.toFixed(2),
          yesPricePercent: yesPricePercent.toFixed(2),
          noPricePercent: noPricePercent.toFixed(2),
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
            fillPrice: currentPricePercent,
          };
        } else {
          return { success: false, error: 'No order ID returned' };
        }
      } else {
        // Fallback to server-side API
        // Use the price from yesPricePercent/noPricePercent (already converted to decimal)
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
            fillPrice: currentPricePercent,
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
   * Close all positions for the current event
   */
  private async closeAllPositions(reason: string): Promise<void> {
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return;
    }

    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    const closedPositionIds: string[] = [];

    try {
      const totalSize = activePositions.reduce((sum, p) => sum + p.size, 0);
      console.log(`[TradingManager] 🚨 CLOSING ALL ${activePositions.length} POSITION(S) - ${reason}:`, {
        reason,
        totalSize: totalSize.toFixed(2),
        positions: activePositions.map((p, idx) => ({
          index: idx + 1,
          id: p.id.substring(0, 8) + '...',
          direction: p.direction,
          size: p.size.toFixed(2),
          entryPrice: p.entryPrice.toFixed(2),
          currentPrice: p.currentPrice?.toFixed(2),
          unrealizedProfit: p.unrealizedProfit?.toFixed(2),
        })),
      });

      // Close each position and track which ones were successfully closed
      for (let i = 0; i < activePositions.length; i++) {
        const position = activePositions[i];
        try {
          console.log(`[TradingManager] [${i + 1}/${activePositions.length}] Closing position ${position.id.substring(0, 8)}... (${position.direction}, $${position.size.toFixed(2)})`);
          await this.closeSinglePosition(position, reason);
          closedPositionIds.push(position.id);
          console.log(`[TradingManager] ✅ [${i + 1}/${activePositions.length}] Successfully closed position ${position.id.substring(0, 8)}...`);
        } catch (error) {
          console.error(`[TradingManager] ❌ [${i + 1}/${activePositions.length}] Failed to close position ${position.id.substring(0, 8)}...:`, error);
          // Continue with next position even if one fails
        }
      }

      // Remove only successfully closed positions
      if (closedPositionIds.length > 0) {
        this.positions = this.positions.filter(
          p => !closedPositionIds.includes(p.id)
        );
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        
        if (closedPositionIds.length === activePositions.length) {
          console.log(`[TradingManager] ✅✅✅ SUCCESS: All ${closedPositionIds.length} position(s) closed successfully!`);
        } else {
          console.warn(`[TradingManager] ⚠️ PARTIAL: Closed ${closedPositionIds.length} of ${activePositions.length} position(s)`);
          console.warn(`[TradingManager] ⚠️ Warning: ${activePositions.length - closedPositionIds.length} position(s) failed to close and will remain open`);
        }
      } else {
        console.error(`[TradingManager] ❌❌❌ CRITICAL: No positions were successfully closed out of ${activePositions.length} attempted!`);
      }

      this.notifyStatusUpdate();
    } catch (error) {
      console.error('[TradingManager] ❌ Error closing all positions:', error);
    } finally {
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
    }
  }

  /**
   * Close all positions with adaptive selling
   */
  private async closeAllPositionsWithAdaptiveSelling(
    reason: string,
    stopLossPrice: number,
    isDownDirection: boolean,
    yesPricePercent: number,
    noPricePercent: number
  ): Promise<void> {
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return;
    }

    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    try {
      const currentPricePercent = isDownDirection ? noPricePercent : yesPricePercent;
      
      console.log('[TradingManager] Stop loss triggered - attempting immediate sell for all positions:', {
        stopLossPrice,
        direction: isDownDirection ? 'DOWN' : 'UP',
        currentPrice: currentPricePercent.toFixed(2),
        numPositions: activePositions.length,
        reason,
      });

      // Try immediate sell first - temporarily clear flags so closeAllPositions can set them
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      await this.closeAllPositions(`${reason} - Immediate sell at ${currentPricePercent.toFixed(2)}`);
      
      // Check if all positions were closed
      const remainingPositions = this.getActivePositions();
      if (remainingPositions.length === 0) {
        console.log('[TradingManager] ✅ All positions closed successfully on immediate sell');
        return;
      }
      
      console.log(`[TradingManager] ⚠️ ${remainingPositions.length} position(s) still open, attempting adaptive selling...`);
      
      // Adaptive selling as fallback - set flags again
      this.isPlacingOrder = true;
      this.isPlacingSplitOrders = true;
      
      const maxAttempts = 5;
      console.log('[TradingManager] Using adaptive selling as fallback for all positions:', {
        stopLossPrice,
        maxAttempts,
        isDownDirection,
        currentPrice: currentPricePercent.toFixed(2),
      });

      // For both UP and DOWN: try progressively lower prices
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const targetPrice = stopLossPrice - attempt;
        
        if (targetPrice < 0 || targetPrice > 100) {
          console.warn('[TradingManager] Target price out of range, using market price');
          this.isPlacingOrder = false;
          this.isPlacingSplitOrders = false;
          await this.closeAllPositions(reason);
          return;
        }

        try {
          console.log(`[TradingManager] Adaptive attempt ${attempt + 1}/${maxAttempts}: Trying to sell all positions at price ${targetPrice.toFixed(2)}`);
          
          const currentPrice = isDownDirection ? noPricePercent : yesPricePercent;
          const canSell = currentPrice <= targetPrice;
            
          if (canSell) {
            console.log(`[TradingManager] Current price ${currentPrice.toFixed(2)} meets target ${targetPrice.toFixed(2)}, proceeding with sale of all positions`);
            this.isPlacingOrder = false;
            this.isPlacingSplitOrders = false;
            await this.closeAllPositions(`${reason} - Adaptive sell at ${currentPrice.toFixed(2)} (target was ${targetPrice.toFixed(2)})`);
            
            // Check if all positions were closed
            const remainingAfterAdaptive = this.getActivePositions();
            if (remainingAfterAdaptive.length === 0) {
              console.log('[TradingManager] ✅ All positions closed successfully via adaptive selling');
              return;
            }
            console.log(`[TradingManager] ⚠️ ${remainingAfterAdaptive.length} position(s) still open after adaptive attempt ${attempt + 1}`);
          } else {
            console.log(`[TradingManager] Current price ${currentPrice.toFixed(2)} is above target ${targetPrice.toFixed(2)}, will try lower price on next attempt`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.error(`[TradingManager] Error on adaptive attempt ${attempt + 1}:`, error);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // If all adaptive attempts failed, sell at current market price anyway
      const finalRemainingPositions = this.getActivePositions();
      if (finalRemainingPositions.length > 0) {
        console.warn(`[TradingManager] All adaptive attempts failed, selling ${finalRemainingPositions.length} remaining position(s) at current market price to stop loss`);
        this.isPlacingOrder = false;
        this.isPlacingSplitOrders = false;
        await this.closeAllPositions(`${reason} - All attempts failed, selling at market price to stop loss`);
        
        // Final check
        const stillRemaining = this.getActivePositions();
        if (stillRemaining.length > 0) {
          console.error(`[TradingManager] ❌ CRITICAL: ${stillRemaining.length} position(s) could not be closed after all attempts!`);
        } else {
          console.log('[TradingManager] ✅ All positions closed successfully on final attempt');
        }
      } else {
        console.log('[TradingManager] ✅ All positions were closed during adaptive attempts');
      }
    } catch (error) {
      console.error('[TradingManager] Error in adaptive selling for all positions:', error);
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
    }
  }

  /**
   * Close a single position
   */
  private async closeSinglePosition(position: Position, reason: string): Promise<void> {
    const positionSize = position.size;
    const isLargePosition = positionSize > 50;
    const direction = position.direction || 'UP';

    // Calculate sell splits for large positions
    const numSplits = isLargePosition ? 3 : 1;
    const sizePerSplit = positionSize / numSplits;

    console.log('[TradingManager] Closing single position (SELL):', {
      positionId: position.id,
      tokenId: position.tokenId,
      size: positionSize,
      entryPrice: position.entryPrice,
      isLargePosition,
      numSplits,
      direction,
    });

    if (!this.apiCredentials) {
      // Simulation mode
      const exitPricePercent = position.entryPrice;
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
      this.notifyTradeUpdate(exitTrade);
      return;
    }

    // Fetch current market prices
    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      console.error('[TradingManager] Cannot close position: missing event or token IDs');
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];

    const [yesPrice, noPrice] = await Promise.all([
      this.clobClient.getPrice(yesTokenId, 'SELL'),
      this.clobClient.getPrice(noTokenId, 'SELL'),
    ]);

    if (!yesPrice || !noPrice) {
      console.error('[TradingManager] Cannot close position: failed to fetch prices');
      return;
    }

    const yesPricePercent = toPercentage(yesPrice);
    const noPricePercent = toPercentage(noPrice);

    // Place real sell orders
    let totalProfit = 0;
    let totalFilledSize = 0;
    const exitTrades: Trade[] = [];

    for (let i = 0; i < numSplits; i++) {
      const result = await this.placeSingleSellOrder(
        position.tokenId,
        sizePerSplit,
        direction,
        i,
        numSplits,
        yesPricePercent,
        noPricePercent
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

      if (i < numSplits - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (totalFilledSize > 0) {
      this.status.successfulTrades++;
      this.status.totalProfit += totalProfit;
      console.log('[TradingManager] ✅ Single position closed:', {
        positionId: position.id,
        direction,
        totalFilledSize: totalFilledSize.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        numOrders: exitTrades.length,
      });
    } else {
      const errorMsg = `All sell orders failed for position ${position.id}`;
      console.error(`[TradingManager] ❌ ${errorMsg}`);
      this.status.failedTrades++;
      throw new Error(errorMsg);
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

    // Start continuous monitoring loop
    this.startContinuousMonitoring();
  }

  /**
   * Start continuous monitoring loop (replaces interval-based monitoring)
   * Checks trading conditions continuously with a small delay to prevent overwhelming the system
   */
  private async startContinuousMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      return; // Already monitoring
    }

    this.isMonitoring = true;
    console.log('[TradingManager] Starting continuous monitoring...');

    // Continuous monitoring loop
    while (this.isMonitoring && this.status.isActive) {
      try {
        // Check trading conditions
        await this.checkTradingConditions();
        
        // Small delay to prevent overwhelming the system and API rate limits
        // 100ms delay provides ~10 checks per second while being respectful to API
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Log error but continue monitoring (don't break the loop)
        console.error('[TradingManager] Error in continuous monitoring loop:', error);
        // Add a slightly longer delay on error to prevent rapid error loops
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log('[TradingManager] Continuous monitoring stopped');
  }

  stopTrading(): void {
    this.status.isActive = false;
    this.isMonitoring = false; // Stop continuous monitoring loop
    
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

  /**
   * Manually close all positions (public method for UI)
   */
  async closeAllPositionsManually(reason: string = 'Manual sell'): Promise<void> {
    await this.closeAllPositions(reason);
  }

  /**
   * Manually close a specific position by ID (public method for UI)
   */
  async closePositionManually(positionId: string, reason: string = 'Manual sell'): Promise<void> {
    const position = this.positions.find(p => p.id === positionId);
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }
    
    // Check if it's for the active event
    if (position.eventSlug !== this.activeEvent?.slug) {
      throw new Error('Position is not for the active event');
    }

    // Close this specific position
    await this.closeSinglePosition(position, reason);
    
    // Remove from positions array
    this.positions = this.positions.filter(p => p.id !== positionId);
    this.status.positions = [...this.positions];
    this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
    
    this.notifyStatusUpdate();
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
