import type { Database } from "bun:sqlite";

const DECAY_RATE = 0.95; // ~5% per day, halves every ~14 days
const DEFAULT_DEPOSIT = 1.0;
const WEAK_DEPOSIT = 0.3; // for listing (weaker signal than search)

/**
 * Deposit pheromone signal on a note (reinforcement).
 * Called whenever a note is surfaced to an agent.
 */
export function depositSignal(
  db: Database,
  noteId: string,
  amount: number = DEFAULT_DEPOSIT
): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE notes SET signal = COALESCE(signal, 0) + ?, last_accessed_at = ? WHERE id = ?`,
    [amount, now, noteId]
  );
}

/**
 * Deposit signal on multiple notes at once (batch).
 */
export function depositSignalBatch(
  db: Database,
  noteIds: string[],
  amount: number = DEFAULT_DEPOSIT
): void {
  if (noteIds.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE notes SET signal = COALESCE(signal, 0) + ?, last_accessed_at = ? WHERE id = ?`
  );
  for (const id of noteIds) {
    stmt.run(amount, now, id);
  }
}

/**
 * Decay all signals based on time elapsed since last access.
 * signal = signal * (DECAY_RATE ^ days_since_last_access)
 *
 * Called during retro/reflect. Notes with no signal or no last_accessed_at are skipped.
 * After decay, notes with signal < 0.01 are zeroed out to avoid floating point dust.
 */
export function decayAllSignals(db: Database): number {
  // SQLite doesn't have POWER() in all builds, so we compute in JS
  const rows = db
    .query(
      `SELECT id, signal, last_accessed_at FROM notes
       WHERE signal > 0 AND last_accessed_at IS NOT NULL`
    )
    .all() as Array<{ id: string; signal: number; last_accessed_at: string }>;

  if (rows.length === 0) return 0;

  const now = Date.now();
  const stmt = db.prepare(`UPDATE notes SET signal = ? WHERE id = ?`);
  let decayed = 0;

  for (const row of rows) {
    const lastAccess = new Date(row.last_accessed_at).getTime();
    const daysSince = (now - lastAccess) / (1000 * 60 * 60 * 24);
    if (daysSince <= 0) continue;

    const newSignal = row.signal * Math.pow(DECAY_RATE, daysSince);
    const finalSignal = newSignal < 0.01 ? 0 : newSignal;

    if (finalSignal !== row.signal) {
      stmt.run(finalSignal, row.id);
      decayed++;
    }
  }

  return decayed;
}

/**
 * Compute the search ranking boost from signal strength.
 * Returns a multiplier >= 1.0.
 */
export function signalBoost(signal: number): number {
  return 1 + 0.1 * Math.log(1 + Math.max(0, signal));
}

/**
 * Compute confidence multiplier for ranking.
 */
export function confidenceMultiplier(confidence: string): number {
  switch (confidence) {
    case "high": return 1.2;
    case "low": return 0.8;
    default: return 1.0; // medium
  }
}

export { DEFAULT_DEPOSIT, WEAK_DEPOSIT, DECAY_RATE };
