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

/**
 * SystemUI status-bar cell-signal rows (`mobile_combo`, `mobile_signal`, `signal_cluster`, …).
 * Their content-desc follows the simulated signal strength on an emulator, so they change between
 * any two captures (#19123). Kept out of {@link SYSTEMUI_STATUS_BAR_ID_PATTERN} so the skeleton's
 * status-bar folding is unchanged; quick-settings tiles use other ids.
 */
const SYSTEMUI_SIGNAL_ROW_ID_PATTERN =
  /^com\.android\.systemui:id\/(mobile_[a-zA-Z_]*|signal_cluster[a-zA-Z_]*)$/;

/** Attributes that make a node something a user acts on, so its subtree is never chrome. */
const AFFORDANCE_ATTRIBUTES = ["clickable", "long-clickable", "checkable", "scrollable"] as const;

/** The subset of a hierarchy node the status-bar skip reads. */
export interface StatusBarDiffNode {
  readonly [attribute: string]: unknown;
  readonly node?: unknown;
}

function hasAffordance(node: StatusBarDiffNode): boolean {
  return AFFORDANCE_ATTRIBUTES.some(
    (attribute) => node[attribute] === true || node[attribute] === "true",
  );
}

function childNodes(node: StatusBarDiffNode): StatusBarDiffNode[] {
  const children = Array.isArray(node.node) ? node.node : [node.node];
  return children.filter(
    (child): child is StatusBarDiffNode => typeof child === "object" && child !== null,
  );
}

function subtreeHasAffordance(node: StatusBarDiffNode): boolean {
  return hasAffordance(node) || childNodes(node).some(subtreeHasAffordance);
}

/**
 * Whether a node and its subtree are status-bar chrome that screen-change detection leaves out
 * (`flattenForDiff`'s `skipStatusBar`). A known status-bar root always is. An allowlisted
 * status-bar id or a cell-signal row found elsewhere (#19123) is only when nothing in its subtree
 * is clickable, long-clickable, checkable or scrollable: SystemUI dialogs reuse `wifi_*` and
 * `mobile_*` ids for toggle rows whose state change must still count (#19155).
 */
export function isStatusBarDiffSubtree(node: StatusBarDiffNode): boolean {
  const resourceId = node["resource-id"];
  if (typeof resourceId !== "string") {
    return false;
  }
  if (STATUS_BAR_ROOT_IDS.has(resourceId)) {
    return true;
  }
  return (
    (SYSTEMUI_STATUS_BAR_ID_PATTERN.test(resourceId) ||
      SYSTEMUI_SIGNAL_ROW_ID_PATTERN.test(resourceId)) &&
    !subtreeHasAffordance(node)
  );
}
