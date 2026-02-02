import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function tradeToRow(scope: string, t: {
  id: string; eventSlug: string; tokenId: string; side: string; size: number; price: number;
  timestamp: number; status: string; transactionHash?: string; profit?: number; reason: string;
  orderType: string; limitPrice?: number; direction?: string;
}) {
  return {
    id: t.id,
    scope,
    event_slug: t.eventSlug,
    token_id: t.tokenId,
    side: t.side,
    size: t.size,
    price: t.price,
    timestamp: t.timestamp,
    status: t.status,
    transaction_hash: t.transactionHash ?? null,
    profit: t.profit ?? null,
    reason: t.reason,
    order_type: t.orderType,
    limit_price: t.limitPrice ?? null,
    direction: t.direction ?? null,
  };
}

function rowToTrade(r: Record<string, unknown>): {
  id: string; eventSlug: string; tokenId: string; side: 'BUY' | 'SELL'; size: number; price: number;
  timestamp: number; status: 'pending' | 'filled' | 'failed' | 'cancelled'; reason: string; orderType: 'LIMIT' | 'MARKET';
  transactionHash?: string; profit?: number; limitPrice?: number; direction?: 'UP' | 'DOWN';
} {
  return {
    id: String(r.id),
    eventSlug: String(r.event_slug ?? ''),
    tokenId: String(r.token_id ?? ''),
    side: (r.side === 'BUY' || r.side === 'SELL' ? r.side : 'BUY') as 'BUY' | 'SELL',
    size: Number(r.size),
    price: Number(r.price),
    timestamp: Number(r.timestamp),
    status: (r.status === 'pending' || r.status === 'filled' || r.status === 'failed' || r.status === 'cancelled' ? r.status : 'pending') as 'pending' | 'filled' | 'failed' | 'cancelled',
    reason: String(r.reason ?? ''),
    orderType: (r.order_type === 'LIMIT' || r.order_type === 'MARKET' ? r.order_type : 'MARKET') as 'LIMIT' | 'MARKET',
    transactionHash: r.transaction_hash != null ? String(r.transaction_hash) : undefined,
    profit: r.profit != null ? Number(r.profit) : undefined,
    limitPrice: r.limit_price != null ? Number(r.limit_price) : undefined,
    direction: (r.direction === 'UP' || r.direction === 'DOWN' ? r.direction : undefined) as 'UP' | 'DOWN' | undefined,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Database not configured.' });
  }

  try {
    const supabase = getSupabase();

    if (req.method === 'GET') {
      const scope = typeof req.query.scope === 'string' ? req.query.scope : 'default';
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('scope', scope)
        .order('timestamp', { ascending: false });

      if (error) {
        console.error('[trades] GET error:', error);
        return res.status(500).json({ error: error.message });
      }

      const trades = ((data || []) as Record<string, unknown>[]).map(rowToTrade);
      return res.status(200).json({ trades });
    }

    if (req.method === 'POST') {
      const body = req.body as { scope?: string; trade: Record<string, unknown> };
      const scope = (body?.scope && typeof body.scope === 'string' ? body.scope : 'default').trim();
      const trade = body?.trade;
      if (!trade || typeof trade.id !== 'string') {
        return res.status(400).json({ error: 'trade with id is required' });
      }

      const row = tradeToRow(scope, {
        id: trade.id,
        eventSlug: String(trade.eventSlug ?? ''),
        tokenId: String(trade.tokenId ?? ''),
        side: String(trade.side ?? 'BUY'),
        size: Number(trade.size),
        price: Number(trade.price),
        timestamp: Number(trade.timestamp),
        status: String(trade.status ?? 'pending'),
        reason: String(trade.reason ?? ''),
        orderType: String(trade.orderType ?? 'MARKET'),
        transactionHash: trade.transactionHash != null ? String(trade.transactionHash) : undefined,
        profit: trade.profit != null ? Number(trade.profit) : undefined,
        limitPrice: trade.limitPrice != null ? Number(trade.limitPrice) : undefined,
        direction: trade.direction != null ? String(trade.direction) : undefined,
      });

      const { error } = await supabase.from('trades').upsert(row, { onConflict: 'scope,id' });

      if (error) {
        console.error('[trades] POST error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[trades] Error:', message);
    return res.status(500).json({ error: message });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
