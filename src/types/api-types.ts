/**
 * Type definitions for API responses and data structures
 */

/**
 * Token object from Polymarket API (can have various field names)
 */
export interface PolymarketToken {
  token_id?: string;
  tokenId?: string;
  id?: string;
  clobTokenId?: string;
  [key: string]: unknown; // Allow other fields
}

/**
 * Order object from API
 */
export interface OrderResponse {
  orderID?: string;
  orderId?: string;
  id?: string;
  tokenId?: string;
  token_id?: string;
  side?: 'BUY' | 'SELL';
  size?: number;
  price?: number;
  status?: 'LIVE' | 'FILLED' | 'EXECUTED' | 'CLOSED' | 'CANCELLED' | 'PENDING';
  filledSize?: number;
  remainingSize?: number;
  timestamp?: number;
  createdAt?: string;
  [key: string]: unknown; // Allow other fields
}

/**
 * Wallet API response
 */
export interface WalletResponse {
  address?: string;
  balance?: string;
  privateKey?: string;
  apiCredentials?: {
    key: string;
    secret: string;
    passphrase: string;
  };
  proxyAddress?: string;
  [key: string]: unknown; // Allow other fields
}

/**
 * Polymarket API data structure (flexible for various response formats)
 */
export interface PolymarketApiData {
  slug?: string;
  title?: string;
  question?: string;
  description?: string;
  startDate?: string;
  start_date?: string;
  endDate?: string;
  end_date?: string;
  active?: boolean;
  closed?: boolean;
  conditionId?: string;
  condition_id?: string;
  condition?: { id?: string };
  questionId?: string;
  questionID?: string;
  question_id?: string;
  questionObj?: { id?: string }; // Renamed to avoid conflict with question string
  clobTokenIds?: string[] | string;
  clob_token_ids?: string[] | string;
  tokens?: PolymarketToken[];
  markets?: Array<{
    conditionId?: string;
    condition_id?: string;
    questionId?: string;
    questionID?: string;
    question_id?: string;
    clobTokenIds?: string[] | string;
    clob_token_ids?: string[] | string;
    tokens?: PolymarketToken[];
    [key: string]: unknown;
  }>;
  outcomes?: PolymarketToken[];
  liquidity?: number;
  volume?: number;
  [key: string]: unknown; // Allow other fields
}

/**
 * Type guard to check if value is a valid OrderResponse
 */
export function isOrderResponse(value: unknown): value is OrderResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.orderID === 'string' ||
    typeof obj.orderId === 'string' ||
    typeof obj.id === 'string' ||
    typeof obj.tokenId === 'string' ||
    typeof obj.token_id === 'string'
  );
}

/**
 * Type guard to check if value is an array of OrderResponse
 */
export function isOrderResponseArray(value: unknown): value is OrderResponse[] {
  return Array.isArray(value) && value.every(isOrderResponse);
}

/**
 * Extract token ID from a token object (handles various field names)
 */
export function extractTokenId(token: PolymarketToken): string | undefined {
  return token.token_id || token.tokenId || token.id || token.clobTokenId;
}

/**
 * Extract order ID from an order object (handles various field names)
 */
export function extractOrderId(order: OrderResponse): string | undefined {
  return order.orderID || order.orderId || order.id;
}
