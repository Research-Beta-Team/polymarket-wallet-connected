/**
 * User-friendly error message utilities
 */

import { TradingError, ErrorCode, wrapError, isNetworkError, isRetryableError } from './errors';

/**
 * Error message with recovery suggestion
 */
export interface ErrorMessage {
  title: string;
  message: string;
  suggestion?: string;
  code?: string;
  retryable: boolean;
}

/**
 * Get user-friendly error message
 */
export function getUserFriendlyError(error: unknown): ErrorMessage {
  const tradingError = error instanceof TradingError ? error : wrapError(error);
  
  // Get base message
  const baseMessage = tradingError.getUserMessage();
  
  // Get recovery suggestion
  const suggestion = getRecoverySuggestion(tradingError);
  
  return {
    title: getErrorTitle(tradingError.code),
    message: baseMessage,
    suggestion,
    code: tradingError.code,
    retryable: tradingError.retryable || isRetryableError(error),
  };
}

/**
 * Get error title based on error code
 */
function getErrorTitle(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.TRADING_NOT_ENABLED:
      return 'Trading Disabled';
    case ErrorCode.INVALID_STRATEGY_CONFIG:
      return 'Invalid Configuration';
    case ErrorCode.NO_API_CREDENTIALS:
      return 'Authentication Required';
    case ErrorCode.NO_ACTIVE_EVENT:
      return 'No Active Event';
    case ErrorCode.NO_TOKEN_IDS:
      return 'Missing Token Information';
    case ErrorCode.ORDER_PLACEMENT_FAILED:
      return 'Order Failed';
    case ErrorCode.ORDER_CANCELLATION_FAILED:
      return 'Cancellation Failed';
    case ErrorCode.PRICE_FETCH_FAILED:
      return 'Price Update Failed';
    case ErrorCode.POSITION_CLOSE_FAILED:
      return 'Position Close Failed';
    case ErrorCode.CLOUDFLARE_BLOCK:
      return 'Request Blocked';
    case ErrorCode.API_TIMEOUT:
      return 'Connection Timeout';
    case ErrorCode.RATE_LIMIT_EXCEEDED:
      return 'Rate Limit Exceeded';
    case ErrorCode.INVALID_PRICE:
    case ErrorCode.INVALID_ENTRY_PRICE:
    case ErrorCode.INVALID_STOP_LOSS:
    case ErrorCode.INVALID_PROFIT_TARGET:
      return 'Invalid Price';
    case ErrorCode.INVALID_TRADE_SIZE:
      return 'Invalid Trade Size';
    case ErrorCode.WALLET_NOT_CONNECTED:
      return 'Wallet Not Connected';
    case ErrorCode.WALLET_INITIALIZATION_FAILED:
      return 'Wallet Setup Failed';
    case ErrorCode.INSUFFICIENT_BALANCE:
      return 'Insufficient Balance';
    case ErrorCode.NETWORK_ERROR:
      return 'Network Error';
    default:
      return 'Error';
  }
}

/**
 * Get recovery suggestion based on error code
 */
function getRecoverySuggestion(error: TradingError): string | undefined {
  switch (error.code) {
    case ErrorCode.TRADING_NOT_ENABLED:
      return 'Enable the trading strategy in the configuration section.';
    
    case ErrorCode.INVALID_STRATEGY_CONFIG:
      return 'Please review your entry price, profit target, and stop loss settings. Ensure profit target is greater than entry price, and stop loss is less than entry price.';
    
    case ErrorCode.NO_API_CREDENTIALS:
      return 'Please connect your wallet and initialize the trading session. Click "Connect Wallet" and then "Initialize Trading Session".';
    
    case ErrorCode.NO_ACTIVE_EVENT:
      return 'Wait for an active BTC Up/Down 15m event to start. Events begin every 15 minutes.';
    
    case ErrorCode.NO_TOKEN_IDS:
      return 'The active event may not have token information yet. Please wait a moment and try again.';
    
    case ErrorCode.ORDER_PLACEMENT_FAILED:
      if (isNetworkError(error)) {
        return 'Check your internet connection and try again. If the problem persists, the API may be temporarily unavailable.';
      }
      return 'Verify your wallet has sufficient balance and try again. If the issue continues, check the order details.';
    
    case ErrorCode.ORDER_CANCELLATION_FAILED:
      return 'The order may have already been filled or cancelled. Refresh the orders list to see the current status.';
    
    case ErrorCode.PRICE_FETCH_FAILED:
      return 'The price service may be temporarily unavailable. The system will automatically retry.';
    
    case ErrorCode.POSITION_CLOSE_FAILED:
      return 'Check your internet connection and try again. If the position still exists, you can manually sell it from the Orders section.';
    
    case ErrorCode.CLOUDFLARE_BLOCK:
      return 'This is usually temporary. Wait a few moments and try again. The system will automatically retry using alternative methods.';
    
    case ErrorCode.API_TIMEOUT:
      return 'The request took too long to complete. Check your internet connection and try again.';
    
    case ErrorCode.RATE_LIMIT_EXCEEDED:
      return 'Too many requests were made in a short time. Please wait a moment before trying again.';
    
    case ErrorCode.INVALID_PRICE:
    case ErrorCode.INVALID_ENTRY_PRICE:
    case ErrorCode.INVALID_STOP_LOSS:
    case ErrorCode.INVALID_PROFIT_TARGET:
      return 'Prices must be between 0 and 100. Please enter a valid price value.';
    
    case ErrorCode.INVALID_TRADE_SIZE:
      return 'Trade size must be greater than 0 and less than or equal to 10,000 USD. Please enter a valid trade size.';
    
    case ErrorCode.WALLET_NOT_CONNECTED:
      return 'Click "Connect Wallet" to establish a connection. Make sure you have a compatible wallet set up.';
    
    case ErrorCode.WALLET_INITIALIZATION_FAILED:
      return 'Check that your wallet is properly configured and try again. If the problem persists, refresh the page and reconnect.';
    
    case ErrorCode.INSUFFICIENT_BALANCE:
      return 'Deposit more funds to your wallet or reduce the trade size. Check your balance in the Wallet section.';
    
    case ErrorCode.NETWORK_ERROR:
      return 'Check your internet connection and try again. If the problem persists, the service may be temporarily unavailable.';
    
    default:
      return error.retryable 
        ? 'This error may be temporary. Please try again in a moment.'
        : 'If this problem persists, please contact support with the error code.';
  }
}

/**
 * Format error for display in UI
 */
export function formatErrorForUI(error: unknown): string {
  const errorMessage = getUserFriendlyError(error);
  
  let formatted = errorMessage.message;
  
  if (errorMessage.suggestion) {
    formatted += `\n\n💡 ${errorMessage.suggestion}`;
  }
  
  if (errorMessage.code) {
    formatted += `\n\nError Code: ${errorMessage.code}`;
  }
  
  return formatted;
}

/**
 * Format error for alert (simpler version)
 */
export function formatErrorForAlert(error: unknown): string {
  const errorMessage = getUserFriendlyError(error);
  
  let formatted = `${errorMessage.title}\n\n${errorMessage.message}`;
  
  if (errorMessage.suggestion) {
    formatted += `\n\n${errorMessage.suggestion}`;
  }
  
  return formatted;
}

/**
 * Format error for console logging (detailed version)
 */
export function formatErrorForLog(error: unknown): string {
  if (error instanceof TradingError) {
    return JSON.stringify(error.toJSON(), null, 2);
  }
  
  if (error instanceof Error) {
    return JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
    }, null, 2);
  }
  
  return String(error);
}

/**
 * Show error in UI element
 */
export function showErrorInUI(element: HTMLElement | null, error: unknown): void {
  if (!element) return;
  
  const errorMessage = getUserFriendlyError(error);
  
  element.innerHTML = `
    <div class="error-display">
      <div class="error-title">${errorMessage.title}</div>
      <div class="error-message-text">${errorMessage.message}</div>
      ${errorMessage.suggestion ? `<div class="error-suggestion">💡 ${errorMessage.suggestion}</div>` : ''}
      ${errorMessage.code ? `<div class="error-code">Error Code: ${errorMessage.code}</div>` : ''}
      ${errorMessage.retryable ? '<div class="error-retryable">This error may be temporary. You can try again.</div>' : ''}
    </div>
  `;
  
  element.style.display = 'block';
  element.classList.add('error-visible');
}

/**
 * Clear error from UI element
 */
export function clearErrorInUI(element: HTMLElement | null): void {
  if (!element) return;
  
  element.innerHTML = '';
  element.style.display = 'none';
  element.classList.remove('error-visible');
}
