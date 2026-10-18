/** Timing budgets shared by LaunchApp and its launch collaborators. */

export const LAUNCH_OBSERVATION_TIMEOUT_MS = 5000;
export const LAUNCH_OBSERVATION_POLL_INTERVAL_MS = 200;
/** Budget for the Android a11y service to answer a launch-intent request. */
export const A11Y_LAUNCH_INTENT_TIMEOUT_MS = 3_000;
/** Cold iOS app starts can take a long time before CtrlProxy publishes a hierarchy. */
export const IOS_HIERARCHY_READY_TIMEOUT_MS = 60_000;
export const ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS = 15_000;
export const SHADE_COLLAPSE_RETRY_INTERVAL_MS = 1_000;
// One bounded lock re-read before a launch timeout names a SystemUI blocker (#10182).
export const LAUNCH_BLOCKER_LOCK_REREAD_TIMEOUT_MS = 3_000;
export const ANDROID_PREFLIGHT_ABORT_SETTLEMENT_GRACE_MS = 1_000;
export const IOS_RETARGET_ABORT_SETTLEMENT_GRACE_MS = 1_000;
export const ANDROID_COLD_FRAME_TIMEOUT_MS = 2_500;
export const ANDROID_COLD_FRAME_POLL_MS = 150;
