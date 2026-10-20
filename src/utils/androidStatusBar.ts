/**
 * Roots of the SystemUI status bar subtree (clock, notification icons, signal, battery). It changes
 * on its own and is not part of any app screen, so screen-change detection leaves it out
 * (`flattenForDiff`'s `skipStatusBar`, the hierarchy fingerprint, #13561). Exact ids only: the
 * notification shade and other SystemUI windows are separate subtrees and still count.
 */
export const STATUS_BAR_ROOT_IDS: ReadonlySet<string> = new Set([
  "com.android.systemui:id/status_bar_launch_animation_container",
  "com.android.systemui:id/status_bar_container",
  "com.android.systemui:id/status_bar",
]);
