// Shared amortized single-flight gate for row-cap retention cleanups (#6702).
//
// `eventRetention.ts` and `rowCapRetention.ts` each drove a byte-identical copy
// of this state machine: bump a counter on every insert, skip until the counter
// reaches `checkInterval`, and guard the cleanup body so overlapping calls never
// run concurrently. The duplication let the same counter-reset-before-in-progress
// bug (#6657) exist in both copies and require two separate fixes. This module is
// the single implementation both now delegate to.

/** Amortization counter + single-flight guard for one retained table/state owner. */
export interface AmortizedRetentionState {
  cleanupInProgress: boolean;
  insertsSinceCleanup: number;
}

/** A fresh, zeroed amortization counter/guard pair. */
export function createAmortizedRetentionState(): AmortizedRetentionState {
  return { cleanupInProgress: false, insertsSinceCleanup: 0 };
}

/**
 * Amortize `runCleanup` across inserts: bump `state.insertsSinceCleanup` by
 * `inserted`, and only invoke `runCleanup` once the counter reaches
 * `checkInterval` AND no cleanup is already in flight.
 *
 * The counter is bumped synchronously on every call so cleanup still fires
 * deterministically every `checkInterval` inserts without putting a scan on the
 * hot path. Critically, the counter is only reset once we've committed to
 * running the cleanup body: if a cleanup is already in progress, the counter is
 * left at-or-above `checkInterval` so the very next call re-checks this gate
 * instead of silently re-arming a fresh `checkInterval`-insert countdown
 * (#6657).
 *
 * `runCleanup` errors propagate to the caller — this gate does not own error
 * handling policy. The guard is released via `finally` regardless of success or
 * failure, so a caller that wants to swallow/log cleanup failures must do so
 * inside `runCleanup` itself.
 */
export async function runAmortizedRetentionGate(
  state: AmortizedRetentionState,
  runCleanup: () => Promise<void>,
  checkInterval: number,
  inserted: number = 1,
): Promise<void> {
  state.insertsSinceCleanup += inserted;
  if (state.insertsSinceCleanup < checkInterval) {
    return;
  }

  if (state.cleanupInProgress) {
    return;
  }
  state.insertsSinceCleanup = 0;
  state.cleanupInProgress = true;
  try {
    await runCleanup();
  } finally {
    state.cleanupInProgress = false;
  }
}
