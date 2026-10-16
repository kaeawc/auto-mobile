import type { ObservedChangeOptions } from "./BaseVisualChange";

/** The skip/defer/mode booleans of {@link ObservedChangeOptions} that profiles set together. */
export type ObservedInteractionFlags = Pick<
  ObservedChangeOptions,
  | "changeExpected"
  | "foregroundAppMayChange"
  | "observePartialApplication"
  | "usesObservationForResolution"
  | "resolvesTargetFromRead"
  | "skipCallerDisplayFence"
  | "skipPreviousObserve"
  | "skipUiStability"
  | "deferPredictionOutcome"
  | "deferPostActionScreenshot"
>;

/**
 * Named flag combinations for `observedInteraction`. Spread one into the options and add only the
 * per-call exceptions after it (later keys win), so a call site says what kind of interaction it is
 * instead of repeating a flag bag.
 */
export const OBSERVED_INTERACTION_PROFILES = {
  /** A gesture at coordinates the caller chose: no visual change is promised. */
  rawCoordinateGesture: { changeExpected: false },
  /**
   * A gesture whose target comes from a selector resolved against the pre-action read, so an
   * older caller display generation may be refreshed once instead of refused (#9847).
   */
  selectorResolvedGesture: { changeExpected: false, resolvesTargetFromRead: true },
  /**
   * Input that never resolves coordinates from the prior tree and promises no visual change:
   * hardware buttons, shakes, URL dispatch and element swipes whose geometry is computed up front.
   */
  noTreeResolution: { usesObservationForResolution: false, changeExpected: false },
  /** Accessibility-service text edits: no coordinates, and the service already waited for the tree. */
  textEdit: {
    usesObservationForResolution: false,
    changeExpected: false,
    skipUiStability: true,
  },
  /** Starting an app: the previous tree is unusable and the screenshot can follow the response. */
  appLaunch: {
    changeExpected: false,
    skipPreviousObserve: true,
    deferPostActionScreenshot: true,
  },
} as const satisfies Record<string, ObservedInteractionFlags>;

/** Post-action settle budgets (`timeoutMs`) by the kind of change the action causes. */
export const SETTLE_BUDGET_MS = {
  /** An accessibility-service edit whose tree update is already awaited. */
  immediate: 100,
  /** A quick in-place change (selection, a small swipe). */
  brief: 500,
  /** A tap or selector-resolved gesture. */
  gesture: 800,
  /** A hardware button press. */
  navigation: 2000,
  /** Opening or leaving system UI (recent apps). */
  systemUi: 3000,
  /** Device, app-lifecycle and biometric changes that animate or relaunch. */
  lifecycle: 5000,
  /** A multi-touch pinch or rotate-style gesture with a long dispatch. */
  longGesture: 8000,
  /** A URL dispatch that can launch another app. */
  urlDispatch: 12000,
} as const;
