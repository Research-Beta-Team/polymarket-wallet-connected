<<<<<<< HEAD
/**
 * Positions API client — load/replace positions in Supabase.
 */

import type { Position } from './trading-types';

const POSITIONS_PATH = '/api/positions';

export async function fetchPositions(scope: string = 'default'): Promise<Position[]> {
  const res = await fetch(`${POSITIONS_PATH}?scope=${encodeURIComponent(scope)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `positions GET ${res.status}`);
  }
  const data = (await res.json()) as { positions: Position[] };
  return data.positions ?? [];
}

export async function savePositions(scope: string, positions: Position[]): Promise<void> {
  const res = await fetch(POSITIONS_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, positions }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `positions POST ${res.status}`);
  }
}
=======
/**
 * Positions API client — load/replace positions in Supabase.
 */

import type { Position } from './trading-types';

const POSITIONS_PATH = '/api/positions';

export async function fetchPositions(scope: string = 'default'): Promise<Position[]> {
  const res = await fetch(`${POSITIONS_PATH}?scope=${encodeURIComponent(scope)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `positions GET ${res.status}`);
  }
  const data = (await res.json()) as { positions: Position[] };
  return data.positions ?? [];
}

export async function savePositions(scope: string, positions: Position[]): Promise<void> {
  const res = await fetch(POSITIONS_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, positions }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `positions POST ${res.status}`);
  }
}
>>>>>>> 2f473d52c73e8762fcf5f77af1049fde87a86a0e
