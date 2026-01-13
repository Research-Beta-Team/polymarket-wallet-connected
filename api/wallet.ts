import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers } from 'ethers';
import { deriveProxyAddress } from '../utils/proxyWallet';
import { POLYGON_RPC_URL } from '../constants/polymarket';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    // Get wallet info (EOA and proxy addresses)
    const privateKey = process.env.POLYMARKET_MAGIC_PK;

    if (!privateKey) {
      return res.status(500).json({
        error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
      });
    }

    try {
      console.log('[Wallet API] Starting wallet derivation...');
      console.log('[Wallet API] POLYGON_RPC_URL:', POLYGON_RPC_URL);
      
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const eoaAddress = wallet.address;
      
      console.log('[Wallet API] EOA Address derived:', eoaAddress);
      
      // Derive proxy address
      const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());
      console.log('[Wallet API] Proxy Address derived:', proxyAddress);

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ 
        eoaAddress, 
        proxyAddress,
        success: true 
      });
    } catch (error) {
      console.error('[Wallet API] Error during wallet derivation:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('[Wallet API] Error details:', { message: errorMessage, stack: errorStack });
      
      // Provide more specific error messages
      let userFriendlyError = 'Failed to derive wallet info';
      if (errorMessage.includes('Cannot find module') || errorMessage.includes('Module not found')) {
        userFriendlyError = 'Missing dependency. Ensure viem package is installed.';
      } else if (errorMessage.includes('invalid private key') || errorMessage.includes('invalid hex')) {
        userFriendlyError = 'Invalid private key format. Check POLYMARKET_MAGIC_PK environment variable.';
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('network')) {
        userFriendlyError = 'Network error. Check POLYGON_RPC_URL configuration.';
      }
      
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(500).json({
        error: userFriendlyError,
        message: errorMessage,
        details: process.env.NODE_ENV === 'development' ? errorStack : undefined,
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
