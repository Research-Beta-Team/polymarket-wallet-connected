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
  private consecutiveFailures: number = 0; // Circuit breaker counter
  private readonly MAX_CONSECUTIVE_FAILURES = 5; // Circuit breaker threshold
  private orderPlacementStartTime: number = 0; // Track when order placement started
  private readonly MAX_ORDER_PLACEMENT_TIME = 30000; // 30 seconds max for order placement

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
   * Verify sufficient balance before placing order
   */
  private verifyBalance(requiredAmount: number): boolean {
    if (!this.status.walletBalance) {
      console.warn('[TradingManager] Balance verification skipped - wallet balance not set');
      return true; // Allow trade if balance is not set (simulation mode)
    }
    
    const available = this.status.walletBalance;
    if (available < requiredAmount) {
      console.error(`[TradingManager] 🚫 Insufficient balance: Required ${requiredAmount.toFixed(2)} USDC, Available ${available.toFixed(2)} USDC`);
      return false;
    }
    
    console.log(`[TradingManager] ✅ Balance verified: Required ${requiredAmount.toFixed(2)} USDC, Available ${available.toFixed(2)} USDC`);
    return true;
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
      console.log('[TradingManager] checkTradingConditions skipped: enabled=', this.strategyConfig.enabled, 'active=', this.status.isActive);
      return;
    }

    if (!this.activeEvent) {
      console.log('[TradingManager] checkTradingConditions skipped: no active event');
      return;
    }

    // Check if we have token IDs for the active event
    if (!this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      console.log('[TradingManager] checkTradingConditions skipped: missing token IDs');
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
    const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

    if (!yesTokenId || !noTokenId) {
      return;
    }

    // If we have positions, update prices and check exit conditions FIRST (regardless of price difference)
    // Price difference check only applies to entry conditions, not exit conditions
    const activePositions = this.getActivePositions();
    if (activePositions.length > 0) {
      // Check if exit is already in progress
      if (this.isPlacingOrder || this.isPlacingSplitOrders) {
        // Don't spam logs, but check if stuck
        const timeSinceOrderStart = Date.now() - this.orderPlacementStartTime;
        if (timeSinceOrderStart > 60000) { // 60 seconds
          console.error(`[TradingManager] 🚨 EXIT IN PROGRESS FOR ${(timeSinceOrderStart / 1000).toFixed(0)}s - May be stuck!`);
        }
        return; // Skip this check cycle, exit already in progress
      }
      
      // Update position prices continuously (even if not checking exit conditions)
      await this.updatePositionPrices();
      // Then check exit conditions
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
      // Check circuit breaker first
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        console.error('[TradingManager] 🔴 Circuit breaker active - trading disabled. Restart trading to reset.');
        return;
      }
      
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

      // Check if either token price is at or below entry price (better for fast markets)
      let tokenToTrade: string | null = null;
      let direction: 'UP' | 'DOWN' | null = null;
      const tolerance = 0.5; // Allow entry within 0.5 of entry price for better execution

      // Check UP token first (YES token) - enter when price <= entryPrice
      if (yesPricePercent <= entryPrice + tolerance && yesPricePercent >= entryPrice - tolerance) {
        tokenToTrade = yesTokenId;
        direction = 'UP';
        console.log(`[TradingManager] Entry condition met: yesTokenPrice ${yesPricePercent.toFixed(2)} near entryPrice ${entryPrice.toFixed(2)} → Filling UP position`);
      }
      // Check DOWN token (NO token) - only if UP token hasn't matched
      else if (noPricePercent <= entryPrice + tolerance && noPricePercent >= entryPrice - tolerance) {
        tokenToTrade = noTokenId;
        direction = 'DOWN';
        console.log(`[TradingManager] Entry condition met: noTokenPrice ${noPricePercent.toFixed(2)} near entryPrice ${entryPrice.toFixed(2)} → Filling DOWN position`);
      } else {
        // Price is not at entry - mark that we can re-enter if it comes back to entry price
        // Only set flag if price is BELOW entry (not just not equal)
        if (activePositions.length > 0) {
          const currentPrice = yesPricePercent >= noPricePercent ? yesPricePercent : noPricePercent;
          if (currentPrice < entryPrice - tolerance) {
            this.priceBelowEntry = true;
          }
        }
        // Log why entry condition wasn't met for debugging (less verbose)
        if (yesPricePercent < entryPrice - 5 && noPricePercent < entryPrice - 5) {
          console.log(`[TradingManager] Entry condition not met: prices too low (YES: ${yesPricePercent.toFixed(2)}, NO: ${noPricePercent.toFixed(2)}, Entry: ${entryPrice.toFixed(2)})`);
        }
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
        this.orderPlacementStartTime = Date.now(); // Track when order placement started
        
        try {
          await this.placeMarketOrder(tokenToTrade, entryPrice, direction);
        } catch (error) {
          // Don't reset flags here - let finally block handle it
          console.error('[TradingManager] Error in placeMarketOrder:', error);
        }
        // Note: placeMarketOrder will reset flags in its finally block
      }
    } catch (error) {
      console.error('[TradingManager] Error checking for market order placement:', error);
      // Don't reset flags here - they will be reset in placeMarketOrder's finally block
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
        // Handle both object {price: "0.96"} and string "0.96" formats
        const askPrice = typeof askPriceResponse === 'object' && askPriceResponse.price 
          ? parseFloat(askPriceResponse.price) 
          : parseFloat(askPriceResponse);
        
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
          console.log(`[TradingManager] ✅ Order ${orderIndex + 1}/${totalOrders} placed successfully:`, {
            orderId: response.orderID.substring(0, 8) + '...',
            fillPrice: toPercentage(askPrice).toFixed(2),
            orderSize: orderSize.toFixed(2),
          });
          return {
            success: true,
            orderId: response.orderID,
            fillPrice: toPercentage(askPrice),
          };
        } else {
          const errorMsg = 'No order ID returned from exchange';
          console.error(`[TradingManager] ❌ Order ${orderIndex + 1}/${totalOrders} failed:`, errorMsg, {
            response: response,
            tokenId: tokenId.substring(0, 10) + '...',
          });
          return { success: false, error: errorMsg };
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
          console.log(`[TradingManager] ✅ Order ${orderIndex + 1}/${totalOrders} placed via API:`, {
            orderId: data.orderId.substring(0, 8) + '...',
            fillPrice: toPercentage(askPrice).toFixed(2),
            orderSize: orderSize.toFixed(2),
          });
          return {
            success: true,
            orderId: data.orderId,
            fillPrice: toPercentage(askPrice),
          };
        } else {
          const errorMsg = data.error || 'Order failed';
          console.error(`[TradingManager] ❌ Order ${orderIndex + 1}/${totalOrders} failed via API:`, {
            error: errorMsg,
            status: response.status,
            statusText: response.statusText,
            data: data,
            tokenId: tokenId.substring(0, 10) + '...',
          });
          return { success: false, error: errorMsg };
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
      
      // Verify balance before placing order
      if (!this.verifyBalance(tradeSize)) {
        console.error('[TradingManager] ❌ Order rejected: Insufficient balance');
        this.status.failedTrades++;
        return;
      }
      
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
      let orderFailed = false;

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
          
          // Reset circuit breaker on success
          this.consecutiveFailures = 0;
        } else {
          console.error(`[TradingManager] ❌ Split order ${i + 1}/${orderSplits.length} failed:`, {
            error: result.error,
            tokenId: tokenId.substring(0, 10) + '...',
            direction,
            targetPrice: split.price.toFixed(2),
            orderSize: split.size.toFixed(2),
          });
          
          // Increment circuit breaker counter
          this.consecutiveFailures++;
          orderFailed = true;
          
          // CRITICAL: If any order in split sequence fails, cancel remaining orders
          console.error(`[TradingManager] 🚫 CANCELING REMAINING ${orderSplits.length - i - 1} ORDER(S) due to failure in order ${i + 1}`);
          break; // Stop placing remaining orders
        }

        // Small delay between split orders to avoid rate limiting
        if (i < orderSplits.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      // Check circuit breaker
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        console.error(`[TradingManager] 🔴 CIRCUIT BREAKER TRIGGERED: ${this.consecutiveFailures} consecutive failures. Stopping trading.`);
        this.stopTrading();
      }

      // Track failed orders for better error reporting
      const failedOrderCount = orderSplits.length - filledOrders.length;
      
      if (filledOrders.length > 0) {
        // Calculate weighted average entry price
        const avgEntryPrice = this.calculateWeightedAverageEntryPrice(
          filledOrders.map(o => ({ price: o.price, size: o.size }))
        );
        
        // Log partial or full success
        if (orderFailed) {
          console.warn(`[TradingManager] ⚠️ PARTIAL FILL: ${filledOrders.length} of ${orderSplits.length} orders filled. ${failedOrderCount} order(s) canceled due to failure.`);
          console.warn(`[TradingManager] ⚠️ Position created with partial size: ${totalFilledSize.toFixed(2)} USDC instead of planned ${tradeSize.toFixed(2)} USDC`);
        } else if (failedOrderCount > 0) {
          console.warn(`[TradingManager] ⚠️ Partial success: ${filledOrders.length} of ${orderSplits.length} orders filled. ${failedOrderCount} order(s) failed.`);
        }

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
        console.error(`[TradingManager] ❌ All ${orderSplits.length} order(s) failed for ${direction} position at entry price ${entryPrice.toFixed(2)}`);
        console.error('[TradingManager] ❌ Possible reasons:');
        console.error('  - Insufficient balance');
        console.error('  - Invalid market price');
        console.error('  - API rate limiting');
        console.error('  - Network/Cloudflare issues');
        console.error('  - Order rejection by exchange');
        this.status.failedTrades++;
      }

      this.notifyStatusUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[TradingManager] ❌ Exception in placeMarketOrder:', {
        error: errorMsg,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        tokenId: tokenId.substring(0, 10) + '...',
        direction,
        entryPrice: entryPrice.toFixed(2),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.status.failedTrades++;
    } finally {
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      this.orderPlacementStartTime = 0; // Reset timer
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
   * Update position prices continuously (called separately from exit condition checking)
   */
  private async updatePositionPrices(): Promise<void> {
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
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

      // Get current market prices for both tokens
      // Use SELL side for position valuation (what you'd get if selling now)
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'SELL'),
        this.clobClient.getPrice(noTokenId, 'SELL'),
      ]);

      if (!yesPrice || !noPrice) {
        return;
      }

      // Convert to percentage scale (0-100)
      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      // Update all positions' current prices and unrealized P/L
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;

        // Update position current price and unrealized P/L (based on SELL price - what you'd get)
        position.currentPrice = currentPrice;
        const priceDiff = currentPrice - position.entryPrice;
        position.unrealizedProfit = (priceDiff / position.entryPrice) * position.size;
      }

      // Update status and notify UI
      this.status.positions = [...this.positions];
      this.notifyStatusUpdate();
    } catch (error) {
      console.error('[TradingManager] Error updating position prices:', error);
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
      // Only log occasionally to reduce noise
      return;
    }
    
    // Log position count for tracking
    if (activePositions.length > 1) {
      console.log(`[TradingManager] 👀 Checking exit conditions for ${activePositions.length} POSITIONS:`, activePositions.map(p => ({
        id: p.id.substring(0, 8) + '...',
        direction: p.direction,
        size: p.size.toFixed(2),
      })));
    }

    // Prevent multiple simultaneous exit orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      // Check if flags are stuck (order taking too long)
      const timeSinceOrderStart = Date.now() - this.orderPlacementStartTime;
      if (timeSinceOrderStart > this.MAX_ORDER_PLACEMENT_TIME) {
        console.error(`[TradingManager] 🚨 FLAGS STUCK! Order placement exceeded ${this.MAX_ORDER_PLACEMENT_TIME}ms. Force resetting flags.`);
        this.isPlacingOrder = false;
        this.isPlacingSplitOrders = false;
        this.orderPlacementStartTime = 0;
      } else {
        console.log(`[TradingManager] ⚠️ checkExitConditions waiting - Order in progress (${timeSinceOrderStart}ms)`);
        return;
      }
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

      // Get current market prices for both tokens
      // CRITICAL: Use SELL side for exit conditions (we're selling, so need BID prices)
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'SELL'),
        this.clobClient.getPrice(noTokenId, 'SELL'),
      ]);

      if (!yesPrice || !noPrice) {
        return;
      }

      // Convert to percentage scale (0-100)
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

      // Then, check exit conditions for ALL positions using fresh prices
      // Exit ALL positions if ANY position meets profit target or stop loss
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        // Use fresh price from API for exit condition checking
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;
        
        // Also update position price with fresh data
        position.currentPrice = currentPrice;
        const priceDiff = currentPrice - position.entryPrice;
        position.unrealizedProfit = (priceDiff / position.entryPrice) * position.size;

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

      // Log exit condition check with detailed price comparison
      if (!shouldExit) {
        // Log detailed info for debugging exit conditions
        const exitCheckLog = {
          yesSellPrice: yesPricePercent.toFixed(2),
          noSellPrice: noPricePercent.toFixed(2),
          profitTarget: profitTarget.toFixed(2),
          stopLoss: stopLoss.toFixed(2),
          positions: activePositions.map(p => {
            const currentPrice = p.currentPrice || 0;
            return {
              id: p.id.substring(0, 8),
              direction: p.direction,
              entryPrice: p.entryPrice.toFixed(2),
              currentSellPrice: currentPrice.toFixed(2),
              profitCheck: `${currentPrice.toFixed(2)} >= ${profitTarget.toFixed(2)} = ${currentPrice >= profitTarget}`,
              stopLossCheck: `${currentPrice.toFixed(2)} <= ${stopLoss.toFixed(2)} = ${currentPrice <= stopLoss}`,
              unrealizedProfit: p.unrealizedProfit?.toFixed(2),
            };
          }),
        };
        console.log(`[TradingManager] Exit check: NO EXIT`, exitCheckLog);
      }

      if (shouldExit) {
        console.log(`[TradingManager] 🚨🚨🚨 EXIT CONDITION MET - Closing ALL ${activePositions.length} position(s):`, {
          exitReason,
          yesSellPrice: yesPricePercent.toFixed(2),
          noSellPrice: noPricePercent.toFixed(2),
          profitTarget: profitTarget.toFixed(2),
          stopLoss: stopLoss.toFixed(2),
          triggeringPosition: triggeringPosition ? {
            id: triggeringPosition.id.substring(0, 8),
            direction: triggeringPosition.direction,
            entryPrice: triggeringPosition.entryPrice.toFixed(2),
            currentSellPrice: triggeringPosition.currentPrice?.toFixed(2),
            profitCheck: `${triggeringPosition.currentPrice?.toFixed(2)} >= ${profitTarget.toFixed(2)} = ${(triggeringPosition.currentPrice || 0) >= profitTarget}`,
            stopLossCheck: `${triggeringPosition.currentPrice?.toFixed(2)} <= ${stopLoss.toFixed(2)} = ${(triggeringPosition.currentPrice || 0) <= stopLoss}`,
          } : null,
          allPositions: activePositions.map(p => ({
            id: p.id.substring(0, 8),
            direction: p.direction,
            size: p.size.toFixed(2),
            entryPrice: p.entryPrice.toFixed(2),
            currentSellPrice: p.currentPrice?.toFixed(2),
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

        console.log(`[TradingManager] 📤 SELL order ${orderIndex + 1}/${totalOrders} - Attempting to place:`, {
          tokenId: tokenId.substring(0, 10) + '...',
          direction,
          currentSellPrice: currentPricePercent.toFixed(2),
          yesPricePercent: yesPricePercent.toFixed(2),
          noPricePercent: noPricePercent.toFixed(2),
          sellSizeUSD: sellSize.toFixed(2),
          shares: shares.toFixed(4),
          bidPrice: bidPrice.toFixed(4),
        });

        const response = await this.browserClobClient.createAndPostMarketOrder(
          marketOrder,
          { negRisk: false },
          OrderType.FAK
        );

        if (response?.orderID) {
          console.log(`[TradingManager] ✅ SELL order ${orderIndex + 1}/${totalOrders} - SUCCESS:`, {
            orderId: response.orderID.substring(0, 12) + '...',
            fillPrice: currentPricePercent.toFixed(2),
          });
          return {
            success: true,
            orderId: response.orderID,
            fillPrice: currentPricePercent,
          };
        } else {
          const errorMsg = 'No order ID returned from exchange';
          console.error(`[TradingManager] ❌ SELL order ${orderIndex + 1}/${totalOrders} - FAILED:`, {
            error: errorMsg,
            response: response,
            tokenId: tokenId.substring(0, 10) + '...',
          });
          return { success: false, error: errorMsg };
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
   * Aggregate positions by token to calculate total shares
   */
  private aggregatePositionsByToken(positions: Position[]): Map<string, { positions: Position[], totalSize: number, direction: 'UP' | 'DOWN' }> {
    const aggregated = new Map<string, { positions: Position[], totalSize: number, direction: 'UP' | 'DOWN' }>();
    
    for (const position of positions) {
      const tokenId = position.tokenId;
      if (!aggregated.has(tokenId)) {
        aggregated.set(tokenId, {
          positions: [],
          totalSize: 0,
          direction: position.direction || 'UP'
        });
      }
      
      const agg = aggregated.get(tokenId)!;
      agg.positions.push(position);
      agg.totalSize += position.size;
    }
    
    return aggregated;
  }

  /**
   * Close all positions for the current event
   * 
   * IMPROVED BEHAVIOR:
   * - Aggregates positions by token (combines multiple positions for same token)
   * - Sells cumulative shares in ONE order per token
   * - Example: 2 positions of $2 at 65¢ = ONE order for $4 worth of shares (6.15 shares at current price)
   * - More efficient, avoids rate limits, and ensures atomic execution
   * 
   * @param reason - Reason for closing positions
   * @param isStopLoss - If true, uses aggressive mode: no splitting, no delays
   */
  private async closeAllPositions(reason: string, isStopLoss: boolean = false): Promise<void> {
    // CRITICAL: Take a snapshot of positions to ensure they don't change during processing
    const activePositions = [...this.getActivePositions()]; // Spread to create new array

    if (activePositions.length === 0) {
      console.log('[TradingManager] closeAllPositions: No active positions to close');
      return;
    }

    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;
    this.orderPlacementStartTime = Date.now(); // Track when order placement started

    const closedPositionIds: string[] = [];
    const failedPositionIds: string[] = [];
    
    console.log(`[TradingManager] 🔒 Flags locked. isPlacingOrder=${this.isPlacingOrder}, isPlacingSplitOrders=${this.isPlacingSplitOrders}`);
    console.log(`[TradingManager] 📸 Snapshot taken: ${activePositions.length} position(s) to close`);
    
    // Aggregate positions by token
    const aggregatedByToken = this.aggregatePositionsByToken(activePositions);
    console.log(`[TradingManager] 📊 Aggregated into ${aggregatedByToken.size} unique token(s):`, 
      Array.from(aggregatedByToken.entries()).map(([tokenId, data]) => ({
        tokenId: tokenId.substring(0, 10) + '...',
        numPositions: data.positions.length,
        totalSizeUSD: data.totalSize.toFixed(2),
        direction: data.direction,
        positionIds: data.positions.map(p => p.id.substring(0, 8) + '...')
      }))
    );

    try {
      const totalSize = activePositions.reduce((sum, p) => sum + p.size, 0);
      
      // Check if positions have the same token (potential issue)
      const tokenIds = activePositions.map(p => p.tokenId);
      const uniqueTokenIds = new Set(tokenIds);
      const hasDuplicateTokens = uniqueTokenIds.size < tokenIds.length;
      
      console.log(`[TradingManager] 🚨🚨🚨 STARTING TO CLOSE ALL ${activePositions.length} POSITION(S) - ${reason}:`, {
        reason,
        totalSize: totalSize.toFixed(2),
        isStopLoss: isStopLoss ? '⚡ YES - AGGRESSIVE MODE' : 'no',
        activeEventSlug: this.activeEvent?.slug,
        allPositionsInMemory: this.positions.length,
        uniqueTokenIds: uniqueTokenIds.size,
        hasDuplicateTokens: hasDuplicateTokens ? '⚠️ YES - Multiple positions on same token!' : 'no',
        positions: activePositions.map((p, idx) => ({
          index: idx + 1,
          id: p.id.substring(0, 8) + '...',
          tokenId: p.tokenId.substring(0, 10) + '...',
          eventSlug: p.eventSlug,
          direction: p.direction,
          side: p.side,
          size: p.size.toFixed(2),
          entryPrice: p.entryPrice.toFixed(2),
          currentPrice: p.currentPrice?.toFixed(2),
          unrealizedProfit: p.unrealizedProfit?.toFixed(2),
        })),
      });

      // Close positions aggregated by token (cumulative shares per token)
      console.log(`[TradingManager] 🔄 Processing ${aggregatedByToken.size} unique token(s)...`);
      
      let tokenCount = 0;
      for (const [tokenId, aggregatedData] of aggregatedByToken.entries()) {
        tokenCount++;
        console.log(`[TradingManager] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[TradingManager] 🔄 [${tokenCount}/${aggregatedByToken.size}] PROCESSING TOKEN ${tokenCount}`);
        console.log(`[TradingManager] 🔄 Token Details:`, {
          tokenId: tokenId.substring(0, 10) + '...',
          numPositions: aggregatedData.positions.length,
          totalSizeUSD: aggregatedData.totalSize.toFixed(2),
          direction: aggregatedData.direction,
          positionIds: aggregatedData.positions.map(p => p.id.substring(0, 8) + '...')
        });
        
        try {
          // Close all positions for this token in ONE order
          await this.closeAggregatedPositions(aggregatedData.positions, tokenId, aggregatedData.totalSize, aggregatedData.direction, reason, isStopLoss);
          
          // Mark all positions for this token as closed
          for (const pos of aggregatedData.positions) {
            closedPositionIds.push(pos.id);
          }
          
          console.log(`[TradingManager] ✅✅✅ [${tokenCount}/${aggregatedByToken.size}] SUCCESS - Closed ${aggregatedData.positions.length} position(s) for token ${tokenId.substring(0, 10)}...`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          const errorStack = error instanceof Error ? error.stack : undefined;
          
          // Mark all positions for this token as failed
          for (const pos of aggregatedData.positions) {
            failedPositionIds.push(pos.id);
          }
          
          console.error(`[TradingManager] ❌❌❌ [${tokenCount}/${aggregatedByToken.size}] FAILED - Could not close ${aggregatedData.positions.length} position(s) for token ${tokenId.substring(0, 10)}...`);
          console.error(`[TradingManager] ❌ Error details:`, {
            error: errorMsg,
            stack: errorStack,
            tokenId: tokenId.substring(0, 10) + '...',
            totalSize: aggregatedData.totalSize.toFixed(2),
          });
        }
        
        console.log(`[TradingManager] 🏁 [${tokenCount}/${aggregatedByToken.size}] FINISHED processing token ${tokenCount}`);
      }
      
      console.log(`[TradingManager] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[TradingManager] 🏁 ALL ${aggregatedByToken.size} TOKEN(S) PROCESSED`);
      console.log(`[TradingManager] 🏁 Total positions affected: ${activePositions.length}`);

      // Log completion of all attempts
      console.log(`[TradingManager] 🏁 FINISHED processing all ${activePositions.length} position(s). Results:`, {
        attempted: activePositions.length,
        succeeded: closedPositionIds.length,
        failed: failedPositionIds.length,
        closedPositionIds: closedPositionIds.map(id => id.substring(0, 8) + '...'),
        failedPositionIds: failedPositionIds.map(id => id.substring(0, 8) + '...'),
      });
      
      // Remove only successfully closed positions
      if (closedPositionIds.length > 0) {
        const positionsBeforeRemoval = this.positions.length;
        this.positions = this.positions.filter(
          p => !closedPositionIds.includes(p.id)
        );
        const positionsAfterRemoval = this.positions.length;
        
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        
        console.log(`[TradingManager] 📊 Position cleanup: ${positionsBeforeRemoval} → ${positionsAfterRemoval} (removed ${positionsBeforeRemoval - positionsAfterRemoval})`);
        
        if (failedPositionIds.length === 0) {
          console.log(`[TradingManager] ✅✅✅ FULL SUCCESS: All ${closedPositionIds.length} position(s) closed successfully!`);
        } else {
          console.warn(`[TradingManager] ⚠️⚠️⚠️ PARTIAL SUCCESS: Closed ${closedPositionIds.length} of ${activePositions.length} position(s)`);
          console.warn(`[TradingManager] ⚠️ ${failedPositionIds.length} position(s) FAILED to close`);
          
          // Get full position details for failed positions
          const failedPositions = activePositions.filter(p => failedPositionIds.includes(p.id));
          console.error(`[TradingManager] ❌ Failed positions:`, failedPositions.map(p => ({
            id: p.id.substring(0, 8) + '...',
            tokenId: p.tokenId.substring(0, 10) + '...',
            direction: p.direction,
            size: p.size.toFixed(2),
          })));
          
          // CRITICAL: If stop loss and not all positions closed, retry failed ones immediately
          if (isStopLoss && failedPositions.length > 0) {
            console.error(`[TradingManager] 🔄🔄🔄 STOP LOSS RETRY: Attempting to close ${failedPositions.length} failed position(s) again...`);
            console.error(`[TradingManager] 🔄 Waiting 1 second before retry...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Re-aggregate failed positions by token for retry
            const retryAggregated = this.aggregatePositionsByToken(failedPositions);
            console.log(`[TradingManager] 🔄 Retry will process ${retryAggregated.size} token(s) covering ${failedPositions.length} position(s)`);
            
            // Retry each token
            let retryTokenCount = 0;
            for (const [retryTokenId, retryData] of retryAggregated.entries()) {
              retryTokenCount++;
              try {
                console.log(`[TradingManager] 🔄 RETRY ${retryTokenCount}/${retryAggregated.size}: Token ${retryTokenId.substring(0, 10)}... (${retryData.positions.length} positions, $${retryData.totalSize.toFixed(2)})`);
                await this.closeAggregatedPositions(retryData.positions, retryTokenId, retryData.totalSize, retryData.direction, `${reason} - RETRY AFTER FAILURE`, true);
                
                // Mark all positions for this token as closed
                for (const pos of retryData.positions) {
                  closedPositionIds.push(pos.id);
                  // Remove from failed list
                  const idx = failedPositionIds.indexOf(pos.id);
                  if (idx > -1) failedPositionIds.splice(idx, 1);
                }
                
                console.log(`[TradingManager] ✅ RETRY ${retryTokenCount} SUCCESS: ${retryData.positions.length} position(s) closed`);
              } catch (retryError) {
                const retryErrorMsg = retryError instanceof Error ? retryError.message : 'Unknown error';
                console.error(`[TradingManager] ❌ RETRY ${retryTokenCount} FAILED: Token ${retryTokenId.substring(0, 10)}... still could not be closed:`, retryErrorMsg);
              }
            }
            
            // Final cleanup after retry
            this.positions = this.positions.filter(p => !closedPositionIds.includes(p.id));
            this.status.positions = [...this.positions];
            this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
            
            const stillOpenPositions = this.getActivePositions();
            if (stillOpenPositions.length > 0) {
              console.error(`[TradingManager] 🚨 CRITICAL: ${stillOpenPositions.length} position(s) STILL OPEN after retry!`);
              console.error(`[TradingManager] 🚨 You may need to manually close these positions:`, stillOpenPositions.map(p => ({
                id: p.id.substring(0, 8) + '...',
                tokenId: p.tokenId.substring(0, 10) + '...',
                direction: p.direction,
                size: p.size.toFixed(2),
              })));
            } else {
              console.log(`[TradingManager] ✅ RETRY COMPLETE: All positions successfully closed after retry!`);
            }
          }
        }
      } else {
        console.error(`[TradingManager] ❌❌❌ TOTAL FAILURE: No positions were successfully closed out of ${activePositions.length} attempted!`);
        
        // If stop loss and total failure, try one more time
        if (isStopLoss) {
          console.error(`[TradingManager] 🔄 STOP LOSS TOTAL RETRY: All positions failed. Retrying entire process...`);
          // Wait a bit before retry
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Re-aggregate all positions for emergency retry
          const emergencyAggregated = this.aggregatePositionsByToken(activePositions);
          console.log(`[TradingManager] 🔄 Emergency retry will process ${emergencyAggregated.size} token(s)`);
          
          for (const [emergencyTokenId, emergencyData] of emergencyAggregated.entries()) {
            try {
              await this.closeAggregatedPositions(emergencyData.positions, emergencyTokenId, emergencyData.totalSize, emergencyData.direction, `${reason} - EMERGENCY RETRY`, true);
              for (const pos of emergencyData.positions) {
                closedPositionIds.push(pos.id);
              }
            } catch (error) {
              console.error(`[TradingManager] ❌ EMERGENCY RETRY FAILED for token ${emergencyTokenId.substring(0, 10)}...`);
            }
          }
          
          // Final cleanup
          if (closedPositionIds.length > 0) {
            this.positions = this.positions.filter(p => !closedPositionIds.includes(p.id));
            this.status.positions = [...this.positions];
            this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
            console.log(`[TradingManager] 🔄 EMERGENCY RETRY: Closed ${closedPositionIds.length} of ${activePositions.length} position(s)`);
          }
        }
      }

      this.notifyStatusUpdate();
      
      // FINAL VERIFICATION: Check if any positions are still open for this event
      const remainingPositions = this.getActivePositions();
      if (remainingPositions.length > 0) {
        console.error(`[TradingManager] ⚠️⚠️⚠️ VERIFICATION FAILED: ${remainingPositions.length} position(s) still open after closeAllPositions!`);
        console.error(`[TradingManager] Open positions:`, remainingPositions.map(p => ({
          id: p.id.substring(0, 8) + '...',
          tokenId: p.tokenId.substring(0, 10) + '...',
          direction: p.direction,
          size: p.size.toFixed(2),
        })));
      } else {
        console.log(`[TradingManager] ✅ VERIFICATION PASSED: No positions remain open for this event`);
      }
    } catch (error) {
      console.error('[TradingManager] ❌ Error closing all positions:', error);
      
      // Even on error, try to clean up any successfully closed positions
      if (closedPositionIds.length > 0) {
        console.log(`[TradingManager] 🧹 Cleaning up ${closedPositionIds.length} successfully closed position(s) despite error...`);
        this.positions = this.positions.filter(p => !closedPositionIds.includes(p.id));
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        this.notifyStatusUpdate();
      }
    } finally {
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      this.orderPlacementStartTime = 0; // Reset timer
      
      console.log(`[TradingManager] 🔓 Flags unlocked. isPlacingOrder=${this.isPlacingOrder}, isPlacingSplitOrders=${this.isPlacingSplitOrders}`);
      console.log(`[TradingManager] 🏁 closeAllPositions finished. Final position count: ${this.positions.length}`);
    }
  }

  /**
   * Close multiple positions for the same token in ONE aggregated order
   * This sells cumulative shares in a single transaction
   */
  private async closeAggregatedPositions(
    positions: Position[],
    tokenId: string,
    totalSizeUSD: number,
    direction: 'UP' | 'DOWN',
    reason: string,
    isStopLoss: boolean
  ): Promise<void> {
    console.log(`[TradingManager] 💰 AGGREGATED CLOSE: Selling ${positions.length} position(s) for token ${tokenId.substring(0, 10)}...`, {
      totalSizeUSD: totalSizeUSD.toFixed(2),
      direction,
      positions: positions.map(p => ({
        id: p.id.substring(0, 8) + '...',
        size: p.size.toFixed(2),
        entryPrice: p.entryPrice.toFixed(2)
      }))
    });

    if (!this.apiCredentials) {
      // Simulation mode
      const avgEntryPrice = positions.reduce((sum, p) => sum + p.entryPrice * p.size, 0) / totalSizeUSD;
      const exitPricePercent = avgEntryPrice;
      const priceDiff = exitPricePercent - avgEntryPrice;
      const profit = (priceDiff / avgEntryPrice) * totalSizeUSD;

      const exitTrade: Trade = {
        id: `exit-aggregated-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventSlug: positions[0].eventSlug,
        tokenId,
        side: 'SELL',
        size: totalSizeUSD,
        price: exitPricePercent,
        timestamp: Date.now(),
        status: 'filled',
        transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
        profit,
        reason: `Simulated aggregated exit (${positions.length} positions): ${reason}`,
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

    // Get current market price for selling
    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      throw new Error('Cannot close positions: missing event or token IDs');
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];

    const [yesPrice, noPrice] = await Promise.all([
      this.clobClient.getPrice(yesTokenId, 'SELL'),
      this.clobClient.getPrice(noTokenId, 'SELL'),
    ]);

    if (!yesPrice || !noPrice) {
      throw new Error('Cannot close positions: failed to fetch prices');
    }

    const yesPricePercent = toPercentage(yesPrice);
    const noPricePercent = toPercentage(noPrice);
    const currentPricePercent = direction === 'UP' ? yesPricePercent : noPricePercent;
    const currentPriceDecimal = currentPricePercent / 100;

    // Calculate total shares from cumulative USD size
    const totalShares = totalSizeUSD / currentPriceDecimal;

    console.log(`[TradingManager] 📊 AGGREGATED SELL CALCULATION:`, {
      totalSizeUSD: totalSizeUSD.toFixed(2),
      currentSellPrice: currentPricePercent.toFixed(4),
      totalShares: totalShares.toFixed(4),
      numPositions: positions.length
    });

    // Place ONE sell order for all cumulative shares
    const result = await this.placeSingleSellOrder(
      tokenId,
      totalSizeUSD,
      direction,
      0,
      1,
      yesPricePercent,
      noPricePercent
    );

    if (!result.success || !result.orderId || result.fillPrice === undefined) {
      throw new Error(`Aggregated sell order failed: ${result.error || 'Unknown error'}`);
    }

    // Calculate weighted average entry price
    const avgEntryPrice = positions.reduce((sum, p) => sum + p.entryPrice * p.size, 0) / totalSizeUSD;
    const priceDiff = result.fillPrice - avgEntryPrice;
    const totalProfit = (priceDiff / avgEntryPrice) * totalSizeUSD;

    // Create exit trade record
    const exitTrade: Trade = {
      id: `exit-aggregated-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      eventSlug: positions[0].eventSlug,
      tokenId,
      side: 'SELL',
      size: totalSizeUSD,
      price: result.fillPrice,
      timestamp: Date.now(),
      status: 'filled',
      transactionHash: result.orderId,
      profit: totalProfit,
      reason: `Aggregated exit (${positions.length} positions${isStopLoss ? ' - ⚡STOP LOSS⚡' : ''}): ${reason}`,
      orderType: 'MARKET',
      direction,
    };

    this.trades.push(exitTrade);
    this.status.totalTrades++;
    this.status.totalProfit += totalProfit;
    this.status.successfulTrades++;
    this.notifyTradeUpdate(exitTrade);

    console.log(`[TradingManager] ✅ AGGREGATED CLOSE SUCCESS:`, {
      numPositions: positions.length,
      totalSizeUSD: totalSizeUSD.toFixed(2),
      avgEntryPrice: avgEntryPrice.toFixed(2),
      exitPrice: result.fillPrice.toFixed(2),
      totalProfit: totalProfit.toFixed(2),
      orderId: result.orderId.substring(0, 12) + '...'
    });
  }

  /**
   * Aggressive stop loss exit - immediately sells ALL positions at market price
   * No delays, no splitting, no adaptive selling - just immediate market orders
   * For UP direction: when yesPricePercent <= stopLoss, aggressively sell all positions
   * For DOWN direction: when noPricePercent <= stopLoss, aggressively sell all positions
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

    const currentPricePercent = isDownDirection ? noPricePercent : yesPricePercent;
    
    console.log('[TradingManager] 🛑🛑🛑 AGGRESSIVE STOP LOSS TRIGGERED - Immediately selling ALL positions:', {
      stopLossPrice,
      direction: isDownDirection ? 'DOWN' : 'UP',
      currentPrice: currentPricePercent.toFixed(2),
      numPositions: activePositions.length,
      reason,
    });

    // Aggressive mode: immediately sell all positions at market price
    // No delays, no splitting, no adaptive selling - just immediate market orders
    await this.closeAllPositions(`${reason} - Aggressive stop loss exit at ${currentPricePercent.toFixed(2)}`, true);
  }

  /**
   * Close a single position
   * @param position - Position to close
   * @param reason - Reason for closing
   * @param isStopLoss - If true, uses aggressive mode: no splitting, no delays between orders
   */
  private async closeSinglePosition(position: Position, reason: string, isStopLoss: boolean = false): Promise<void> {
    const positionSize = position.size;
    const direction = position.direction || 'UP';

    // For stop loss: no splitting - sell entire position at once for maximum speed
    // For normal exits: split large positions (>50) into 3 orders
    const numSplits = isStopLoss ? 1 : (positionSize > 50 ? 3 : 1);
    const sizePerSplit = positionSize / numSplits;

    console.log(`[TradingManager] 🔄 CLOSING SINGLE POSITION (SELL) - Position ${position.id.substring(0, 8)}...`, {
      positionId: position.id,
      tokenId: position.tokenId.substring(0, 10) + '...',
      direction: direction,
      sizeUSD: positionSize.toFixed(2),
      entryPrice: position.entryPrice.toFixed(2),
      currentPrice: position.currentPrice?.toFixed(2),
      isStopLoss: isStopLoss ? '⚡ YES' : 'no',
      numSplits: numSplits,
      sizePerSplit: sizePerSplit.toFixed(2),
      reason: reason,
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
          reason: `${isStopLoss ? '🛑 AGGRESSIVE STOP LOSS: ' : ''}Exit ${numSplits > 1 ? `(${i + 1}/${numSplits}) ` : ''}${reason}`,
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

      // For stop loss: NO delays between orders - maximum speed
      // For normal exits: small delay between split orders
      if (!isStopLoss && i < numSplits - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (totalFilledSize > 0) {
      this.status.successfulTrades++;
      this.status.totalProfit += totalProfit;
      console.log(`[TradingManager] ✅✅✅ Single position closed${isStopLoss ? ' (⚡AGGRESSIVE STOP LOSS⚡)' : ''}:`, {
        positionId: position.id.substring(0, 8) + '...',
        tokenId: position.tokenId.substring(0, 10) + '...',
        direction,
        plannedSize: positionSize.toFixed(2),
        actualFilledSize: totalFilledSize.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        numOrdersAttempted: numSplits,
        numOrdersFilled: exitTrades.length,
        percentageFilled: ((totalFilledSize / positionSize) * 100).toFixed(1) + '%',
      });
    } else {
      const errorMsg = `All ${numSplits} sell order(s) failed for position ${position.id}`;
      console.error(`[TradingManager] ❌❌❌ ${errorMsg}`, {
        positionId: position.id.substring(0, 8) + '...',
        tokenId: position.tokenId.substring(0, 10) + '...',
        direction,
        sizeAttempted: positionSize.toFixed(2),
        numSplits: numSplits,
      });
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
    this.consecutiveFailures = 0; // Reset circuit breaker on start
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
    console.log('[TradingManager] 🟢 Starting continuous monitoring...');
    
    let loopCount = 0;
    const heartbeatInterval = 100; // Log heartbeat every 100 loops (10 seconds at 100ms per loop)

    // Continuous monitoring loop
    while (this.isMonitoring && this.status.isActive) {
      try {
        loopCount++;
        
        // Heartbeat log every ~10 seconds to confirm loop is running
        if (loopCount % heartbeatInterval === 0) {
          console.log(`[TradingManager] 💓 Monitoring heartbeat (loop ${loopCount}): active=${this.status.isActive}, positions=${this.positions.length}`);
        }
        
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

    console.log('[TradingManager] 🔴 Continuous monitoring stopped');
  }

  stopTrading(): void {
    this.status.isActive = false;
    this.isMonitoring = false; // Stop continuous monitoring loop
    this.consecutiveFailures = 0; // Reset circuit breaker
    
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
    
    // Check if there are other positions for this event
    const activePositions = this.getActivePositions();
    if (activePositions.length > 1) {
      console.warn(`[TradingManager] ⚠️⚠️⚠️ WARNING: Closing 1 of ${activePositions.length} positions manually.`);
      console.warn(`[TradingManager] ⚠️ Other ${activePositions.length - 1} position(s) will remain open:`, 
        activePositions.filter(p => p.id !== positionId).map(p => ({
          id: p.id.substring(0, 8) + '...',
          direction: p.direction,
          size: p.size.toFixed(2),
        }))
      );
      console.warn(`[TradingManager] 💡 TIP: Use closeAllPositionsManually() to close all positions at once`);
    }

    console.log(`[TradingManager] 🔄 Manually closing single position ${positionId.substring(0, 8)}...`);
    
    // Close this specific position
    await this.closeSinglePosition(position, reason);
    
    // Remove from positions array
    this.positions = this.positions.filter(p => p.id !== positionId);
    this.status.positions = [...this.positions];
    this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
    
    console.log(`[TradingManager] ✅ Position ${positionId.substring(0, 8)}... closed. ${this.positions.length} position(s) remaining.`);
    
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
