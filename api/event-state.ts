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

export interface EventStateRow {
  event_slug: string;
  price_to_beat: number | null;
  last_price: number | null;
  updated_at: string;
}

export interface EventStateResponse {
  priceToBeat: Record<string, number>;
  lastPrice: Record<string, number>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    });
  }

  try {
    const supabase = getSupabase();

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('event_state')
        .select('event_slug, price_to_beat, last_price')
        .order('updated_at', { ascending: false });

      if (error) {
        console.error('[event-state] GET error:', error);
        return res.status(500).json({ error: error.message });
      }

      const priceToBeat: Record<string, number> = {};
      const lastPrice: Record<string, number> = {};
      for (const row of (data || []) as EventStateRow[]) {
        if (row.price_to_beat != null) priceToBeat[row.event_slug] = Number(row.price_to_beat);
        if (row.last_price != null) lastPrice[row.event_slug] = Number(row.last_price);
      }

      return res.status(200).json({ priceToBeat, lastPrice } as EventStateResponse);
    }

    if (req.method === 'POST') {
      const body = req.body as { eventSlug: string; priceToBeat?: number; lastPrice?: number };
      const eventSlug = body?.eventSlug?.trim();
      if (typeof eventSlug !== 'string' || !eventSlug) {
        return res.status(400).json({ error: 'eventSlug is required' });
      }

      const { data: existing } = await supabase
        .from('event_state')
        .select('price_to_beat, last_price')
        .eq('event_slug', eventSlug)
        .maybeSingle();

      const row = (existing as { price_to_beat?: number; last_price?: number } | null) || {};
      const payload: { event_slug: string; price_to_beat: number | null; last_price: number | null; updated_at: string } = {
        event_slug: eventSlug,
        price_to_beat: typeof body.priceToBeat === 'number' ? body.priceToBeat : (row.price_to_beat ?? null),
        last_price: typeof body.lastPrice === 'number' ? body.lastPrice : (row.last_price ?? null),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from('event_state').upsert(payload, {
        onConflict: 'event_slug',
        ignoreDuplicates: false,
      });

      if (error) {
        console.error('[event-state] POST error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[event-state] Error:', message);
    return res.status(500).json({ error: message });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
