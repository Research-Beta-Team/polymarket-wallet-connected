import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers } from 'ethers';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import type { UserOrder, UserMarketOrder } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { keccak256, getCreate2Address, encodePacked } from 'viem';

// Polymarket constants
const CLOB_API_URL = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

// Polymarket Polygon Proxy Contract Addresses
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;

/**
 * Derive Polymarket Non-Safe Proxy Wallet address from EOA address
 */
function deriveProxyAddress(eoaAddress: string): string {
  try {
    return getCreate2Address({
      bytecodeHash: PROXY_INIT_CODE_HASH,
      from: PROXY_FACTORY,
      salt: keccak256(encodePacked(['address'], [eoaAddress.toLowerCase() as `0x${string}`])),
    });
  } catch (error) {
    console.error('[deriveProxyAddress] Error:', error);
    throw new Error(`Failed to derive proxy address: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function getSigningUrl(request: VercelRequest): string {
  const host = request.headers.host || 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/api/polymarket/sign`;
}

function createClobClient(
  request: VercelRequest,
  wallet: Wallet,
  apiCredentials: { key: string; secret: string; passphrase: string },
  proxyAddress: string
): ClobClient {
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: getSigningUrl(request) },
  });

  return new ClobClient(
    CLOB_API_URL,
    POLYGON_CHAIN_ID,
    wallet,
    apiCredentials,
    1,
    proxyAddress,
    undefined,
    false,
    builderConfig
  );
}

/**
 * Create and submit orders with builder attribution
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  const privateKey = process.env.POLYMARKET_MAGIC_PK;

  if (!privateKey) {
    return res.status(500).json({
      error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
    });
  }

  // GET - Fetch active orders
  if (req.method === 'GET') {
    try {
      const { apiCredentials, proxyAddress } = req.query;

      if (!apiCredentials || typeof apiCredentials !== 'string') {
        return res.status(400).json({
          error: 'Missing API credentials',
        });
      }

      let credentials: { key: string; secret: string; passphrase: string };
      try {
        credentials = JSON.parse(apiCredentials);
      } catch {
        return res.status(400).json({
          error: 'Invalid API credentials format',
        });
      }

      if (!credentials.key || !credentials.secret || !credentials.passphrase) {
        return res.status(400).json({
          error: 'Invalid API credentials',
        });
      }

      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const derivedProxyAddress = proxyAddress && typeof proxyAddress === 'string' 
        ? proxyAddress 
        : deriveProxyAddress(wallet.address.toLowerCase());

      console.log('[Orders API] Fetching active orders for proxy:', derivedProxyAddress);

      const clobClient = createClobClient(req, wallet, credentials, derivedProxyAddress);

      // Fetch all open orders
      const allOrders = await clobClient.getOpenOrders();
      console.log('[Orders API] Total open orders:', allOrders.length);

      // Filter orders by proxy address (maker_address)
      const userOrders = allOrders.filter((order: any) => {
        const orderMaker = (order.maker_address || '').toLowerCase();
        const proxyAddr = derivedProxyAddress.toLowerCase();
        return orderMaker === proxyAddr;
      });

      // Filter for LIVE orders only
      const activeOrders = userOrders.filter((order: any) => {
        return order.status === 'LIVE';
      });

      console.log('[Orders API] Active orders for user:', activeOrders.length);

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        success: true,
        orders: activeOrders,
        count: activeOrders.length,
      });
    } catch (error) {
      console.error('[Orders API] Error fetching orders:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to fetch orders',
      });
    }
  }

  // POST - Create order
  if (req.method === 'POST') {
    try {
      const body = req.body;
      const { order, apiCredentials, negRisk, isMarketOrder, tokenId, size, price, side } = body;

      if (!apiCredentials?.key || !apiCredentials?.secret || !apiCredentials?.passphrase) {
        return res.status(400).json({
          error: 'Missing API credentials',
        });
      }

      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const proxyAddress = deriveProxyAddress(wallet.address.toLowerCase());

      const clobClient = createClobClient(req, wallet, apiCredentials, proxyAddress);

      console.log('[Orders API] Creating order:', {
        tokenId,
        side,
        isMarketOrder,
        size,
        price: price || 'N/A (market)',
      });

      let response;

      if (order) {
        // Use provided order object
        response = await clobClient.createAndPostOrder(
          order,
          { negRisk: negRisk ?? false },
          OrderType.GTC
        );
      } else if (tokenId && size !== undefined && side) {
        const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;

        // Fetch fee rate for the token
        let feeRateBps: number;
        try {
          feeRateBps = await clobClient.getFeeRateBps(tokenId);
          // Ensure fee rate is valid (default to 1000 if 0 or invalid)
          if (!feeRateBps || feeRateBps === 0) {
            console.warn(`Fee rate for token ${tokenId} is 0, using default 1000`);
            feeRateBps = 1000; // Default fee rate
          }
          console.log(`Using fee rate ${feeRateBps} for token ${tokenId}`);
        } catch (error) {
          console.warn('Failed to fetch fee rate, using default 1000:', error);
          feeRateBps = 1000; // Default fee rate
        }

        if (isMarketOrder) {
          // Market order (Fill or Kill) with builder attribution
          let marketAmount: number;

          if (orderSide === Side.BUY) {
            // For BUY market orders, size parameter is number of shares
            // Calculate dollar amount: shares * askPrice
            const priceResponse = await clobClient.getPrice(tokenId, Side.SELL);
            const askPrice = parseFloat(priceResponse.price);
            
            if (isNaN(askPrice) || askPrice <= 0 || askPrice >= 1) {
              return res.status(400).json({
                error: 'Unable to get valid market price',
              });
            }
            
            marketAmount = size * askPrice; // Convert shares to dollar amount
          } else {
            // For SELL market orders, amount is in shares
            marketAmount = size;
          }

          const marketOrder: UserMarketOrder = {
            tokenID: tokenId,
            amount: marketAmount,
            side: orderSide,
            feeRateBps: feeRateBps,
          };

          response = await clobClient.createAndPostMarketOrder(
            marketOrder,
            { negRisk: negRisk ?? false },
            OrderType.FOK
          );
        } else {
          // Limit order (Good Till Cancelled)
          if (!price) {
            return res.status(400).json({
              error: 'Price required for limit orders',
            });
          }

          const limitOrder: UserOrder = {
            tokenID: tokenId,
            price: price,
            size: size,
            side: orderSide,
            feeRateBps: feeRateBps,
            expiration: 0,
            taker: '0x0000000000000000000000000000000000000000',
          };

          response = await clobClient.createAndPostOrder(
            limitOrder,
            { negRisk: negRisk ?? false },
            OrderType.GTC
          );
        }
      } else {
        return res.status(400).json({
          error: 'Missing order parameters',
        });
      }

      if (response.orderID) {
        console.log('[Orders API] Order created successfully:', {
          orderId: response.orderID,
          tokenId,
          side,
          orderType: isMarketOrder ? 'MARKET (FOK)' : 'LIMIT (GTC)',
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json({
          success: true,
          orderId: response.orderID,
        });
      } else {
        console.error('[Orders API] Order submission failed - no order ID returned');
        return res.status(500).json({
          error: 'Order submission failed - no order ID returned',
        });
      }
    } catch (error) {
      console.error('Order creation error:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create order',
      });
    }
  }

  // DELETE - Cancel order
  if (req.method === 'DELETE') {
    try {
      const { orderId, apiCredentials } = req.body;

      if (!orderId) {
        return res.status(400).json({
          error: 'Missing order ID',
        });
      }

      if (!apiCredentials?.key || !apiCredentials?.secret || !apiCredentials?.passphrase) {
        return res.status(400).json({
          error: 'Missing API credentials',
        });
      }

      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const proxyAddress = deriveProxyAddress(wallet.address.toLowerCase());

      const clobClient = createClobClient(req, wallet, apiCredentials, proxyAddress);

      console.log('[Orders API] Cancelling order:', orderId);

      await clobClient.cancelOrder({ orderID: orderId });

      console.log('[Orders API] Order cancelled successfully:', orderId);

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Order cancellation error:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to cancel order',
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
