import type { StrategyConfig, Trade, TradingStatus } from './trading-types';
import { CLOBClientWrapper } from './clob-client';
import type { EventDisplayData } from './event-manager';
import type { ClobClient } from '@polymarket/clob-client';
import { logger } from './utils/logger';
import { TradingError, ErrorCode, OrderError, ValidationError, retryWithBackoff, isRetryableError, wrapError } from './utils/errors';
import { toPercentage, fetchBothPrices, fetchBrowserPriceWithRetry, validateDecimalPrice } from './utils/price-utils';

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
      profitTargetPrice: 99, // Take profit at 100
      stopLossPrice: 91, // Stop loss at 91
      tradeSize: 50, // $50 trade size
    };
  }

  setStrategyConfig(config: Partial<StrategyConfig>): void {
    // Validate config before setting
    this.validateStrategyConfig(config);
    this.strategyConfig = { ...this.strategyConfig, ...config };
    this.saveStrategyConfig();
  }

  /**
   * Validate strategy configuration
   */
  private validateStrategyConfig(config: Partial<StrategyConfig>): void {
    if (config.entryPrice !== undefined) {
      if (config.entryPrice < 0 || config.entryPrice > 100) {
        throw new ValidationError('Entry price must be between 0 and 100', 'entryPrice', config.entryPrice);
      }
    }

    if (config.profitTargetPrice !== undefined) {
      if (config.profitTargetPrice < 0 || config.profitTargetPrice > 100) {
        throw new ValidationError('Profit target must be between 0 and 100', 'profitTargetPrice', config.profitTargetPrice);
      }
    }

    if (config.stopLossPrice !== undefined) {
      if (config.stopLossPrice < 0 || config.stopLossPrice > 100) {
        throw new ValidationError('Stop loss must be between 0 and 100', 'stopLossPrice', config.stopLossPrice);
      }
    }

    if (config.tradeSize !== undefined) {
      if (config.tradeSize <= 0) {
        throw new ValidationError('Trade size must be greater than 0', 'tradeSize', config.tradeSize);
      }
    }

    // Validate logical relationships
    if (config.entryPrice !== undefined && config.profitTargetPrice !== undefined) {
      if (config.profitTargetPrice <= config.entryPrice) {
        throw new ValidationError('Profit target must be greater than entry price', 'profitTargetPrice', config.profitTargetPrice);
      }
    }

    if (config.entryPrice !== undefined && config.stopLossPrice !== undefined) {
      if (config.stopLossPrice >= config.entryPrice) {
        throw new ValidationError('Stop loss must be less than entry price', 'stopLossPrice', config.stopLossPrice);
      }
    }
  }

  getStrategyConfig(): StrategyConfig {
    return { ...this.strategyConfig };
  }

  private saveStrategyConfig(): void {
    try {
      localStorage.setItem('tradingStrategy', JSON.stringify(this.strategyConfig));
    } catch (error) {
      logger.warn('TradingManager', 'saveStrategyConfig', 'Failed to save strategy config', { error: String(error) });
    }
  }

  loadStrategyConfig(): void {
    try {
      const saved = localStorage.getItem('tradingStrategy');
      if (saved) {
        this.strategyConfig = { ...this.strategyConfig, ...JSON.parse(saved) };
      }
    } catch (error) {
      logger.warn('TradingManager', 'loadStrategyConfig', 'Failed to load strategy config', { error: String(error) });
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
      logger.info('TradingManager', 'setBrowserClobClient', 'Browser ClobClient set - orders will be placed from browser (bypasses Cloudflare)');
    } else {
      logger.info('TradingManager', 'setBrowserClobClient', 'Browser ClobClient cleared - will fall back to server-side API');
    }
  }

  /**
   * Get API credentials
   */
  getApiCredentials(): { key: string; secret: string; passphrase: string } | null {
    return this.apiCredentials;
  }

  /**
   * Get browser ClobClient (for manual order placement)
   */
  getBrowserClobClient(): ClobClient | null {
    return this.browserClobClient;
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

    // If we have a position, check exit conditions FIRST (regardless of price difference)
    // Price difference check only applies to entry conditions, not exit conditions
    if (this.status.currentPosition?.eventSlug === this.activeEvent.slug) {
      await this.checkExitConditions();
      return;
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
   * Check both UP and DOWN tokens and place market order when price is in entry range
   * Order is filled when UP or DOWN value is >= entryPrice and <= entryPrice + 1
   */
  private async checkAndPlaceMarketOrder(yesTokenId: string, noTokenId: string): Promise<void> {
    try {
      if (!this.activeEvent) {
        throw new TradingError('No active event', ErrorCode.NO_ACTIVE_EVENT);
      }

      const entryPrice = this.strategyConfig.entryPrice;
      const entryPriceMax = entryPrice + 1; // Maximum entry price (range-based)

      // Get current market prices for both tokens (BUY side for entry condition checking) with retry
      const { yesPricePercent, noPricePercent } = await fetchBothPrices(
        this.clobClient,
        yesTokenId,
        noTokenId,
        'BUY',
        3
      );

      // Check if either token price is within entry range (entryPrice <= price <= entryPrice + 1)
      let tokenToTrade: string | null = null;
      let direction: 'UP' | 'DOWN' | null = null;

      // Check UP token first (YES token) - range-based entry
      if (yesPricePercent >= entryPrice && yesPricePercent <= entryPriceMax) {
        tokenToTrade = yesTokenId;
        direction = 'UP';
        logger.info('TradingManager', 'checkAndPlaceMarketOrder', `Entry condition met: yesTokenPrice ${yesPricePercent.toFixed(2)} >= entryPrice ${entryPrice.toFixed(2)} (within range up to ${entryPriceMax.toFixed(2)}) → Filling UP position`, {
          yesPricePercent: yesPricePercent.toFixed(2),
          entryPrice: entryPrice.toFixed(2),
          entryPriceMax: entryPriceMax.toFixed(2),
          direction: 'UP',
        });
      }
      // Check DOWN token (NO token) - range-based entry, only if UP token hasn't matched
      else if (noPricePercent >= entryPrice && noPricePercent <= entryPriceMax) {
        tokenToTrade = noTokenId;
        direction = 'DOWN';
        logger.info('TradingManager', 'checkAndPlaceMarketOrder', `Entry condition met: noTokenPrice ${noPricePercent.toFixed(2)} >= entryPrice ${entryPrice.toFixed(2)} (within range up to ${entryPriceMax.toFixed(2)}) → Filling DOWN position`, {
          noPricePercent: noPricePercent.toFixed(2),
          entryPrice: entryPrice.toFixed(2),
          entryPriceMax: entryPriceMax.toFixed(2),
          direction: 'DOWN',
        });
      } else {
        // Log why entry condition wasn't met for debugging
        logger.debug('TradingManager', 'checkAndPlaceMarketOrder', 'Entry condition not met', {
          yesPricePercent: yesPricePercent.toFixed(2),
          noPricePercent: noPricePercent.toFixed(2),
          entryPrice: entryPrice.toFixed(2),
          entryPriceMax: entryPriceMax.toFixed(2),
          yesInRange: yesPricePercent >= entryPrice && yesPricePercent <= entryPriceMax,
          noInRange: noPricePercent >= entryPrice && noPricePercent <= entryPriceMax,
        });
      }

      // Place market order when price is within entry range
      if (tokenToTrade && direction) {
        await this.placeMarketOrder(tokenToTrade, entryPrice, direction);
      }
    } catch (error) {
      logger.error('TradingManager', 'checkAndPlaceMarketOrder', 'Error checking for market order placement', error);
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
        throw new TradingError('No API credentials', ErrorCode.NO_API_CREDENTIALS);
      }

      if (this.browserClobClient) {
        const browserClient = this.browserClobClient; // Store reference to avoid null check issues
        return await retryWithBackoff(
          async () => {
            const { OrderType, Side } = await import('@polymarket/clob-client');
            
            // For BUY orders, use BUY side to get ask price
            const askPrice = await fetchBrowserPriceWithRetry(browserClient, tokenId, 'BUY', 3, 500);
            validateDecimalPrice(askPrice, 'askPrice');

            // Get fee rate with error handling
            let feeRateBps: number;
            try {
              feeRateBps = await browserClient.getFeeRateBps(tokenId);
              if (!feeRateBps || feeRateBps === 0) {
                feeRateBps = 1000;
              }
            } catch (error) {
              logger.warn('TradingManager', 'placeSingleMarketOrder', 'Failed to fetch fee rate, using default', { error: String(error) });
              feeRateBps = 1000;
            }

            const marketOrder = {
              tokenID: tokenId,
              amount: orderSize,
              side: Side.BUY,
              feeRateBps: feeRateBps,
            };

            logger.debug('TradingManager', 'placeSingleMarketOrder', `Placing split order ${orderIndex + 1}/${totalOrders} at target price ${targetPrice.toFixed(2)}`, {
              targetPrice: targetPrice.toFixed(2),
              currentPrice: toPercentage(askPrice).toFixed(2),
              orderSize: orderSize.toFixed(2),
              orderIndex,
              totalOrders,
            });

            const response = await browserClient.createAndPostMarketOrder(
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
              throw new OrderError('No order ID returned', { tokenId, orderIndex, totalOrders });
            }
          },
          3, // maxRetries
          1000, // initialDelay
          2, // backoffMultiplier
          (error) => isRetryableError(error) || error instanceof OrderError
        );
      } else {
        // Fallback to server-side API with retry
        return await retryWithBackoff(
          async () => {
            // For BUY orders, use BUY side to get ask price
            const askPrice = await this.clobClient.getPrice(tokenId, 'BUY');
            if (!askPrice || isNaN(askPrice) || askPrice <= 0 || askPrice >= 1) {
              throw new ValidationError('Invalid market price', 'askPrice', askPrice);
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

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
              throw new OrderError(errorData.error || 'Order failed', { 
                status: response.status,
                tokenId,
                orderIndex,
              }, response.status >= 500);
            }

            const data = await response.json();
            if (data.orderId) {
              return {
                success: true,
                orderId: data.orderId,
                fillPrice: toPercentage(askPrice),
              };
            } else {
              throw new OrderError(data.error || 'Order failed', { tokenId, orderIndex });
            }
          },
          3,
          1000,
          2,
          (error) => isRetryableError(error)
        );
      }
    } catch (error) {
      const tradingError = wrapError(error, ErrorCode.ORDER_PLACEMENT_FAILED);
      logger.error('TradingManager', 'placeSingleMarketOrder', 'Error placing single market order', tradingError, {
        tokenId,
        orderIndex,
        totalOrders,
      });
      return {
        success: false,
        error: tradingError.getUserMessage(),
      };
    }
  }

  /**
   * Handle simulated buy order (for testing without API credentials)
   */
  private handleSimulatedBuyOrder(tokenId: string, entryPrice: number, tradeSize: number, direction: 'UP' | 'DOWN'): void {
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
  }

  /**
   * Execute buy order splits and return filled orders
   */
  private async executeBuyOrderSplits(
    tokenId: string,
    orderSplits: Array<{ price: number; size: number }>,
    direction: 'UP' | 'DOWN',
    isLargeOrder: boolean
  ): Promise<Array<{ orderId: string; price: number; size: number; timestamp: number }>> {
    const filledOrders: Array<{ orderId: string; price: number; size: number; timestamp: number }> = [];

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
        logger.error('TradingManager', 'executeBuyOrderSplits', `Split order ${i + 1}/${orderSplits.length} failed`, undefined, {
          orderIndex: i + 1,
          totalOrders: orderSplits.length,
          error: result.error,
        });
      }

      // Small delay between split orders to avoid rate limiting
      if (i < orderSplits.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return filledOrders;
  }

  /**
   * Create position from filled orders
   */
  private createPositionFromFilledOrders(
    tokenId: string,
    filledOrders: Array<{ orderId: string; price: number; size: number; timestamp: number }>,
    direction: 'UP' | 'DOWN'
  ): void {
    const totalFilledSize = filledOrders.reduce((sum, order) => sum + order.size, 0);
    const avgEntryPrice = this.calculateWeightedAverageEntryPrice(
      filledOrders.map(o => ({ price: o.price, size: o.size }))
    );

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
    logger.info('TradingManager', 'createPositionFromFilledOrders', 'Position created', {
      direction,
      totalSize: totalFilledSize.toFixed(2),
      avgEntryPrice: avgEntryPrice.toFixed(2),
      numOrders: filledOrders.length,
    });
  }

  /**
   * Schedule order fetch after buy orders are placed
   */
  private scheduleOrderFetch(): void {
    logger.debug('TradingManager', 'scheduleOrderFetch', 'All buy orders placed, will fetch order details in 2 seconds');
    setTimeout(() => {
      if (this.onTradeUpdate && this.trades.length > 0) {
        const lastTrade = this.trades[this.trades.length - 1];
        if (lastTrade) {
          logger.debug('TradingManager', 'scheduleOrderFetch', 'Triggering order fetch after buy orders');
          this.onTradeUpdate(lastTrade);
        }
      }
    }, 2000);
  }

  /**
   * Place a market order (Fill or Kill) when trading conditions match
   * For large trade sizes (>50 USD), splits orders across entryPrice to entryPrice + 2
   * Uses builder attribution via remote signing through /api/orders endpoint
   */
  private async placeMarketOrder(tokenId: string, entryPrice: number, direction: 'UP' | 'DOWN'): Promise<void> {
    // Prevent multiple simultaneous orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      logger.debug('TradingManager', 'placeMarketOrder', 'Order already being placed, skipping');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    try {
      const tradeSize = this.strategyConfig.tradeSize;
      const orderSplits = this.calculateOrderSplits(tradeSize, entryPrice);
      const isLargeOrder = tradeSize > 50;

      logger.info('TradingManager', 'placeMarketOrder', 'Placing market order', {
        tokenId,
        direction,
        entryPrice,
        tradeSize,
        isLargeOrder,
        numSplits: orderSplits.length,
        splits: orderSplits,
      });

      if (!this.apiCredentials) {
        this.handleSimulatedBuyOrder(tokenId, entryPrice, tradeSize, direction);
        return;
      }

      // Place real orders (single or split)
      const filledOrders = await this.executeBuyOrderSplits(tokenId, orderSplits, direction, isLargeOrder);

      if (filledOrders.length > 0) {
        this.createPositionFromFilledOrders(tokenId, filledOrders, direction);
        this.scheduleOrderFetch();
      } else {
        logger.error('TradingManager', 'placeMarketOrder', 'All orders failed');
        this.status.failedTrades++;
      }

      this.notifyStatusUpdate();
    } catch (error) {
      logger.error('TradingManager', 'placeMarketOrder', 'Error placing market order', error);
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

        logger.info('TradingManager', 'checkLimitOrderFill', `Limit order filled: ${pendingOrder.id} at ${currentPricePercent.toFixed(2)}`, {
          orderId: pendingOrder.id,
          fillPrice: currentPricePercent.toFixed(2),
        });

        this.notifyTradeUpdate(pendingOrder);
        this.notifyStatusUpdate();
      }
    } catch (error) {
      logger.error('TradingManager', 'checkLimitOrderFill', 'Error checking limit order fill', error);
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
    if (!this.status.currentPosition) {
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

      // Get current market prices for both tokens (same as entry condition) with retry
      const { yesPricePercent, noPricePercent } = await fetchBothPrices(
        this.clobClient,
        yesTokenId,
        noTokenId,
        'BUY',
        3
      );

      const entryPrice = this.status.currentPosition.entryPrice;
      const profitTarget = this.strategyConfig.profitTargetPrice;
      const stopLoss = this.strategyConfig.stopLossPrice;
      const direction = this.status.currentPosition.direction;

      // Use the appropriate price based on direction
      const currentPricePercent = direction === 'UP' ? yesPricePercent : noPricePercent;

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

      // Check exit conditions based on direction using yesPricePercent/noPricePercent
      // Add debug logging to track condition checks
      logger.debug('TradingManager', 'checkExitConditions', 'Checking exit conditions', {
        direction,
        yesPricePercent: yesPricePercent.toFixed(2),
        noPricePercent: noPricePercent.toFixed(2),
        profitTarget: profitTarget.toFixed(2),
        stopLoss: stopLoss.toFixed(2),
        entryPrice: entryPrice.toFixed(2),
      });

      if (direction === 'UP') {
        // UP direction: 
        // - Profit target: when UP value >= profit target
        // - Stop loss: when UP value <= stop loss (with adaptive selling)
        if (yesPricePercent >= profitTarget) {
          logger.info('TradingManager', 'checkExitConditions', `UP profit target met: ${yesPricePercent.toFixed(2)} >= ${profitTarget.toFixed(2)}`, {
            direction: 'UP',
            yesPricePercent: yesPricePercent.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
          });
          await this.closePosition(`Profit target reached at ${yesPricePercent.toFixed(2)}`);
        } else if (yesPricePercent <= stopLoss) {
          // UP price dropped to stop loss - try to sell immediately, use adaptive selling as fallback
          logger.warn('TradingManager', 'checkExitConditions', `UP stop loss triggered: yesPricePercent ${yesPricePercent.toFixed(2)} <= stop loss ${stopLoss.toFixed(2)}`, {
            direction: 'UP',
            yesPricePercent: yesPricePercent.toFixed(2),
            stopLoss: stopLoss.toFixed(2),
          });
          await this.closePositionWithAdaptiveSelling(`Stop loss triggered at ${yesPricePercent.toFixed(2)}`, stopLoss, false, yesPricePercent, noPricePercent);
        } else {
          logger.debug('TradingManager', 'checkExitConditions', `No exit condition met for UP: price ${yesPricePercent.toFixed(2)} (target: ${profitTarget.toFixed(2)}, stop: ${stopLoss.toFixed(2)})`, {
            direction: 'UP',
            yesPricePercent: yesPricePercent.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
            stopLoss: stopLoss.toFixed(2),
          });
        }
      } else {
        // DOWN direction:
        // - Profit target: when DOWN value >= profit target
        // - Stop loss: when DOWN value <= stop loss (with adaptive selling)
        if (noPricePercent >= profitTarget) {
          logger.info('TradingManager', 'checkExitConditions', `DOWN profit target met: ${noPricePercent.toFixed(2)} >= ${profitTarget.toFixed(2)}`, {
            direction: 'DOWN',
            noPricePercent: noPricePercent.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
          });
          await this.closePosition(`Profit target reached at ${noPricePercent.toFixed(2)}`);
        } else if (noPricePercent <= stopLoss) {
          // DOWN price dropped to stop loss - try to sell immediately, use adaptive selling as fallback
          logger.warn('TradingManager', 'checkExitConditions', `DOWN stop loss triggered: noPricePercent ${noPricePercent.toFixed(2)} <= stop loss ${stopLoss.toFixed(2)}`, {
            direction: 'DOWN',
            noPricePercent: noPricePercent.toFixed(2),
            stopLoss: stopLoss.toFixed(2),
          });
          await this.closePositionWithAdaptiveSelling(`Stop loss triggered at ${noPricePercent.toFixed(2)}`, stopLoss, true, yesPricePercent, noPricePercent);
        } else {
          logger.debug('TradingManager', 'checkExitConditions', `No exit condition met for DOWN: price ${noPricePercent.toFixed(2)} (target: ${profitTarget.toFixed(2)}, stop: ${stopLoss.toFixed(2)})`, {
            direction: 'DOWN',
            noPricePercent: noPricePercent.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
            stopLoss: stopLoss.toFixed(2),
          });
        }
      }

      this.notifyStatusUpdate();
    } catch (error) {
      logger.error('TradingManager', 'checkExitConditions', 'Error checking exit conditions', error);
    }
  }

  /**
   * Attempt immediate sell at current market price
   */
  private async attemptImmediateSell(
    reason: string,
    currentPricePercent: number
  ): Promise<void> {
    logger.info('TradingManager', 'attemptImmediateSell', `Attempting immediate sell at current market price: ${currentPricePercent.toFixed(2)}`, {
      currentPrice: currentPricePercent.toFixed(2),
    });
    
    this.isPlacingOrder = false;
    this.isPlacingSplitOrders = false;
    await this.closePosition(`${reason} - Immediate sell at ${currentPricePercent.toFixed(2)}`);
  }

  /**
   * Attempt adaptive sell with progressively lower prices
   */
  private async attemptAdaptiveSell(
    reason: string,
    stopLossPrice: number,
    isDownDirection: boolean,
    yesPricePercent: number,
    noPricePercent: number
  ): Promise<boolean> {
    const maxAttempts = 5;
    logger.info('TradingManager', 'attemptAdaptiveSell', 'Using adaptive selling as fallback', {
      stopLossPrice,
      maxAttempts,
      isDownDirection,
    });

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const targetPrice = stopLossPrice - attempt;
      
      if (targetPrice < 0 || targetPrice > 100) {
        logger.warn('TradingManager', 'attemptAdaptiveSell', 'Target price out of range, using market price', {
          targetPrice,
          attempt: attempt + 1,
        });
        return false;
      }

      try {
        logger.debug('TradingManager', 'attemptAdaptiveSell', `Adaptive attempt ${attempt + 1}/${maxAttempts}: Trying to sell at price ${targetPrice.toFixed(2)}`, {
          attempt: attempt + 1,
          maxAttempts,
          targetPrice: targetPrice.toFixed(2),
        });
        
        const currentPrice = isDownDirection ? noPricePercent : yesPricePercent;
        const canSell = currentPrice <= targetPrice;
          
        if (canSell) {
          logger.info('TradingManager', 'attemptAdaptiveSell', `Current price ${currentPrice.toFixed(2)} meets target ${targetPrice.toFixed(2)}, proceeding with sale`, {
            currentPrice: currentPrice.toFixed(2),
            targetPrice: targetPrice.toFixed(2),
          });
          this.isPlacingOrder = false;
          this.isPlacingSplitOrders = false;
          await this.closePosition(`${reason} - Adaptive sell at ${currentPrice.toFixed(2)} (target was ${targetPrice.toFixed(2)})`);
          return true;
        } else {
          logger.debug('TradingManager', 'attemptAdaptiveSell', `Current price ${currentPrice.toFixed(2)} is above target ${targetPrice.toFixed(2)}, will try lower price on next attempt`, {
            currentPrice: currentPrice.toFixed(2),
            targetPrice: targetPrice.toFixed(2),
          });
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        logger.error('TradingManager', 'attemptAdaptiveSell', `Error on adaptive attempt ${attempt + 1}`, error, {
          attempt: attempt + 1,
          maxAttempts,
        });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return false;
  }

  /**
   * Close position with adaptive selling for stop loss
   * Uses yesPricePercent and noPricePercent (same as entry/exit conditions)
   * First tries to sell immediately at current market price
   * If that fails, uses adaptive selling as fallback:
   *   - For both UP and DOWN directions: Tries progressively lower prices (stopLoss, stopLoss-1, stopLoss-2, etc.)
   *   - This ensures quick exit to stop the loss
   */
  private async closePositionWithAdaptiveSelling(
    reason: string, 
    stopLossPrice: number, 
    isDownDirection: boolean = false,
    yesPricePercent: number,
    noPricePercent: number
  ): Promise<void> {
    if (!this.status.currentPosition) {
      return;
    }

    // Prevent multiple simultaneous exit orders
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      logger.debug('TradingManager', 'closePositionWithAdaptiveSelling', 'Exit order already being placed, skipping');
      return;
    }

    this.isPlacingOrder = true;
    this.isPlacingSplitOrders = true;

    try {
      const currentPricePercent = isDownDirection ? noPricePercent : yesPricePercent;
      
      logger.warn('TradingManager', 'closePositionWithAdaptiveSelling', 'Stop loss triggered - attempting immediate sell', {
        stopLossPrice,
        direction: isDownDirection ? 'DOWN' : 'UP',
        currentPrice: currentPricePercent.toFixed(2),
        reason,
      });

      // Try immediate sell first
      await this.attemptImmediateSell(reason, currentPricePercent);
      
      // If immediate sell didn't work, try adaptive selling
      this.isPlacingOrder = true;
      this.isPlacingSplitOrders = true;
      
      const adaptiveSuccess = await this.attemptAdaptiveSell(
        reason,
        stopLossPrice,
        isDownDirection,
        yesPricePercent,
        noPricePercent
      );

      // If all adaptive attempts failed, sell at current market price anyway
      if (!adaptiveSuccess) {
        logger.warn('TradingManager', 'closePositionWithAdaptiveSelling', 'All adaptive attempts failed, selling at current market price to stop loss', {
          maxAttempts: 5,
        });
        this.isPlacingOrder = false;
        this.isPlacingSplitOrders = false;
        await this.closePosition(`${reason} - All attempts failed, selling at market price to stop loss`);
      }
    } catch (error) {
      logger.error('TradingManager', 'closePositionWithAdaptiveSelling', 'Error in adaptive selling', error);
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      // Fall back to regular close position
      await this.closePosition(reason);
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

        logger.debug('TradingManager', 'placeSingleSellOrder', `Placing split SELL order ${orderIndex + 1}/${totalOrders}`, {
          direction,
          currentPrice: currentPricePercent.toFixed(2),
          yesPricePercent: yesPricePercent.toFixed(2),
          noPricePercent: noPricePercent.toFixed(2),
          sellSizeUSD: sellSize.toFixed(2),
          shares: shares.toFixed(2),
          orderIndex,
          totalOrders,
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
   * Handle simulated sell order (for testing without API credentials)
   */
  private handleSimulatedSellOrder(reason: string): void {
    const position = this.status.currentPosition!;
    const exitPricePercent = position.entryPrice; // Use entry price for simulation
    const priceDiff = exitPricePercent - position.entryPrice;
    const profit = (priceDiff / position.entryPrice) * position.size;

    const exitTrade: Trade = {
      id: `exit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      eventSlug: position.eventSlug,
      tokenId: position.tokenId,
      side: 'SELL',
      size: position.size,
      price: exitPricePercent,
      timestamp: Date.now(),
      status: 'filled',
      transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
      profit,
      reason: `Simulated exit: ${reason}`,
      orderType: 'MARKET',
      direction: position.direction,
    };

    this.trades.push(exitTrade);
    this.status.totalTrades++;
    this.status.totalProfit += profit;
    this.status.successfulTrades++;
    this.status.currentPosition = undefined;
    this.notifyTradeUpdate(exitTrade);
    this.notifyStatusUpdate();
  }

  /**
   * Fetch prices for closing position
   */
  private async fetchSellPrices(): Promise<{ yesPricePercent: number; noPricePercent: number } | null> {
    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      logger.error('TradingManager', 'fetchSellPrices', 'Cannot close position: missing event or token IDs');
      return null;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];

    const [yesPrice, noPrice] = await Promise.all([
      this.clobClient.getPrice(yesTokenId, 'SELL'),
      this.clobClient.getPrice(noTokenId, 'SELL'),
    ]);

    if (!yesPrice || !noPrice) {
      logger.error('TradingManager', 'fetchSellPrices', 'Cannot close position: failed to fetch prices');
      return null;
    }

    return {
      yesPricePercent: toPercentage(yesPrice),
      noPricePercent: toPercentage(noPrice),
    };
  }

  /**
   * Execute sell order splits and return exit trades with profit
   */
  private async executeSellOrderSplits(
    position: { tokenId: string; eventSlug: string; entryPrice: number; direction?: 'UP' | 'DOWN' },
    numSplits: number,
    sizePerSplit: number,
    direction: 'UP' | 'DOWN',
    isLargePosition: boolean,
    yesPricePercent: number,
    noPricePercent: number,
    reason: string
  ): Promise<{ exitTrades: Trade[]; totalProfit: number; totalFilledSize: number }> {
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
        logger.error('TradingManager', 'executeSellOrderSplits', `Split sell order ${i + 1}/${numSplits} failed`, undefined, {
          orderIndex: i + 1,
          totalOrders: numSplits,
          error: result.error,
        });
      }

      // Small delay between split orders
      if (i < numSplits - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return { exitTrades, totalProfit, totalFilledSize };
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
      logger.debug('TradingManager', 'closePosition', 'Exit order already being placed, skipping');
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

      logger.info('TradingManager', 'closePosition', 'Closing position (SELL)', {
        tokenId: position.tokenId,
        size: positionSize,
        entryPrice: position.entryPrice,
        isLargePosition,
        numSplits,
        direction,
      });

      if (!this.apiCredentials) {
        this.handleSimulatedSellOrder(reason);
        return;
      }

      // Fetch prices for selling
      const prices = await this.fetchSellPrices();
      if (!prices) {
        this.isPlacingOrder = false;
        this.isPlacingSplitOrders = false;
        return;
      }

      logger.debug('TradingManager', 'closePosition', 'Closing position with prices', {
        direction,
        yesPricePercent: prices.yesPricePercent.toFixed(2),
        noPricePercent: prices.noPricePercent.toFixed(2),
      });

      // Execute sell orders
      const { exitTrades, totalProfit, totalFilledSize } = await this.executeSellOrderSplits(
        position,
        numSplits,
        sizePerSplit,
        direction,
        isLargePosition,
        prices.yesPricePercent,
        prices.noPricePercent,
        reason
      );

      if (totalFilledSize > 0) {
        this.status.successfulTrades++;
        this.status.totalProfit += totalProfit;
        logger.info('TradingManager', 'closePosition', 'Position closed', {
          direction,
          totalFilledSize: totalFilledSize.toFixed(2),
          totalProfit: totalProfit.toFixed(2),
          numOrders: exitTrades.length,
        });
      } else {
        logger.error('TradingManager', 'closePosition', 'All sell orders failed');
        this.status.failedTrades++;
      }

      // Clear position
      this.status.currentPosition = undefined;
      this.notifyStatusUpdate();
    } catch (error) {
      logger.error('TradingManager', 'closePosition', 'Error closing position', error);
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
      logger.warn('TradingManager', 'startTrading', 'Strategy is not enabled');
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
