import type { ObserveResult } from "../../../models";

/**
 * Options for a settle-loop observe (issue #4389). All time control flows through
 * the injected {@link Timer}; the budget is a MANDATORY fallback so the loop can
 * never hang on an animation that never stops.
 */
export interface SettleOptions {
  /** Hard budget in ms — the mandatory timeout fallback (default 2500). */
  timeoutMs?: number;
  /** Poll interval in ms between observations (default 150, matches waitForScrollIdle). */
  pollMs?: number;
  /** Consecutive structurally-equal snapshots required to declare settled (default 2). */
  stableReads?: number;
  /** Cancellation signal, checked before each poll and after each observation. */
  signal?: AbortSignal;
}

/**
 * Result of a settle-loop observe. Carries only the final snapshot — the
 * intermediate transition hierarchies are dropped, which is the whole point
 * (keeps mid-animation trees out of the model's context).
 */
export interface SettleResult {
  /** The final (settled, or last-seen-on-timeout) observation. */
  observation: ObserveResult;
  /** True when the screen reached structural stability within budget. */
  settled: boolean;
  /** Number of observations taken. */
  polls: number;
  /** Wall-clock spent waiting (per the injected Timer). */
  waitMs: number;
}

/**
 * Poll the screen until the view hierarchy is structurally stable (two
 * consecutive structurally-equal snapshots) or a budget expires, returning only
 * the final snapshot.
 *
 * Known limitations (all resolve to a graceful `settled: false` on timeout, never
 * a hang):
 * - A screen with a continuously-changing node (a status-bar clock ticking, a
 *   blinking caret) will not reach structural stability while it changes; the
 *   timeout governs. `settled: false` on such a screen is not a failure.
 * - A screen whose `screenIdentity` confidence is `low` never passes the
 *   `isSameObservationScreen` gate, so it can never register as settled. This is
 *   the shared diff's conservative cross-screen guard, not a settle-specific one.
 * - A screen-off (Android) capture fast-fails to `settled: false, polls: 1`;
 *   inspect `observation.wakefulness === "Asleep"` to tell it from a real timeout.
 */
export interface SettleObserve {
  execute(options?: SettleOptions): Promise<SettleResult>;
}
