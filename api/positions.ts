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

function positionToRow(scope: string, p: {
  id: string; eventSlug: string; tokenId: string; side: string; entryPrice: number; size: number;
  entryTimestamp: number; currentPrice?: number; unrealizedProfit?: number; direction?: string; filledOrders?: unknown;
}) {
  return {
    id: p.id,
    scope,
    event_slug: p.eventSlug,
    token_id: p.tokenId,
    side: p.side,
    entry_price: p.entryPrice,
    size: p.size,
    entry_timestamp: p.entryTimestamp,
    current_price: p.currentPrice ?? null,
    unrealized_profit: p.unrealizedProfit ?? null,
    direction: p.direction ?? null,
    filled_orders: p.filledOrders != null ? JSON.stringify(p.filledOrders) : null,
  };
}

function rowToPosition(r: Record<string, unknown>): {
  id: string; eventSlug: string; tokenId: string; side: 'BUY' | 'SELL'; entryPrice: number; size: number;
  entryTimestamp: number; currentPrice?: number; unrealizedProfit?: number; direction?: 'UP' | 'DOWN';
  filledOrders?: Array<{ orderId: string; price: number; size: number; timestamp: number }>;
} {
  let filledOrders: Array<{ orderId: string; price: number; size: number; timestamp: number }> | undefined;
  if (r.filled_orders != null) {
    try {
      const parsed = typeof r.filled_orders === 'string' ? JSON.parse(r.filled_orders) : r.filled_orders;
      if (Array.isArray(parsed)) filledOrders = parsed as Array<{ orderId: string; price: number; size: number; timestamp: number }>;
    } catch (_) {}
  }
  return {
    id: String(r.id),
    eventSlug: String(r.event_slug ?? ''),
    tokenId: String(r.token_id ?? ''),
    side: (r.side === 'BUY' || r.side === 'SELL' ? r.side : 'BUY') as 'BUY' | 'SELL',
    entryPrice: Number(r.entry_price),
    size: Number(r.size),
    entryTimestamp: Number(r.entry_timestamp),
    currentPrice: r.current_price != null ? Number(r.current_price) : undefined,
    unrealizedProfit: r.unrealized_profit != null ? Number(r.unrealized_profit) : undefined,
    direction: (r.direction === 'UP' || r.direction === 'DOWN' ? r.direction : undefined) as 'UP' | 'DOWN' | undefined,
    filledOrders,
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
        .from('positions')
        .select('*')
        .eq('scope', scope);

      if (error) {
        console.error('[positions] GET error:', error);
        return res.status(500).json({ error: error.message });
      }

      const positions = ((data || []) as Record<string, unknown>[]).map(rowToPosition);
      return res.status(200).json({ positions });
    }

    if (req.method === 'POST') {
      const body = req.body as { scope?: string; positions: unknown[] };
      const scope = (body?.scope && typeof body.scope === 'string' ? body.scope : 'default').trim();
      const positions = Array.isArray(body?.positions) ? body.positions : [];
      if (positions.length === 0) {
        const { error: delErr } = await supabase.from('positions').delete().eq('scope', scope);
        if (delErr) {
          console.error('[positions] DELETE error:', delErr);
          return res.status(500).json({ error: delErr.message });
        }
        return res.status(200).json({ ok: true });
      }

      const rows = positions
        .filter((p): p is Record<string, unknown> => p != null && typeof p === 'object' && typeof (p as Record<string, unknown>).id === 'string')
        .map((p) => positionToRow(scope, {
          id: String((p as Record<string, unknown>).id),
          eventSlug: String((p as Record<string, unknown>).eventSlug ?? ''),
          tokenId: String((p as Record<string, unknown>).tokenId ?? ''),
          side: String((p as Record<string, unknown>).side ?? 'BUY'),
          entryPrice: Number((p as Record<string, unknown>).entryPrice),
          size: Number((p as Record<string, unknown>).size),
          entryTimestamp: Number((p as Record<string, unknown>).entryTimestamp),
          currentPrice: (p as Record<string, unknown>).currentPrice != null ? Number((p as Record<string, unknown>).currentPrice) : undefined,
          unrealizedProfit: (p as Record<string, unknown>).unrealizedProfit != null ? Number((p as Record<string, unknown>).unrealizedProfit) : undefined,
          direction: (p as Record<string, unknown>).direction != null ? String((p as Record<string, unknown>).direction) : undefined,
          filledOrders: (p as Record<string, unknown>).filledOrders,
        }));

      const { error: delErr } = await supabase.from('positions').delete().eq('scope', scope);
      if (delErr) {
        console.error('[positions] DELETE error:', delErr);
        return res.status(500).json({ error: delErr.message });
      }
      const { error: insErr } = await supabase.from('positions').insert(rows);
      if (insErr) {
        console.error('[positions] INSERT error:', insErr);
        return res.status(500).json({ error: insErr.message });
      }
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[positions] Error:', message);
    return res.status(500).json({ error: message });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
