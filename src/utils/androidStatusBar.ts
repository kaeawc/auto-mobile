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

/**
 * Resource-id ALLOWLIST for the actual Android status-bar chrome — the clock,
 * signal/battery icons, and their containers (`com.android.systemui:id/clock`,
 * `:id/wifi_signal`, `:id/battery`, `:id/status_bar_container`, …). This block
 * is re-emitted on EVERY observation of EVERY screen (issue #6221 item 1) and
 * carries no affordances, so SkeletonProjection folds every
 * matching zero-affordance row into one summarized `context` entry instead of
 * emitting each one separately.
 *
 * Deliberately an ALLOWLIST, not a `com.android.systemui:id/` prefix match
 * (PR #6242 review PRRT_kwDOP-GF5M6fq3iH): the notification SHADE lives under
 * the same `com.android.systemui` namespace (e.g. `:id/notification_row_1`,
 * `:id/notification_stack_scroller` — see `test/features/systemTray/systemTray.test.ts`),
 * and those rows are ACTIONABLE and must stay individually selectable, never
 * folded into this summary. Only genuine status-bar chrome collapses; a new
 * systemui id that isn't on this list simply stays its own `context` entry
 * (still correct, just not collapsed) rather than risking a false positive.
 */
const SYSTEMUI_STATUS_BAR_ID_PATTERN =
  /^com\.android\.systemui:id\/(status_bar[a-zA-Z_]*|clock|battery[a-zA-Z_]*|wifi_[a-zA-Z_]*|system_icons|statusIcons|notification_icon_area|notificationIcons)$/;

/** Matches only the shared status-bar allowlist, never notification-shade rows. */
export function isSystemUiStatusBarId(resourceId: unknown): boolean {
  return typeof resourceId === "string" && SYSTEMUI_STATUS_BAR_ID_PATTERN.test(resourceId);
}
