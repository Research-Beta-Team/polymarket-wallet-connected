/**
 * Trades API client — load/append trades from Supabase.
 */

import type { Trade } from './trading-types';

const TRADES_PATH = '/api/trades';

export async function fetchTrades(scope: string = 'default'): Promise<Trade[]> {
  const res = await fetch(`${TRADES_PATH}?scope=${encodeURIComponent(scope)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `trades GET ${res.status}`);
  }
  const data = (await res.json()) as { trades: Trade[] };
  return data.trades ?? [];
}

export async function saveTrade(scope: string, trade: Trade): Promise<void> {
  const res = await fetch(TRADES_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, trade }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `trades POST ${res.status}`);
  }
}
