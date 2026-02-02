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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  try {
    const supabase = getSupabase();

    if (req.method === 'GET') {
      const scope = typeof req.query.scope === 'string' ? req.query.scope : null;
      let query = supabase.from('strategy_config').select('scope, config');
      if (scope) query = query.eq('scope', scope);
      const { data, error } = await query;

      if (error) {
        console.error('[strategy-config] GET error:', error);
        return res.status(500).json({ error: error.message });
      }

      const rows = (data || []) as { scope: string; config: unknown }[];
      if (scope && rows.length === 0) return res.status(200).json({ config: null });
      if (scope) return res.status(200).json({ config: rows[0].config });
      const byScope: Record<string, unknown> = {};
      for (const r of rows) byScope[r.scope] = r.config;
      return res.status(200).json({ byScope });
    }

    if (req.method === 'POST') {
      const body = req.body as { scope: string; config: unknown };
      const scope = body?.scope?.trim();
      if (typeof scope !== 'string' || !scope) {
        return res.status(400).json({ error: 'scope is required' });
      }
      if (body.config === undefined || body.config === null) {
        return res.status(400).json({ error: 'config is required' });
      }

      const { error } = await supabase.from('strategy_config').upsert(
        { scope, config: body.config, updated_at: new Date().toISOString() },
        { onConflict: 'scope' }
      );

      if (error) {
        console.error('[strategy-config] POST error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[strategy-config] Error:', message);
    return res.status(500).json({ error: message });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
