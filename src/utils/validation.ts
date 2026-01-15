/**
 * Input validation utilities
 */

import { ValidationError, ErrorCode, TradingError } from './errors';

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  fieldErrors: Record<string, string>;
}

/**
 * Validate strategy configuration
 */
export function validateStrategyConfig(config: {
  entryPrice?: number;
  profitTargetPrice?: number;
  stopLossPrice?: number;
  tradeSize?: number;
  priceDifference?: number | null;
}): ValidationResult {
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};

  // Validate entry price
  if (config.entryPrice !== undefined) {
    if (isNaN(config.entryPrice)) {
      errors.push('Entry price must be a number');
      fieldErrors.entryPrice = 'Entry price must be a number';
    } else if (config.entryPrice < 0 || config.entryPrice > 100) {
      errors.push('Entry price must be between 0 and 100');
      fieldErrors.entryPrice = 'Entry price must be between 0 and 100';
    }
  }

  // Validate profit target
  if (config.profitTargetPrice !== undefined) {
    if (isNaN(config.profitTargetPrice)) {
      errors.push('Profit target must be a number');
      fieldErrors.profitTargetPrice = 'Profit target must be a number';
    } else if (config.profitTargetPrice < 0 || config.profitTargetPrice > 100) {
      errors.push('Profit target must be between 0 and 100');
      fieldErrors.profitTargetPrice = 'Profit target must be between 0 and 100';
    }
  }

  // Validate stop loss
  if (config.stopLossPrice !== undefined) {
    if (isNaN(config.stopLossPrice)) {
      errors.push('Stop loss must be a number');
      fieldErrors.stopLossPrice = 'Stop loss must be a number';
    } else if (config.stopLossPrice < 0 || config.stopLossPrice > 100) {
      errors.push('Stop loss must be between 0 and 100');
      fieldErrors.stopLossPrice = 'Stop loss must be between 0 and 100';
    }
  }

  // Validate trade size
  if (config.tradeSize !== undefined) {
    if (isNaN(config.tradeSize)) {
      errors.push('Trade size must be a number');
      fieldErrors.tradeSize = 'Trade size must be a number';
    } else if (config.tradeSize <= 0) {
      errors.push('Trade size must be greater than 0');
      fieldErrors.tradeSize = 'Trade size must be greater than 0';
    } else if (config.tradeSize > 10000) {
      errors.push('Trade size must be less than or equal to 10,000 USD');
      fieldErrors.tradeSize = 'Trade size must be less than or equal to 10,000 USD';
    }
  }

  // Validate price difference (optional)
  if (config.priceDifference !== undefined && config.priceDifference !== null) {
    if (isNaN(config.priceDifference)) {
      errors.push('Price difference must be a number');
      fieldErrors.priceDifference = 'Price difference must be a number';
    } else if (config.priceDifference < 0) {
      errors.push('Price difference must be greater than or equal to 0');
      fieldErrors.priceDifference = 'Price difference must be greater than or equal to 0';
    }
  }

  // Validate logical relationships
  if (config.entryPrice !== undefined && config.profitTargetPrice !== undefined) {
    if (!isNaN(config.entryPrice) && !isNaN(config.profitTargetPrice)) {
      if (config.profitTargetPrice <= config.entryPrice) {
        errors.push('Profit target must be greater than entry price');
        fieldErrors.profitTargetPrice = 'Profit target must be greater than entry price';
      }
    }
  }

  if (config.entryPrice !== undefined && config.stopLossPrice !== undefined) {
    if (!isNaN(config.entryPrice) && !isNaN(config.stopLossPrice)) {
      if (config.stopLossPrice >= config.entryPrice) {
        errors.push('Stop loss must be less than entry price');
        fieldErrors.stopLossPrice = 'Stop loss must be less than entry price';
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    fieldErrors,
  };
}

/**
 * Validate price value (0-100)
 */
export function validatePrice(price: number, fieldName: string = 'price'): void {
  if (isNaN(price)) {
    throw new ValidationError(`${fieldName} is not a number`, fieldName, price);
  }
  if (price < 0 || price > 100) {
    throw new ValidationError(`${fieldName} must be between 0 and 100`, fieldName, price);
  }
}

/**
 * Validate trade size
 */
export function validateTradeSize(tradeSize: number): void {
  if (isNaN(tradeSize)) {
    throw new ValidationError('Trade size is not a number', 'tradeSize', tradeSize);
  }
  if (tradeSize <= 0) {
    throw new ValidationError('Trade size must be greater than 0', 'tradeSize', tradeSize);
  }
  if (tradeSize > 10000) {
    throw new ValidationError('Trade size must be less than or equal to 10,000 USD', 'tradeSize', tradeSize);
  }
}

/**
 * Validate token ID format
 */
export function validateTokenId(tokenId: string): void {
  if (!tokenId || typeof tokenId !== 'string') {
    throw new ValidationError('Token ID is required and must be a string', 'tokenId', tokenId);
  }
  if (tokenId.length === 0) {
    throw new ValidationError('Token ID cannot be empty', 'tokenId', tokenId);
  }
}

/**
 * Validate order size
 */
export function validateOrderSize(size: number): void {
  if (isNaN(size)) {
    throw new ValidationError('Order size is not a number', 'size', size);
  }
  if (size <= 0) {
    throw new ValidationError('Order size must be greater than 0', 'size', size);
  }
}

/**
 * Parse and validate number input from string
 */
export function parseNumberInput(value: string, fieldName: string): number {
  if (value.trim() === '') {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }
  const num = parseFloat(value);
  if (isNaN(num)) {
    throw new ValidationError(`${fieldName} must be a valid number`, fieldName, value);
  }
  return num;
}

/**
 * Parse and validate optional number input from string
 */
export function parseOptionalNumberInput(value: string, fieldName: string): number | null {
  if (value.trim() === '') {
    return null;
  }
  const num = parseFloat(value);
  if (isNaN(num)) {
    throw new ValidationError(`${fieldName} must be a valid number`, fieldName, value);
  }
  return num;
}

/**
 * Validate API response structure
 */
export function validateApiResponse(response: unknown, requiredFields: string[]): void {
  if (typeof response !== 'object' || response === null) {
    throw new TradingError('Invalid API response: expected object', ErrorCode.NETWORK_ERROR);
  }

  const obj = response as Record<string, unknown>;
  for (const field of requiredFields) {
    if (!(field in obj)) {
      throw new TradingError(`Invalid API response: missing required field '${field}'`, ErrorCode.NETWORK_ERROR);
    }
  }
}
