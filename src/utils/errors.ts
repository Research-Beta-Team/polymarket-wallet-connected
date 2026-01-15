/**
 * Custom error types for the trading bot
 */

export enum ErrorCode {
  // Trading errors
  TRADING_NOT_ENABLED = 'TRADING_NOT_ENABLED',
  INVALID_STRATEGY_CONFIG = 'INVALID_STRATEGY_CONFIG',
  NO_API_CREDENTIALS = 'NO_API_CREDENTIALS',
  NO_ACTIVE_EVENT = 'NO_ACTIVE_EVENT',
  NO_TOKEN_IDS = 'NO_TOKEN_IDS',
  ORDER_PLACEMENT_FAILED = 'ORDER_PLACEMENT_FAILED',
  ORDER_CANCELLATION_FAILED = 'ORDER_CANCELLATION_FAILED',
  PRICE_FETCH_FAILED = 'PRICE_FETCH_FAILED',
  POSITION_CLOSE_FAILED = 'POSITION_CLOSE_FAILED',
  
  // Network errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  CLOUDFLARE_BLOCK = 'CLOUDFLARE_BLOCK',
  API_TIMEOUT = 'API_TIMEOUT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  
  // Validation errors
  INVALID_PRICE = 'INVALID_PRICE',
  INVALID_TRADE_SIZE = 'INVALID_TRADE_SIZE',
  INVALID_ENTRY_PRICE = 'INVALID_ENTRY_PRICE',
  INVALID_STOP_LOSS = 'INVALID_STOP_LOSS',
  INVALID_PROFIT_TARGET = 'INVALID_PROFIT_TARGET',
  
  // Wallet errors
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',
  WALLET_INITIALIZATION_FAILED = 'WALLET_INITIALIZATION_FAILED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  
  // Unknown errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface ErrorContext {
  [key: string]: any;
}

/**
 * Base error class for trading bot errors
 */
export class TradingError extends Error {
  public readonly code: ErrorCode;
  public readonly context: ErrorContext;
  public readonly timestamp: number;
  public readonly retryable: boolean;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.UNKNOWN_ERROR,
    context: ErrorContext = {},
    retryable: boolean = false
  ) {
    super(message);
    this.name = 'TradingError';
    this.code = code;
    this.context = context;
    this.timestamp = Date.now();
    this.retryable = retryable;
    
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TradingError);
    }
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage(): string {
    switch (this.code) {
      case ErrorCode.TRADING_NOT_ENABLED:
        return 'Trading is not enabled. Please enable the strategy first.';
      case ErrorCode.INVALID_STRATEGY_CONFIG:
        return 'Invalid trading strategy configuration. Please check your settings.';
      case ErrorCode.NO_API_CREDENTIALS:
        return 'API credentials not available. Please connect your wallet and initialize the trading session.';
      case ErrorCode.NO_ACTIVE_EVENT:
        return 'No active event found. Please wait for an active event.';
      case ErrorCode.NO_TOKEN_IDS:
        return 'Token IDs not available for the active event.';
      case ErrorCode.ORDER_PLACEMENT_FAILED:
        return `Failed to place order: ${this.message}`;
      case ErrorCode.PRICE_FETCH_FAILED:
        return 'Failed to fetch market prices. Please try again.';
      case ErrorCode.POSITION_CLOSE_FAILED:
        return `Failed to close position: ${this.message}`;
      case ErrorCode.CLOUDFLARE_BLOCK:
        return 'Request blocked by Cloudflare. Please try again in a few moments.';
      case ErrorCode.API_TIMEOUT:
        return 'Request timed out. Please check your connection and try again.';
      case ErrorCode.RATE_LIMIT_EXCEEDED:
        return 'Too many requests. Please wait a moment before trying again.';
      case ErrorCode.INVALID_PRICE:
        return 'Invalid price value. Price must be between 0 and 100.';
      case ErrorCode.INVALID_TRADE_SIZE:
        return 'Invalid trade size. Trade size must be greater than 0.';
      case ErrorCode.WALLET_NOT_CONNECTED:
        return 'Wallet not connected. Please connect your wallet first.';
      case ErrorCode.INSUFFICIENT_BALANCE:
        return 'Insufficient balance to place this order.';
      default:
        return this.message || 'An unexpected error occurred.';
    }
  }

  /**
   * Convert to JSON for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      retryable: this.retryable,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/**
 * Network-related errors
 */
export class NetworkError extends TradingError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, ErrorCode.NETWORK_ERROR, context, true);
    this.name = 'NetworkError';
  }
}

/**
 * Validation errors
 */
export class ValidationError extends TradingError {
  constructor(message: string, field: string, value: any) {
    super(message, ErrorCode.INVALID_STRATEGY_CONFIG, { field, value }, false);
    this.name = 'ValidationError';
  }
}

/**
 * Order placement errors
 */
export class OrderError extends TradingError {
  constructor(message: string, context: ErrorContext = {}, retryable: boolean = false) {
    super(message, ErrorCode.ORDER_PLACEMENT_FAILED, context, retryable);
    this.name = 'OrderError';
  }
}

/**
 * Retry utility for async operations
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000,
  backoffMultiplier: number = 2,
  retryableError?: (error: unknown) => boolean
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if error is retryable
      const shouldRetry = retryableError 
        ? retryableError(error)
        : error instanceof TradingError && error.retryable;
      
      if (!shouldRetry || attempt === maxRetries - 1) {
        throw error;
      }
      
      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(backoffMultiplier, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Check if error is a network error
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof TradingError && error.code === ErrorCode.NETWORK_ERROR) return true;
  if (error instanceof Error) {
    return error.message.includes('network') || 
           error.message.includes('fetch') ||
           error.message.includes('timeout');
  }
  return false;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof TradingError) return error.retryable;
  if (isNetworkError(error)) return true;
  return false;
}

/**
 * Wrap error in TradingError if it isn't already
 */
export function wrapError(error: unknown, defaultCode: ErrorCode = ErrorCode.UNKNOWN_ERROR): TradingError {
  if (error instanceof TradingError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new TradingError(error.message, defaultCode, {}, false);
  }
  
  return new TradingError(String(error), defaultCode, {}, false);
}
