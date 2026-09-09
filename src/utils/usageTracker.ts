/**
 * usageTracker.ts
 *
 * Lightweight client-side counter of AI requests made today, stored per model
 * id in localStorage. It is a per-browser estimate of the free daily rate
 * limit (Groq itself is the source of truth); the site uses it to show the
 * user how close they are to the daily free quota.
 *
 * When a Google account is signed in, its counters are stored under a
 * per-account key so each account's usage stays separate. Guests (no account)
 * keep using the shared guest counter.
 */

const STORAGE_PREFIX = 'ai_usage_v1_';

function dateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function storageKey(userId?: string): string {
  return `${STORAGE_PREFIX}${userId ? `${userId}_` : ''}${dateKey()}`;
}

function readMap(userId?: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeMap(userId: string | undefined, map: Record<string, number>): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(map));
  } catch {
    /* storage may be unavailable (private mode) — counter is best-effort */
  }
}

/** Number of requests counted today for the given model id. */
export function getUsage(modelId: string, userId?: string): number {
  if (!modelId) return 0;
  return readMap(userId)[modelId] || 0;
}

/** Increment today's counter for the given model id. */
export function recordUsage(modelId: string, userId?: string): void {
  if (!modelId) return;
  const map = readMap(userId);
  map[modelId] = (map[modelId] || 0) + 1;
  writeMap(userId, map);
}