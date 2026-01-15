/**
 * Type definitions for wallet API responses
 */

export interface WalletInitializeResponse {
  eoaAddress: string;
  proxyAddress: string;
  apiCredentials?: {
    key: string;
    secret: string;
    passphrase: string;
  };
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface WalletBalanceResponse {
  balance?: string;
  address?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface WalletPrivateKeyResponse {
  privateKey: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Type guard for wallet initialize response
 */
export function isWalletInitializeResponse(value: unknown): value is WalletInitializeResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.eoaAddress === 'string' &&
    typeof obj.proxyAddress === 'string'
  );
}
