// Interpret the native account endpoint, never reset-time prose from a model.
export function quotaAvailability(result: any, now = Date.now()): {
  available: boolean; nextCheck: number; reason: string;
} {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const unknown = { available: false, nextCheck: now + 300000, reason: "Usage availability is unknown" };
  if (!bucket) return unknown;
  const windows = [bucket.primary, bucket.secondary].filter(Boolean);
  if (!windows.length || windows.some(w => typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent))) return unknown;
  const exhausted = windows.filter(w => w.usedPercent >= 100);
  const blocked = exhausted.length > 0 || bucket.spendControlReached === true || Boolean(bucket.rateLimitReachedType);
  const resets = exhausted.map(w => Number(w.resetsAt) * 1000).filter(t => Number.isFinite(t) && t > now);
  // Periodic read-only checks also notice a reset the operator applied manually.
  const nextCheck = Math.max(now + 60000, Math.min(now + 300000, resets.length ? Math.max(...resets) + 1000 : now + 300000));
  return { available: !blocked, nextCheck, reason: blocked ? "Native account reports unavailable quota" : "Native account reports available quota" };
}
