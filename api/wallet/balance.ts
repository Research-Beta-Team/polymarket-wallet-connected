import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers, Contract } from 'ethers';
import { deriveProxyAddress } from '../../utils/proxyWallet';
import { POLYGON_RPC_URL, USDC_E_ADDRESS } from '../../constants/polymarket';

// Minimal ERC20 ABI for balanceOf
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
];

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const privateKey = process.env.POLYMARKET_MAGIC_PK;

    if (!privateKey) {
      return res.status(500).json({
        error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
      });
    }

    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      
      // Get proxy address using proper derivation
      const eoaAddress = wallet.address;
      const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());

      // Get USDC.e balance
      const usdcContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
      const balance = await usdcContract.balanceOf(proxyAddress);
      
      // USDC.e has 6 decimals
      const balanceFormatted = parseFloat(balance.toString()) / 1e6;

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        balance: balanceFormatted,
        balanceRaw: balance.toString(),
        address: proxyAddress,
        currency: 'USDC.e',
      });
    } catch (error) {
      console.error('Balance fetch error:', error);
      return res.status(500).json({
        error: 'Failed to fetch balance',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
