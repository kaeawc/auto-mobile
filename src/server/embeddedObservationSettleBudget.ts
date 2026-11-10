/**
 * Budget for the embedded-observation settle gate (issue #6866).
 *
 * Deliberately tighter than the standalone `observe(waitFor: {for: "stable"})`
 * default (`DEFAULT_SETTLE_TIMEOUT_MS`, 2500ms): this runs on the hot path of
 * EVERY navigation-class action, and a screen that never reaches structural
 * stability (a ticking clock, a blinking caret) would otherwise spend the full
 * standalone budget on every tap. A screen that is merely finishing inflation
 * settles in two polls, so the bound is only ever paid by screens that would
 * not have settled anyway — and those report `settled: false` rather than
 * stalling the action.
 */
export const EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS = 1000;

/**
 * Upper bound for a per-call `settleTimeoutMs` override (#17663). The gate runs
 * after an action that already happened, so a caller may shorten or skip it
 * (`0`) but never turn it back into a multi-second stall.
 */
export const EMBEDDED_OBSERVATION_SETTLE_MAX_TIMEOUT_MS = 3000;

/**
 * Extra budget the gate may spend while the only changes between its reads are
 * ticking or blinking nodes (#17749). A running Clock stopwatch needs three
 * polls to prove its tick (the action's capture counts as the first diff) and a
 * terminal back-stack read; at the ~300 ms a read costs on an emulator, plus the
 * poll interval, that is about 1.4 s, which a 1 s budget cuts off every time. Any
 * other change withdraws the extension, so a screen that is still moving stops
 * at the plain budget, and a static screen settles before it matters.
 */
export const EMBEDDED_OBSERVATION_SETTLE_TICK_EXTENSION_MS = 500;

/**
 * The tick extension for a loop budget: at most half of it, so a shortened
 * per-call budget shrinks the extension with it and the gate's outer fence
 * (budget plus a margin of up to the budget) keeps at least half its margin for
 * terminal work. A skipped gate (`0`) gets none.
 */
export function embeddedObservationSettleTickExtensionMs(budgetMs: number): number {
  return Math.max(
    0,
    Math.min(EMBEDDED_OBSERVATION_SETTLE_TICK_EXTENSION_MS, Math.floor(budgetMs / 2)),
  );
}
