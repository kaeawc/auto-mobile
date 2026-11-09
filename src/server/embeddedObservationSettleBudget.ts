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
