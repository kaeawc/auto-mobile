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
  /**
   * Device-clock seed for the poll's entering reference, forwarded verbatim to
   * {@link pollObserveUntil}'s `initialMinTimestampMs` (issue #6866). Supply the
   * device-authored `updatedAt` of a capture the caller ALREADY holds — e.g. an
   * action tool's post-action observation — so the settle loop must read
   * strictly past it and can neither re-serve that same capture nor treat it as
   * one of the two consecutive stable reads. Omit it for the standalone
   * `observe(waitFor: {for: "stable"})` path, which has no prior capture.
   *
   * Never pass a host-clock value: a device clock trailing the daemon (#5377)
   * would reject every genuinely fresh capture and burn the whole budget.
   */
  initialMinTimestampMs?: number;
  /**
   * Skip the performance audit on every settle poll, forwarded verbatim to
   * {@link pollObserveUntil} (issue #6890 review). Off by default: the
   * standalone `observe(waitFor: {for: "stable"})` path keeps whatever the
   * caller's audit configuration asks for. Set it on a short-budget loop that
   * runs on a hot path -- the embedded-observation settle gate (#6866) -- where
   * a per-poll audit's synthetic touches would perturb the very screen being
   * settled and blow the budget several times over.
   */
  skipPerformanceAudit?: boolean;
  /**
   * Skip recomposition processing on every settle poll, forwarded verbatim to
   * {@link pollObserveUntil}. The embedded settle gate opts in so only its
   * adopted terminal capture updates recomposition state and telemetry (#6932).
   */
  skipRecompositionTracking?: boolean;
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
  /** Why polling completed. This distinguishes a budget timeout from screen-off. */
  terminalReason: "settled" | "screen_off" | "timeout";
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
 *   inspect `terminalReason` to tell it from a real timeout.
 */
export interface SettleObserve {
  execute(options?: SettleOptions): Promise<SettleResult>;
}
