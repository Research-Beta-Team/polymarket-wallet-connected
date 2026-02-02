/**
 * Strategy config API client — load/save strategy config from Supabase.
 */

const STRATEGY_CONFIG_PATH = '/api/strategy-config';

export async function fetchStrategyConfig(scope: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${STRATEGY_CONFIG_PATH}?scope=${encodeURIComponent(scope)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `strategy-config GET ${res.status}`);
  }
  const data = (await res.json()) as { config: Record<string, unknown> | null };
  return data.config ?? null;
}

export async function saveStrategyConfig(scope: string, config: Record<string, unknown>): Promise<void> {
  const res = await fetch(STRATEGY_CONFIG_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, config }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string })?.error || `strategy-config POST ${res.status}`);
  }
}
