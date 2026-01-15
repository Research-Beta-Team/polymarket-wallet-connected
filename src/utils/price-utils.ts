/**
 * Price-related utility functions
 */

import { retryWithBackoff, isRetryableError, TradingError, ErrorCode } from './errors';
import type { CLOBClientWrapper } from '../clob-client';
import type { ClobClient } from '@polymarket/clob-client';

/**
 * Converts Polymarket price from decimal (0-1) to percentage (0-100)
 */
export function toPercentage(price: number): number {
  return price * 100;
}

/**
 * Converts percentage (0-100) to decimal (0-1)
 */
export function toDecimal(percentage: number): number {
  return percentage / 100;
}

/**
 * Fetch price with retry logic
 */
export async function fetchPriceWithRetry(
  clobClient: CLOBClientWrapper,
  tokenId: string,
  side: 'BUY' | 'SELL',
  maxRetries: number = 3,
  initialDelay: number = 500
): Promise<number> {
  const price = await retryWithBackoff(
    () => clobClient.getPrice(tokenId, side),
    maxRetries,
    initialDelay,
    2, // backoffMultiplier
    (error) => isRetryableError(error)
  );

  if (!price) {
    throw new TradingError('Failed to fetch price', ErrorCode.PRICE_FETCH_FAILED, {
      tokenId,
      side,
    });
  }

  return price;
}

/**
 * Fetch price from browser ClobClient with retry logic
 */
export async function fetchBrowserPriceWithRetry(
  browserClobClient: ClobClient,
  tokenId: string,
  side: 'BUY' | 'SELL',
  maxRetries: number = 3,
  initialDelay: number = 500
): Promise<number> {
  const { Side } = await import('@polymarket/clob-client');
  const sideEnum = side === 'BUY' ? Side.BUY : Side.SELL;

  const response = await retryWithBackoff(
    async () => {
      const result = await browserClobClient.getPrice(tokenId, sideEnum);
      return parseFloat(result.price);
    },
    maxRetries,
    initialDelay,
    2,
    (error) => isRetryableError(error)
  );

  if (isNaN(response) || response <= 0 || response >= 1) {
    throw new TradingError('Invalid price from browser client', ErrorCode.PRICE_FETCH_FAILED, {
      tokenId,
      side,
      price: response,
    });
  }

  return response;
}

/**
 * Fetch both YES and NO token prices with retry
 */
export async function fetchBothPrices(
  clobClient: CLOBClientWrapper,
  yesTokenId: string,
  noTokenId: string,
  side: 'BUY' | 'SELL' = 'BUY',
  maxRetries: number = 3
): Promise<{ yesPrice: number; noPrice: number; yesPricePercent: number; noPricePercent: number }> {
  const [yesPrice, noPrice] = await Promise.all([
    fetchPriceWithRetry(clobClient, yesTokenId, side, maxRetries),
    fetchPriceWithRetry(clobClient, noTokenId, side, maxRetries),
  ]);

  return {
    yesPrice,
    noPrice,
    yesPricePercent: toPercentage(yesPrice),
    noPricePercent: toPercentage(noPrice),
  };
}

/**
 * Validate price value
 */
export function validatePrice(price: number, fieldName: string = 'price'): void {
  if (isNaN(price)) {
    throw new TradingError(`${fieldName} is not a number`, ErrorCode.INVALID_PRICE, { price });
  }
  if (price < 0 || price > 100) {
    throw new TradingError(`${fieldName} must be between 0 and 100`, ErrorCode.INVALID_PRICE, { price });
  }
}

/**
 * Validate decimal price (0-1 range)
 */
export function validateDecimalPrice(price: number, fieldName: string = 'price'): void {
  if (isNaN(price)) {
    throw new TradingError(`${fieldName} is not a number`, ErrorCode.INVALID_PRICE, { price });
  }
  if (price <= 0 || price >= 1) {
    throw new TradingError(`${fieldName} must be between 0 and 1`, ErrorCode.INVALID_PRICE, { price });
  }
}
