<<<<<<< HEAD
/**
 * Event state API client — persist/load price-to-beat and last-price per event (Supabase).
 * Survives page reload so mid-event values are not lost.
 */

const EVENT_STATE_PATH = '/api/event-state';

export interface EventStateResponse {
  priceToBeat: Record<string, number>;
  lastPrice: Record<string, number>;
}

export async function fetchEventState(): Promise<EventStateResponse> {
  const res = await fetch(EVENT_STATE_PATH);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err?.error || `event-state GET ${res.status}`);
  }
  return res.json();
}

export async function saveEventState(
  eventSlug: string,
  data: { priceToBeat?: number; lastPrice?: number }
): Promise<void> {
  const body: { eventSlug: string; priceToBeat?: number; lastPrice?: number } = { eventSlug };
  if (data.priceToBeat !== undefined) body.priceToBeat = data.priceToBeat;
  if (data.lastPrice !== undefined) body.lastPrice = data.lastPrice;

  const res = await fetch(EVENT_STATE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err?.error || `event-state POST ${res.status}`);
  }
}
=======
/**
 * Event state API client — persist/load price-to-beat and last-price per event (Supabase).
 * Survives page reload so mid-event values are not lost.
 */

const EVENT_STATE_PATH = '/api/event-state';

export interface EventStateResponse {
  priceToBeat: Record<string, number>;
  lastPrice: Record<string, number>;
}

export async function fetchEventState(): Promise<EventStateResponse> {
  const res = await fetch(EVENT_STATE_PATH);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err?.error || `event-state GET ${res.status}`);
  }
  return res.json();
}

export async function saveEventState(
  eventSlug: string,
  data: { priceToBeat?: number; lastPrice?: number }
): Promise<void> {
  const body: { eventSlug: string; priceToBeat?: number; lastPrice?: number } = { eventSlug };
  if (data.priceToBeat !== undefined) body.priceToBeat = data.priceToBeat;
  if (data.lastPrice !== undefined) body.lastPrice = data.lastPrice;

  const res = await fetch(EVENT_STATE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err?.error || `event-state POST ${res.status}`);
  }
}
>>>>>>> 2f473d52c73e8762fcf5f77af1049fde87a86a0e
