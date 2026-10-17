import type { CtrlProxyIncompleteReason, ObserveResult } from "../../models";
import { isStatusBarOnlyHierarchy } from "./WindowIdentityFreshness";
import {
  SYSTEM_UI_WINDOW_PACKAGES,
  hierarchyCarriesActivitySignal,
} from "./ActiveWindowAttribution";
import { findAppWindowBounds } from "./audits/PerformanceAuditor";

/** Pure verdicts over a captured observation that feed the freshness computation. */

// Framework-owned crash and ANR dialogs are windows created by system_server,
// so their accessibility hierarchy is labelled with this package rather than
// the resumed activity behind the dialog.
export const FRAMEWORK_WINDOW_PACKAGE = "android";
// AppErrorDialog's action IDs identify a captured crash dialog across locales.
export const APP_ERROR_RESOURCE_ID_PREFIX = "android:id/aerr_";

export function isEmptyFocusedWindow(result: ObserveResult): boolean {
  if (!result.activeWindow?.appId || !result.elements) {
    return false;
  }
  if (SYSTEM_UI_WINDOW_PACKAGES.has(result.activeWindow.appId)) {
    return false;
  }
  const appBounds = findAppWindowBounds(result, result.activeWindow.appId);
  const focused = appBounds ?? {
    top: 0,
    bottom: Infinity,
    left: -Infinity,
    right: Infinity,
  };
  // Native snapshots aggregate all windows and do not label individual nodes with
  // their package. Restrict content to the focused window and exclude system bars,
  // so a clock/icon sibling cannot certify an empty application window (#6352).
  const insets = result.systemInsets;
  const top = Math.max(focused.top, insets.top);
  const bottom = Math.min(
    focused.bottom,
    (result.viewHierarchy?.screenHeight ?? Infinity) - insets.bottom,
  );
  const left = Math.max(focused.left, insets.left);
  const right = Math.min(
    focused.right,
    (result.viewHierarchy?.screenWidth ?? Infinity) - insets.right,
  );
  return Object.values(result.elements).every((elements) =>
    elements.every(
      ({ bounds }) =>
        bounds.bottom <= top ||
        bounds.top >= bottom ||
        bounds.right <= left ||
        bounds.left >= right,
    ),
  );
}

/**
 * Synchronous counterpart to the async, device-confirmed status-bar-only gate
 * below (issue #6220): `activeWindow.appId` is empty even after every
 * fallback (viewHierarchy packageName, bootstrap attribution, etc.) has
 * already run against this result, so nothing identifies which app — if any —
 * the captured hierarchy belongs to. The async gate needs an independent
 * dumpsys read of the foreground app to name the mismatch; when that
 * confirming read itself comes back empty (or races), this still catches the
 * case without a device round-trip. A missing `viewHierarchy` is left to the
 * `unavailable` freshness path instead — this is only about a hierarchy that
 * WAS captured but carries no window identity.
 */
/**
 * Whether the observation carries ANY signal identifying a real foreground
 * application: a usable `activeWindow.appId`, `viewHierarchy.packageName`, or
 * a valid `foregroundActivity` (the raw accessibility signal, checked
 * directly rather than only through `activeWindow`). The third signal matters
 * on its own: deriving `activeWindow` from `foregroundActivity` in
 * `collectAllData` is gated on screen dimensions being present, so a
 * hierarchy that lacks `packageName`/dimensions but DOES carry a valid
 * `foregroundActivity` never gets an `activeWindow` at all — it must still
 * not be treated as identity-less (issue #6220 follow-up false-positive).
 * Single source of truth for "does this capture name an app", so a future
 * signal is added once here rather than risking one call site missing it.
 */
function hasForegroundAppIdentity(result: ObserveResult): boolean {
  return Boolean(
    result.activeWindow?.appId ||
    result.viewHierarchy?.packageName ||
    hierarchyCarriesActivitySignal(result.viewHierarchy),
  );
}

/**
 * Exported so other consumers can reuse the SAME machine-readable verdict
 * this freshness gate uses, instead of re-deriving "does this capture have a
 * foreground window" from a weaker proxy (e.g. package-name presence, which a
 * status-bar-only capture can still carry as stale metadata). `LaunchApp`
 * uses this to distinguish a status-bar-only/no-window post-launch capture
 * from a genuine wrong-app landing (issue #6239 review follow-up).
 */
export function resolveMissingForegroundWindow(
  result: ObserveResult,
): { reason: "status_bar_only" | "empty_active_window" } | undefined {
  if (!result.viewHierarchy?.hierarchy?.node) {
    return undefined;
  }
  // Status-bar-ONLY geometry is checked FIRST and dominates any lingering
  // identity metadata. `packageName`/`foregroundActivity` can survive on the
  // wire from a PRIOR resumed app even once the tree itself has collapsed to
  // chrome-only content (both ADB foreground reads coming back empty means
  // there is no ground truth to confirm or refute that staleness against) —
  // the geometry is the one signal that cannot lie about what actually came
  // back. `isStatusBarOnlyHierarchy` already distinguishes this incomplete,
  // chrome-only strip from a legitimate FULL-height SystemUI shade capture
  // (it returns `false` the moment any node extends below the status-bar
  // height), so a genuine expanded shade is never caught here — only the
  // provably-incomplete case is (issue #6239 review follow-up).
  if (isStatusBarOnlyHierarchy(result)) {
    return { reason: "status_bar_only" };
  }
  // `hasForegroundAppIdentity` is checked directly (not only via
  // `activeWindow.appId`, which the package-attribution fallback above should
  // already have backfilled from `viewHierarchy.packageName`): later stages
  // (e.g. `reconcileActiveWindowAttribution`, the SystemUI-overlay mirroring)
  // can still re-derive `activeWindow` after this point, and a
  // package/activity-attributed capture must never be reported as having no
  // foreground window regardless of what runs afterward (issue #6220
  // false-positive) — UNLESS the geometry above already proved it incomplete.
  if (hasForegroundAppIdentity(result)) {
    return undefined;
  }
  return { reason: "empty_active_window" };
}

/**
 * The service's own incomplete-capture signal (issue #6151), scoped to whether it
 * actually pertains to the SELECTED/focused window.
 *
 * `ctrlProxyIncomplete` on the wire is a single, generic flag: CtrlProxy sets it
 * whenever ANY active window was rootless, including an unrelated active
 * SystemUI/overlay window that has nothing to do with the focused application
 * (#6151 follow-up). Converting that flag unconditionally into a retracted
 * verdict over-corrects: a perfectly good, verified focused-app hierarchy would
 * be reported `verified: false` / `isFresh: false` on every observe that happens
 * to catch a transient rootless overlay elsewhere on screen.
 *
 * Correlate it the same way `resolveStatusBarOnlyHierarchy` correlates a
 * wrong-window capture: the observed package is the selected window's own
 * identity, so when it matches the device's current foreground app, that
 * window's content is trustworthy and the flag does not describe it — do not
 * retract. It only describes the selected window when the observed package is
 * absent or does not match the foreground app (a substituted window from the
 * incomplete-capture fallback, or no content at all) — the genuine #6151 case,
 * where the focused app's OWN root was null.
 *
 * `foreground` MUST be the SETTLED/confirmed identity (the same post-capture
 * sample `resolveWindowIdentityMismatch` and `resolveStatusBarOnlyHierarchy`
 * trust), never the initial parallel sample taken before capture. During an
 * A→B app transition the initial sample can still read A while the hierarchy
 * (and the confirming read) are already on B; comparing against the stale
 * initial sample would see `observed (B) !== initial foreground (A)` and
 * retract freshness even though B was just confirmed as the settled foreground
 * — discarding the very confirmation the rest of this freshness logic relies on
 * (#6151 follow-up).
 */
export function describeIncompleteCapture(
  hierarchy: ObserveResult["viewHierarchy"],
  foreground: string | undefined,
  confirmedFrameworkErrorDialog: boolean,
):
  | {
      sdkInt: number | undefined;
      reason: CtrlProxyIncompleteReason | undefined;
      accessibilityTool: boolean | undefined;
    }
  | undefined {
  if (hierarchy?.ctrlProxyIncomplete !== true) {
    return undefined;
  }
  if (confirmedFrameworkErrorDialog && hierarchy.packageName === FRAMEWORK_WINDOW_PACKAGE) {
    return undefined;
  }
  const observed = hierarchy.packageName;
  if (foreground !== undefined && observed !== undefined && observed === foreground) {
    return undefined;
  }
  // `ctrlProxyIncompleteReason` names the actual cause so the freshness warning can
  // give cause-appropriate advice (issue #6184); pre-#6172 runners omit it, and the
  // freshness layer treats an absent reason as the historical `null_root` default.
  return {
    sdkInt: hierarchy.sdkInt,
    reason: hierarchy.ctrlProxyIncompleteReason,
    accessibilityTool: hierarchy.accessibilityTool,
  };
}
