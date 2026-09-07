/**
 * usageTracker.ts
 *
 * Lightweight client-side counter of AI requests made today, stored per model
 * id in localStorage. It is a per-browser estimate of the free daily rate
 * limit (Groq itself is the source of truth); the site uses it to show the
 * user how close they are to the daily free quota.
 */

const STORAGE_PREFIX = 'ai_usage_v1_';

function dateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${dateKey()}`);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${dateKey()}`, JSON.stringify(map));
  } catch {
    /* storage may be unavailable (private mode) — counter is best-effort */
  }
}

/** Number of requests counted today for the given model id. */
export function getUsage(modelId: string): number {
  if (!modelId) return 0;
  return readMap()[modelId] || 0;
}

/** Increment today's counter for the given model id. */
export function recordUsage(modelId: string): void {
  if (!modelId) return;
  const map = readMap();
  map[modelId] = (map[modelId] || 0) + 1;
  writeMap(map);
}