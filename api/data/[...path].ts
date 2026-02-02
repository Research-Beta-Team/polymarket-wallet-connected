/**
 * Combined Supabase data API (event-state, strategy-config, trades, positions).
 * Serves /api/data/event-state, /api/data/strategy-config, /api/data/trades, /api/data/positions
 * to stay under Vercel Hobby plan 12-function limit.
 */
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

function getResource(path: string[]): string | null {
  // req.query.path is ['event-state'] for /api/data/event-state; or from URL ['api','data','event-state']
  if (path.length >= 1) return path[path.length >= 3 ? 2 : 0];
  return null;
}

// --- event-state ---
interface EventStateRow {
  event_slug: string;
  price_to_beat: number | null;
  last_price: number | null;
  updated_at: string;
}

async function handleEventState(req: VercelRequest, res: VercelResponse, supabase: ReturnType<typeof createClient>): Promise<boolean> {
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('event_state')
      .select('event_slug, price_to_beat, last_price')
      .order('updated_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: error.message });
      return true;
    }
    const priceToBeat: Record<string, number> = {};
    const lastPrice: Record<string, number> = {};
    for (const row of (data || []) as EventStateRow[]) {
      if (row.price_to_beat != null) priceToBeat[row.event_slug] = Number(row.price_to_beat);
      if (row.last_price != null) lastPrice[row.event_slug] = Number(row.last_price);
    }
    res.status(200).json({ priceToBeat, lastPrice });
    return true;
  }
  if (req.method === 'POST') {
    const body = req.body as { eventSlug: string; priceToBeat?: number; lastPrice?: number };
    const eventSlug = body?.eventSlug?.trim();
    if (typeof eventSlug !== 'string' || !eventSlug) {
      res.status(400).json({ error: 'eventSlug is required' });
      return true;
    }
    const { data: existing } = await supabase.from('event_state').select('price_to_beat, last_price').eq('event_slug', eventSlug).maybeSingle();
    const row = (existing as { price_to_beat?: number; last_price?: number } | null) || {};
    const payload = {
      event_slug: eventSlug,
      price_to_beat: typeof body.priceToBeat === 'number' ? body.priceToBeat : (row.price_to_beat ?? null),
      last_price: typeof body.lastPrice === 'number' ? body.lastPrice : (row.last_price ?? null),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('event_state').upsert(payload, { onConflict: 'event_slug', ignoreDuplicates: false });
    if (error) {
      res.status(500).json({ error: error.message });
      return true;
    }
    res.status(200).json({ ok: true });
    return true;
  }
  return false;
}

// --- strategy-config ---
async function handleStrategyConfig(req: VercelRequest, res: VercelResponse, supabase: ReturnType<typeof createClient>): Promise<boolean> {
  if (req.method === 'GET') {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : null;
    let query = supabase.from('strategy_config').select('scope, config');
    if (scope) query = query.eq('scope', scope);
    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: error.message });
      return true;
    }
    const rows = (data || []) as { scope: string; config: unknown }[];
    if (scope && rows.length === 0) { res.status(200).json({ config: null }); return true; }
    if (scope) { res.status(200).json({ config: rows[0].config }); return true; }
    const byScope: Record<string, unknown> = {};
    for (const r of rows) byScope[r.scope] = r.config;
    res.status(200).json({ byScope });
    return true;
  }
  if (req.method === 'POST') {
    const body = req.body as { scope: string; config: unknown };
    const scope = body?.scope?.trim();
    if (typeof scope !== 'string' || !scope) { res.status(400).json({ error: 'scope is required' }); return true; }
    if (body.config === undefined || body.config === null) { res.status(400).json({ error: 'config is required' }); return true; }
    const { error } = await supabase.from('strategy_config').upsert(
      { scope, config: body.config, updated_at: new Date().toISOString() },
      { onConflict: 'scope' }
    );
    if (error) { res.status(500).json({ error: error.message }); return true; }
    res.status(200).json({ ok: true });
    return true;
  }
  return false;
}

// --- trades ---
function tradeToRow(scope: string, t: Record<string, unknown>) {
  return {
    id: t.id,
    scope,
    event_slug: t.eventSlug ?? '',
    token_id: t.tokenId ?? '',
    side: t.side ?? 'BUY',
    size: Number(t.size),
    price: Number(t.price),
    timestamp: Number(t.timestamp),
    status: t.status ?? 'pending',
    transaction_hash: t.transactionHash ?? null,
    profit: t.profit != null ? Number(t.profit) : null,
    reason: String(t.reason ?? ''),
    order_type: t.orderType ?? 'MARKET',
    limit_price: t.limitPrice != null ? Number(t.limitPrice) : null,
    direction: t.direction ?? null,
  };
}

function rowToTrade(r: Record<string, unknown>) {
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

async function handleTrades(req: VercelRequest, res: VercelResponse, supabase: ReturnType<typeof createClient>): Promise<boolean> {
  if (req.method === 'GET') {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'default';
    const { data, error } = await supabase.from('trades').select('*').eq('scope', scope).order('timestamp', { ascending: false });
    if (error) { res.status(500).json({ error: error.message }); return true; }
    const trades = ((data || []) as Record<string, unknown>[]).map(rowToTrade);
    res.status(200).json({ trades });
    return true;
  }
  if (req.method === 'POST') {
    const body = req.body as { scope?: string; trade: Record<string, unknown> };
    const scope = (body?.scope && typeof body.scope === 'string' ? body.scope : 'default').trim();
    const trade = body?.trade;
    if (!trade || typeof trade.id !== 'string') { res.status(400).json({ error: 'trade with id is required' }); return true; }
    const row = tradeToRow(scope, { ...trade });
    const { error } = await supabase.from('trades').upsert(row, { onConflict: 'scope,id' });
    if (error) { res.status(500).json({ error: error.message }); return true; }
    res.status(200).json({ ok: true });
    return true;
  }
  return false;
}

// --- positions ---
function positionToRow(scope: string, p: Record<string, unknown>) {
  return {
    id: p.id,
    scope,
    event_slug: p.eventSlug ?? '',
    token_id: p.tokenId ?? '',
    side: p.side ?? 'BUY',
    entry_price: Number(p.entryPrice),
    size: Number(p.size),
    entry_timestamp: Number(p.entryTimestamp),
    current_price: p.currentPrice != null ? Number(p.currentPrice) : null,
    unrealized_profit: p.unrealizedProfit != null ? Number(p.unrealizedProfit) : null,
    direction: p.direction ?? null,
    filled_orders: p.filledOrders != null ? JSON.stringify(p.filledOrders) : null,
  };
}

function rowToPosition(r: Record<string, unknown>) {
  let filledOrders: unknown;
  if (r.filled_orders != null) {
    try {
      filledOrders = typeof r.filled_orders === 'string' ? JSON.parse(r.filled_orders) : r.filled_orders;
    } catch { filledOrders = undefined; }
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

async function handlePositions(req: VercelRequest, res: VercelResponse, supabase: ReturnType<typeof createClient>): Promise<boolean> {
  if (req.method === 'GET') {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'default';
    const { data, error } = await supabase.from('positions').select('*').eq('scope', scope);
    if (error) { res.status(500).json({ error: error.message }); return true; }
    const positions = ((data || []) as Record<string, unknown>[]).map(rowToPosition);
    res.status(200).json({ positions });
    return true;
  }
  if (req.method === 'POST') {
    const body = req.body as { scope?: string; positions: unknown[] };
    const scope = (body?.scope && typeof body.scope === 'string' ? body.scope : 'default').trim();
    const positions = Array.isArray(body?.positions) ? body.positions : [];
    if (positions.length === 0) {
      const { error: delErr } = await supabase.from('positions').delete().eq('scope', scope);
      if (delErr) { res.status(500).json({ error: delErr.message }); return true; }
      res.status(200).json({ ok: true });
      return true;
    }
    const rows = positions
      .filter((p): p is Record<string, unknown> => p != null && typeof p === 'object' && typeof (p as Record<string, unknown>).id === 'string')
      .map((p) => positionToRow(scope, p as Record<string, unknown>));
    const { error: delErr } = await supabase.from('positions').delete().eq('scope', scope);
    if (delErr) { res.status(500).json({ error: delErr.message }); return true; }
    const { error: insErr } = await supabase.from('positions').insert(rows);
    if (insErr) { res.status(500).json({ error: insErr.message }); return true; }
    res.status(200).json({ ok: true });
    return true;
  }
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Path segment: Vercel passes [...path] as req.query.path (array); fallback from URL
  const pathArr = req.query.path;
  const pathSegments = Array.isArray(pathArr) ? pathArr : (typeof pathArr === 'string' ? [pathArr] : (req.url || '').split('?')[0].split('/').filter(Boolean));
  const resource = getResource(pathSegments);

  if (!resource || !['event-state', 'strategy-config', 'trades', 'positions'].includes(resource)) {
    return res.status(404).json({ error: 'Not found. Use /api/data/event-state, strategy-config, trades, or positions' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  try {
    const supabase = getSupabase();
    let handled = false;
    if (resource === 'event-state') handled = await handleEventState(req, res, supabase);
    else if (resource === 'strategy-config') handled = await handleStrategyConfig(req, res, supabase);
    else if (resource === 'trades') handled = await handleTrades(req, res, supabase);
    else if (resource === 'positions') handled = await handlePositions(req, res, supabase);
    if (!handled) res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[data] Error:', message);
    res.status(500).json({ error: message });
  }
}
