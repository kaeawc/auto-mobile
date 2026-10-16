import type { BootedDevice, ObserveResult, ViewHierarchyWindowInfo } from "../../models";
import { logger } from "../../utils/logger";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { appendObserveError } from "./ObserveError";
import { resolveIosObserveRotation } from "./iosObserveRotation";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import type { DeviceStateCollector } from "./collectors/DeviceStateCollector";
import type { HierarchyPlatformValidator } from "./HierarchyPlatformValidator";

/**
 * Packages that legitimately present as the accessibility active window without
 * being the device's resumed activity — a system-UI panel (notification shade,
 * quick settings, volume, power dialog, keyguard) is a window, not an
 * ActivityRecord, so it never appears as the resumed activity behind it. The
 * window-identity freshness check (issue #5867) excludes these to avoid
 * misreporting an expanded shade as a stale wrong-window capture.
 */
export const SYSTEM_UI_WINDOW_PACKAGES = new Set<string>(["com.android.systemui"]);

const SYSTEM_UI_PACKAGE = "com.android.systemui";

/**
 * AccessibilityWindowInfo.TYPE_SYSTEM — the window type CtrlProxy reports for
 * framework surfaces (notification shade, quick settings, keyguard, status bar).
 * Same constant `androidSystemUiAnr.ts` keys the ANR dialog off.
 */
const ACCESSIBILITY_WINDOW_TYPE_SYSTEM = 3;

type FocusedSystemUiSignal = "focused" | "topmost-suspect" | "none";

function isSystemUiSurfaceWindow(window: ViewHierarchyWindowInfo): boolean {
  return (
    window.packageName === SYSTEM_UI_PACKAGE || window.type === ACCESSIBILITY_WINDOW_TYPE_SYSTEM
  );
}

/**
 * Whether a SystemUI window is large enough to be an occluding surface (an
 * expanded shade, quick settings, or keyguard) rather than the ever-present
 * thin status bar / navigation bar. Only used to decide whether the topmost
 * window is worth an adb `mCurrentFocus` confirmation, so a normal app screen —
 * where the status bar can be the topmost SystemUI window when no focus flag is
 * populated — never triggers a per-observe adb read. A window covering more than
 * half the screen height is a shade-class surface; the status bar is a small
 * fraction of it.
 */
function isOccludingSystemUiWindow(
  window: ViewHierarchyWindowInfo,
  screenHeight: number | undefined,
): boolean {
  const bounds = window.bounds;
  if (!bounds) {
    return false;
  }
  const height = bounds.bottom - bounds.top;
  if (screenHeight && screenHeight > 0) {
    return height > screenHeight / 2;
  }
  // No screen dimension to normalize against: fall back to an absolute floor
  // that a status/navigation bar never reaches but a shade always exceeds.
  return height > 400;
}

/**
 * Classify what the captured `windows[]` list says about a focused SystemUI
 * surface (issue #6078), the free (no-adb) primary signal:
 *
 * - `focused` — a window carries `isFocused === true` and it is a SystemUI
 *   surface. This mirrors `mCurrentFocus` directly; no adb read is needed.
 *   A focused non-SystemUI (ordinary app) window returns `none`.
 * - `topmost-suspect` — no window reports focus, but the topmost window (by
 *   `windowLayer`) is a large SystemUI surface (shade/quick-settings/keyguard,
 *   not the thin status bar). Focus is unconfirmed on this API level, so the
 *   caller confirms with a `dumpsys window` `mCurrentFocus` read.
 * - `none` — no `windows[]`, a focused app window, or a topmost app / status-bar
 *   window. An ordinary app screen never lands here as a suspect, so it never
 *   pays for the adb confirmation.
 */
function classifyFocusedSystemUiWindow(
  hierarchy: ObserveResult["viewHierarchy"],
): FocusedSystemUiSignal {
  const windows = hierarchy?.windows;
  if (!windows || windows.length === 0) {
    return "none";
  }
  const focused = windows.find((window) => window.isFocused === true);
  if (focused) {
    return isSystemUiSurfaceWindow(focused) ? "focused" : "none";
  }
  const topmost = windows.reduce((current, candidate) =>
    (candidate.windowLayer ?? 0) > (current.windowLayer ?? 0) ? candidate : current,
  );
  return isSystemUiSurfaceWindow(topmost) &&
    isOccludingSystemUiWindow(topmost, hierarchy?.screenHeight)
    ? "topmost-suspect"
    : "none";
}

export interface PostCaptureForegroundIdentity {
  displayId?: number;
  sampled: boolean;
  identity: string | undefined;
  activityAttributionMismatch: boolean;
}

export function isAccessibilityViewClass(foregroundActivity: string): boolean {
  const activityName = foregroundActivity.split("/")[1] ?? "";
  return (
    activityName.startsWith("android.widget.") ||
    activityName.startsWith("android.view.") ||
    activityName.endsWith("DecorView")
  );
}

/**
 * Whether the captured hierarchy itself names the foreground activity (the
 * accessibility-service path). When it does not — the lazy-CtrlProxy bootstrap
 * interval, where `activeWindow` comes from the legacy `Window.getActive()`
 * read — the tree carries no activity signal that could be correlated with the
 * adb reads that follow it (#6088).
 */
export function hierarchyCarriesActivitySignal(hierarchy: ObserveResult["viewHierarchy"]): boolean {
  const foregroundActivity = hierarchy?.foregroundActivity;
  return typeof foregroundActivity === "string" && !isAccessibilityViewClass(foregroundActivity);
}

/**
 * Does the hierarchy itself name the window `activeWindow` already claims? Only an
 * activity-bearing `foregroundActivity` (not a view class) can say so; anything else
 * cannot be compared and counts as not the same. No `activeWindow` has nothing to
 * disagree with.
 */
export function treeNamesWindow(
  hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  activeWindow: ObserveResult["activeWindow"],
): boolean {
  if (activeWindow === undefined) {
    return true;
  }
  if (!hierarchyCarriesActivitySignal(hierarchy)) {
    return false;
  }
  const [packageName, activity = ""] = (hierarchy.foregroundActivity ?? "").split("/");
  const activityName = activity.startsWith(".") ? packageName + activity : activity;
  return activeWindow.appId === packageName && activeWindow.activityName === activityName;
}

function isActivityInPackage(activityName: string, packageName: string): boolean {
  return activityName === packageName || activityName.startsWith(`${packageName}.`);
}

export function resolveBackStackActivityAttribution(
  result: ObserveResult,
): { packageName: string; activityName: string } | undefined {
  const packageName = result.viewHierarchy?.packageName;
  const backStack = result.backStack;
  if (!packageName || backStack?.source !== "adb") {
    return undefined;
  }
  const activityName = backStack.currentActivity?.name;
  if (!activityName) {
    return undefined;
  }
  if (isActivityInPackage(activityName, packageName)) {
    return { packageName, activityName };
  }

  const currentTaskId = backStack.currentActivity?.taskId;
  const ownedByPackage =
    backStack.tasks.some(
      (task) => task.id === currentTaskId && task.packageName === packageName,
    ) === true;
  return ownedByPackage ? { packageName, activityName } : undefined;
}

/** The same temporal-confirmation trigger for per-poll and deferred back-stack reads. */
export function needsBackStackActivityReconciliation(
  result: ObserveResult,
  activeWindow: NonNullable<ObserveResult["activeWindow"]>,
  attribution: { packageName: string; activityName: string },
): boolean {
  return (
    !hierarchyCarriesActivitySignal(result.viewHierarchy) ||
    activeWindow.activityName !== attribution.activityName
  );
}

export function hasUsableHierarchy(hierarchy: ObserveResult["viewHierarchy"]): boolean {
  return (
    hierarchy?.hierarchy !== undefined &&
    typeof hierarchy.hierarchy === "object" &&
    hierarchy.hierarchy !== null &&
    !("error" in hierarchy.hierarchy)
  );
}

export interface ActiveWindowAttributionReconciler {
  reconcileActiveWindowAttribution(
    result: ObserveResult,
    options?: { signal?: AbortSignal; readOnly?: boolean },
  ): Promise<PostCaptureForegroundIdentity>;
  applyRecapturedHierarchy(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void;
  recorrelateActiveWindowToRecapture(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void;
  recaptureHierarchyForSystemUiOverlay(
    result: ObserveResult,
    signal?: AbortSignal,
  ): Promise<boolean>;
  recaptureHierarchyForBackStackAttribution(
    result: ObserveResult,
    expected: { packageName: string; activityName: string },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

interface ActiveWindowAttributionDependencies {
  viewHierarchy: () => ViewHierarchyInterface;
  deviceStateCollector: () => Pick<
    DeviceStateCollector,
    | "collectForegroundIdentity"
    | "collectFocusedSystemUiSurface"
    | "collectDeviceLock"
    | "collectBackStack"
    | "collectActiveWindow"
  >;
  device: () => Pick<BootedDevice, "platform">;
  platformValidator: () => HierarchyPlatformValidator;
  resolveObservationTimestampMs: (result: ObserveResult) => number | undefined;
  extractScreenSizeFromHierarchy: (
    hierarchy: ObserveResult["viewHierarchy"],
  ) => { width: number; height: number } | null;
}

export class DefaultActiveWindowAttributionReconciler implements ActiveWindowAttributionReconciler {
  constructor(private readonly dependencies: ActiveWindowAttributionDependencies) {}

  private get viewHierarchy() {
    return this.dependencies.viewHierarchy();
  }
  private get deviceStateCollector() {
    return this.dependencies.deviceStateCollector();
  }
  private get device() {
    return this.dependencies.device();
  }
  private get platformValidator() {
    return this.dependencies.platformValidator();
  }
  private get resolveObservationTimestampMs() {
    return this.dependencies.resolveObservationTimestampMs;
  }
  private get extractScreenSizeFromHierarchy() {
    return this.dependencies.extractScreenSizeFromHierarchy;
  }

  /**
   * Correct stale accessibility-service window metadata when both the captured
   * hierarchy and the device's resumed activity identify the same app.
   *
   * CtrlProxy can retain a prior `foregroundActivity` after a window transition
   * even when its hierarchy has already caught up. The hierarchy package and
   * the device's foreground activity independently confirm the replacement, so
   * they are safer than the stale activity name for `activeWindow` consumers
   * such as `waitFor` (issue #5972). System UI is intentionally excluded: a
   * system panel can validly be the accessible window while another app remains
   * the resumed activity beneath it. The post-capture sample is returned so
   * freshness diagnostics can reuse the same ground-truth check.
   */
  async reconcileActiveWindowAttribution(
    result: ObserveResult,
    options: { signal?: AbortSignal; readOnly?: boolean } = {},
  ): Promise<PostCaptureForegroundIdentity> {
    const { signal, readOnly = false } = options;
    // A focused SystemUI surface (notification shade, quick settings, keyguard,
    // status bar owning focus) occludes the app behind it while CtrlProxy's
    // `foregroundActivity` and `adb getForegroundApp` both still name that
    // occluded app — neither reads `mCurrentFocus`. Mirror the SystemUI identity
    // into `activeWindow` so `waitFor.activeWindow.appId == <app>` fails closed
    // and one object never names two apps (issue #6078). This runs before the
    // #6070 back-stack backfill and the system-UI bail below.
    if (await this.applyFocusedSystemUiOverlay(result, signal)) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }

    // Read `activeWindow` AFTER the overlay check: its fallback recapture can
    // replace the tree and re-correlate `result.activeWindow` to it (#6108). A
    // pre-await capture would be the STALE pre-recapture window, and the
    // cross-package branch below would then spread it — erasing the re-derived
    // identity and re-publishing the stale `layoutSeqSum` (#6108, bug 1).
    const activeWindow = result.activeWindow;

    const observed = result.viewHierarchy?.packageName;
    if (
      observed === undefined ||
      activeWindow === undefined ||
      SYSTEM_UI_WINDOW_PACKAGES.has(observed)
    ) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }

    const backStackAttribution = resolveBackStackActivityAttribution(result);
    if (backStackAttribution) {
      const reconciled = await this.reconcileAgainstBackStack(
        result,
        activeWindow,
        backStackAttribution,
        { signal, readOnly },
      );
      if (reconciled) {
        return reconciled;
      }
    }

    if (activeWindow.appId === observed) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }

    const confirmed = await this.deviceStateCollector.collectForegroundIdentity(signal);
    if (confirmed === observed) {
      result.activeWindow = { ...activeWindow, appId: observed, activityName: "" };
    }
    return { sampled: true, identity: confirmed, activityAttributionMismatch: false };
  }

  /**
   * Temporal confirmation of the adb back-stack activity against a fresh
   * hierarchy (#5992, #6070, #6088). Returns the reconciled outcome, or
   * `undefined` when the back-stack read needs no reconciliation (the hierarchy
   * itself named the activity and it already agrees with `activeWindow`).
   */
  private async reconcileAgainstBackStack(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    backStackAttribution: { packageName: string; activityName: string },
    options: { signal?: AbortSignal; readOnly?: boolean } = {},
  ): Promise<PostCaptureForegroundIdentity | undefined> {
    const { signal, readOnly = false } = options;
    // On the bootstrap path the hierarchy names no activity, so `activeWindow`
    // and `backStack` are two adb reads taken AFTER the capture. Their agreeing
    // is not evidence the tree is aligned with either: a same-app A->B
    // navigation between the capture and those reads makes both report B while
    // the tree still describes A, and the package-level guard (#5867) cannot
    // tell A from B. Always confirm through the recapture there (#6088).
    const bootstrapAttribution = !hierarchyCarriesActivitySignal(result.viewHierarchy);
    if (!needsBackStackActivityReconciliation(result, activeWindow, backStackAttribution)) {
      return undefined;
    }
    // An empty `activityName` (the bootstrap `Window.getActive()` / last-resort
    // package path) is reconciled through the SAME temporal confirmation as a
    // stale non-empty name (#5992), never a blind backfill: the recapture
    // re-reads the hierarchy so the adb activity is paired with a *fresh* tree.
    // A same-app mid-flight navigation between capture and back-stack read is
    // therefore surfaced as a mismatch/unknown rather than a confidently-wrong
    // name, and the confirmed window keeps a correlated `layoutSeqSum` (re-read
    // after the accepted recapture, #6100) so tap-effect detection is not
    // blinded by a zero sentinel (#6070).
    const recaptured = await this.recaptureHierarchyForBackStackAttribution(
      result,
      backStackAttribution,
      signal,
    );
    if (!recaptured) {
      // Unconfirmed: the bootstrap window name is a post-capture adb read that
      // may post-date the tree, so it resolves to unknown rather than staying
      // published against a hierarchy it was never correlated with (#6088).
      if (bootstrapAttribution && activeWindow.activityName !== "") {
        result.activeWindow = { ...activeWindow, activityName: "" };
      }
      return { sampled: false, identity: undefined, activityAttributionMismatch: true };
    }
    const confirmedWindow = await this.refreshRecaptureSideSamples(
      result,
      activeWindow,
      backStackAttribution,
      bootstrapAttribution,
      { signal, readOnly },
    );
    result.activeWindow = confirmedWindow;
    // The recapture replaced the tree AFTER the focused-SystemUI check ran. A
    // shade or keyguard that took focus mid-recapture keeps the occluded app's
    // package (so the package and back-stack checks accept it); re-run the
    // overlay reconciliation so the published window names the surface on top
    // rather than the app beneath it (#6078, surfaced in #6088 review). The tree
    // was just recaptured here, so the #6091 fallback recapture is redundant —
    // skip it and confirm focus directly against this fresh tree.
    if (await this.applyFocusedSystemUiOverlay(result, signal, true)) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }
    // Do not pair an adb activity from a later navigation with an earlier
    // hierarchy. The forced recapture and repeated back-stack read establish
    // that both sources still describe the same destination (#5992).
    const reconciled = {
      ...confirmedWindow,
      appId: backStackAttribution.packageName,
      activityName: backStackAttribution.activityName,
    };
    if (result.notificationPermissionDetected) {
      reconciled.type = "notification_permission_dialog";
    } else {
      delete reconciled.type;
    }
    result.activeWindow = reconciled;
    return { sampled: false, identity: undefined, activityAttributionMismatch: false };
  }

  /**
   * Mirror the SystemUI surface identity into `activeWindow` when a SystemUI
   * surface owns focus (issue #6078). Returns `true` when the overlay was
   * detected and applied — the caller then short-circuits the rest of
   * attribution. A no-op (returns `false`) when there is no `activeWindow` to
   * annotate or no focused SystemUI surface.
   *
   * Two detection paths (issue #6078). The free primary signal is the captured
   * accessibility `windows[]`: a window flagged `isFocused` that is a SystemUI
   * surface confirms the overlay with no extra device round-trip and — being
   * sampled atomically with the hierarchy — is race-free, so it is trusted as
   * captured. When no window on this API level carries a focus flag but the
   * topmost window is a large SystemUI surface, focus is unconfirmed on the
   * captured tree; that is the adb `mCurrentFocus` fallback.
   *
   * The fallback's focus read is not atomic with the hierarchy capture, so a
   * shade transition in that interval can pair a stale hierarchy with the wrong
   * attribution — e.g. a shade that closes leaves a stale shade tree stamped with
   * the occluded app's id (issue #6091). The fallback therefore recaptures the
   * hierarchy and re-classifies against the fresh tree so the published tree and
   * the overlay attribution are drawn from the same post-fallback moment. When a
   * caller already recaptured the tree (the #6088 back-stack path), it passes
   * `skipRecapture` so the fallback confirms focus directly against that fresh
   * tree instead of recapturing twice.
   */
  private async applyFocusedSystemUiOverlay(
    result: ObserveResult,
    signal?: AbortSignal,
    skipRecapture: boolean = false,
  ): Promise<boolean> {
    // Android-only: `com.android.systemui`, the notification shade, and the
    // `dumpsys window` fallback are Android concepts. iOS reuses the same
    // `windows[]` shape, so without this guard an iOS window carrying
    // `type === TYPE_SYSTEM` could stamp an Android package onto an iOS result.
    if (this.device.platform !== "android") {
      return false;
    }
    const activeWindow = result.activeWindow;
    if (activeWindow === undefined) {
      return false;
    }
    const signalKind = classifyFocusedSystemUiWindow(result.viewHierarchy);
    if (signalKind === "none") {
      return false;
    }
    if (signalKind === "focused") {
      // Primary, race-free signal: mirror immediately, no recapture.
      this.mirrorFocusedSystemUiOverlay(result, activeWindow);
      return true;
    }
    // `topmost-suspect`: the non-atomic adb fallback path (#6091).
    return this.applyFallbackSystemUiOverlay(result, activeWindow, skipRecapture, signal);
  }

  /**
   * Resolve the adb `mCurrentFocus` fallback for a topmost SystemUI suspect
   * (issue #6091). The focus read post-dates the captured tree, so — unless the
   * caller already recaptured — recapture the hierarchy first and re-classify
   * against the fresh tree, then confirm focus against that same tree. This keeps
   * the published hierarchy and the overlay attribution from the same moment: a
   * shade that closed in the interval reclassifies to `none` (fresh app tree,
   * no overlay), and a shade genuinely up is mirrored against the fresh shade
   * tree. When the recapture is unavailable (or skipped), fall back to the
   * single focus read against the tree in hand — no worse than pre-#6091.
   */
  private async applyFallbackSystemUiOverlay(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    skipRecapture: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (skipRecapture) {
      // The back-stack path already recaptured and re-correlated the tree; confirm
      // focus directly against it rather than recapturing (and re-correlating) twice.
      return this.confirmFallbackOverlayFocus(result, activeWindow, signal);
    }
    return this.resolveFallbackOverlayWithRecapture(result, activeWindow, signal);
  }

  /**
   * Confirm the adb `mCurrentFocus` overlay against the tree in hand (no
   * recapture): mirror on confirmation, no-op otherwise (issue #6078).
   */
  private async confirmFallbackOverlayFocus(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.deviceStateCollector.collectFocusedSystemUiSurface(signal))) {
      return false;
    }
    this.mirrorFocusedSystemUiOverlay(result, activeWindow);
    return true;
  }

  /**
   * Recapture, re-correlate, then resolve the SystemUI overlay from the fresh
   * tree (issues #6091, #6108). The recapture replaces the tree AND re-correlates
   * `activeWindow` to it (#6108), so both branches below draw the published tree
   * and its attribution from the same post-recapture moment. A `topmost-suspect`
   * fresh tree still needs the adb `mCurrentFocus` read; when that read disagrees
   * with the accepted suspect tree — the shade closed while the dumpsys ran
   * (#6091 gap 2) — one bounded re-capture is taken to converge on a coherent
   * (tree, attribution) rather than pairing this suspect tree with the app
   * beneath it. When the re-capture keeps producing a fresh suspect while the
   * focus read keeps naming an app (a stale window list over a collapsed shade),
   * the adb ground truth wins and no overlay is mirrored — no over-attribution.
   */
  private async resolveFallbackOverlayWithRecapture(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    signal?: AbortSignal,
    retriesLeft: number = 1,
  ): Promise<boolean> {
    if (!(await this.recaptureHierarchyForSystemUiOverlay(result, signal))) {
      // Recapture unavailable: single focus read against the tree in hand — no
      // worse than pre-#6091.
      return this.confirmFallbackOverlayFocus(result, activeWindow, signal);
    }
    // The recapture re-correlated `result.activeWindow` to the fresh tree (#6108).
    const recorrelated = result.activeWindow ?? activeWindow;
    const freshSignal = classifyFocusedSystemUiWindow(result.viewHierarchy);
    if (freshSignal === "none") {
      // The shade closed: the fresh tree is the underlying app and
      // `result.activeWindow` has been re-derived to name it — no overlay.
      return false;
    }
    if (freshSignal === "focused") {
      this.mirrorFocusedSystemUiOverlay(result, recorrelated);
      return true;
    }
    // `topmost-suspect` on the fresh tree: confirm focus against it.
    if (await this.deviceStateCollector.collectFocusedSystemUiSurface(signal)) {
      this.mirrorFocusedSystemUiOverlay(result, recorrelated);
      return true;
    }
    // Disagreement: the accepted tree is a fresh SystemUI suspect but the focus
    // read names an app — the shade closed during the dumpsys (#6091 gap 2). Take
    // one bounded re-capture to converge on a coherent (tree, attribution) rather
    // than publishing this suspect tree stamped with the app beneath it.
    if (retriesLeft > 0) {
      return this.resolveFallbackOverlayWithRecapture(
        result,
        recorrelated,
        signal,
        retriesLeft - 1,
      );
    }
    // Still a fresh suspect while the focus read keeps naming an app: the adb
    // ground truth is authoritative for focus, so no overlay is mirrored. The
    // published tree is the re-correlated fresh tree, not the original stale one.
    return false;
  }

  private mirrorFocusedSystemUiOverlay(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
  ): void {
    const overlay = {
      ...activeWindow,
      appId: SYSTEM_UI_PACKAGE,
      activityName: "",
      systemOverlay: true,
    };
    // The occluded-app `type` (e.g. a notification-permission dialog) does not
    // describe the shade that is now on top; drop it while the overlay is up.
    delete overlay.type;
    result.activeWindow = overlay;
  }

  /**
   * Recapture the hierarchy for the SystemUI-overlay fallback so the published
   * tree and the overlay attribution are sampled together (issue #6091). Unlike
   * the back-stack recapture there is no expected package to match — the goal is
   * simply a tree newer than the one captured before the focus read. Returns
   * `true` when a usable fresh tree replaced the original; on any failure the
   * original hierarchy is preserved and the caller falls back to the single
   * focus read.
   */
  async recaptureHierarchyForSystemUiOverlay(
    result: ObserveResult,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const initialTimestamp = this.resolveObservationTimestampMs(result);
    if (initialTimestamp === undefined) {
      logger.debug(
        "[OBSERVE] Skipping SystemUI-overlay recapture without a device capture timestamp",
      );
      return false;
    }
    // `minTimestamp` is interpreted by the device hierarchy source. It is
    // present only after the guard above proved a hierarchy-owned device stamp.
    const minTimestamp = initialTimestamp + 1;
    let hierarchy: ObserveResult["viewHierarchy"];
    try {
      // `minTimestamp` rejects the cached (initial) tree; skipping the fresh wait
      // goes straight to the sync that produces the newer one (#6099).
      hierarchy = await this.viewHierarchy.getViewHierarchy(
        undefined,
        new NoOpPerformanceTracker(),
        true,
        minTimestamp,
        signal,
      );
    } catch (error) {
      logger.debug(
        `[OBSERVE] SystemUI-overlay recapture failed; preserving original hierarchy: ${error}`,
      );
      return false;
    }
    if (
      !hierarchy ||
      !hasUsableHierarchy(hierarchy) ||
      hierarchy.fresh !== true ||
      !this.platformValidator.validate(this.device.platform, hierarchy).valid
    ) {
      return false;
    }
    this.applyRecapturedHierarchy(result, hierarchy);
    // `deviceLock` was sampled before the original capture (collectAllData), so a
    // keyguard that appeared during this recapture would otherwise be published
    // as unlocked against the fresh (keyguard) tree — the #6100 seam, on the
    // overlay recapture path. Clear first so a failed re-read yields "unknown"
    // rather than the stale value, then re-read paired with the replacement tree.
    delete result.deviceLock;
    await this.deviceStateCollector.collectDeviceLock(result, signal);
    // `backStack` was sampled with the original tree (collectAllData). A recapture
    // that replaced the tree — including the bounded gap-2 second recapture that
    // lands on a same-package activity B — leaves `backStack` describing the
    // pre-recapture screen A. A stale back stack that still agrees with a stale
    // window would let `reconcileAgainstBackStack` skip confirmation and record
    // A's depth/task against B's current node (#6108, bug 3). It cannot be
    // confidently re-correlated to the replacement here (no expected identity to
    // confirm against, and a fresh read would carry the same post-recapture lag),
    // so drop it to unknown rather than publish it against the new tree.
    delete result.backStack;
    // `activeWindow` (appId/activityName/layoutSeqSum) was likewise sampled with
    // the original tree. Re-correlate it against the replacement so a stale
    // non-zero `layoutSeqSum` does not skew the next tap-effect comparison and a
    // possibly-lagged activity is not stamped onto the fresh tree — the #6108
    // re-correlation, paired with the tree.
    this.recorrelateActiveWindowToRecapture(result, hierarchy);
    return true;
  }

  /**
   * Re-correlate `activeWindow` after the SystemUI-overlay recapture replaced the
   * tree (issue #6108). The pre-recapture identity (appId/activityName/
   * layoutSeqSum) was sampled with the original tree; leaving it in place pairs a
   * fresh hierarchy with stale attribution — a same-app A->B deep link during the
   * recapture would publish B's tree with A's activityName (gap 3), and a stale
   * non-zero `layoutSeqSum` would skew the next tap-effect comparison (gap 1).
   * Re-derive from the replacement tree — the one source guaranteed to describe
   * the published hierarchy. When the fresh tree names no owner the earlier
   * identity is left untouched (there is nothing better to correlate against).
   */
  recorrelateActiveWindowToRecapture(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    if (result.activeWindow === undefined) {
      return;
    }
    const rederived = this.deriveActiveWindowFromHierarchy(hierarchy);
    if (rederived === undefined) {
      return;
    }
    // A notification-permission dialog is a property of the tree, not the prior
    // window, so re-derive it from the replacement's own detection flag.
    if (result.notificationPermissionDetected) {
      rederived.type = "notification_permission_dialog";
    }
    result.activeWindow = rederived;
  }

  /**
   * Derive an `activeWindow` identity from a recaptured hierarchy (issue #6108).
   * Only the PACKAGE is trusted: after an overlay recapture a state transition is
   * known to have occurred, and CtrlProxy's `foregroundActivity` can lag behind
   * the tree it is attached to (the metadata lag #5972 documents — CtrlProxy can
   * retain a prior `foregroundActivity` after a window transition), so a same-app
   * A->B transition can leave `foregroundActivity`
   * naming A while the fresh tree describes B. Stamping that possibly-lagged
   * activity onto the replacement tree would publish a confidently-wrong
   * `activityName` (#6108, bug 2), so the activity is marked UNKNOWN here; when a
   * back stack is available it is confirmed through the #6088 recapture-and-match
   * machinery instead. `layoutSeqSum` is the accessibility zero — the correlated
   * window sequence for the replacement tree is not known here, and zero is the
   * established "nothing to compare" sentinel (#6070) rather than the stale
   * pre-recapture value. Prefer the tree package; fall back to the
   * `foregroundActivity` package; `undefined` when the tree names no owner.
   */
  private deriveActiveWindowFromHierarchy(
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): NonNullable<ObserveResult["activeWindow"]> | undefined {
    const appId = hierarchy.packageName ?? hierarchy.foregroundActivity?.split("/")[0];
    if (!appId) {
      return undefined;
    }
    return { appId, activityName: "", layoutSeqSum: 0 };
  }

  async recaptureHierarchyForBackStackAttribution(
    result: ObserveResult,
    expected: { packageName: string; activityName: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const initialTimestamp = this.resolveObservationTimestampMs(result);
    if (initialTimestamp === undefined) {
      logger.debug("[OBSERVE] Skipping back-stack recapture without a device capture timestamp");
      return false;
    }
    // See the overlay recapture path above: the guard ensures this is a
    // device-side floor, never a substituted host timestamp.
    const minTimestamp = initialTimestamp + 1;
    let hierarchy: ObserveResult["viewHierarchy"];
    try {
      // `minTimestamp` rejects the cached (initial) tree; skipping the fresh
      // wait goes straight to the sync that produces the newer one, so a static
      // screen (nothing pushed) does not burn the full WebSocket wait (#6099).
      // Android-only semantics: the iOS delegate serves its stale fallback for
      // skip + unmet minTimestamp, but this recapture is unreachable there (it
      // requires an adb-sourced back stack).
      hierarchy = await this.viewHierarchy.getViewHierarchy(
        undefined,
        new NoOpPerformanceTracker(),
        true,
        minTimestamp,
        signal,
      );
    } catch (error) {
      logger.debug(
        `[OBSERVE] Attribution recapture failed; preserving original hierarchy: ${error}`,
      );
      return false;
    }
    if (!this.isUsableAttributionRecapture(hierarchy, expected)) {
      return false;
    }

    // A failed back-stack query is represented as a partial result rather than
    // thrown. Keep it isolated from the original capture so a stale first read
    // cannot be mistaken for confirmation of this fresh hierarchy.
    const recapturedState: ObserveResult = { ...result, backStack: undefined, errors: undefined };
    await this.deviceStateCollector.collectBackStack(
      recapturedState,
      new NoOpPerformanceTracker(),
      signal,
    );
    const confirmed = resolveBackStackActivityAttribution(recapturedState);
    if (!this.matchesExpectedBackStackAttribution(confirmed, expected)) {
      // A failed confirming back-stack read retracts freshness; surface its
      // cause on the published result so the retraction is diagnosable rather
      // than an unexplained "could not reconcile" (#6088).
      for (const error of recapturedState.errors ?? []) {
        appendObserveError(result, error);
      }
      return false;
    }

    this.applyRecapturedHierarchy(result, hierarchy);
    result.backStack = recapturedState.backStack;
    return true;
  }

  /**
   * Side samples taken before an accepted recapture must not be published
   * against the replacement tree (#6100). The lock state was collected before
   * the original capture, so a keyguard that appeared mid-recapture would be
   * published as unlocked; it is re-read, and cleared first so a failed re-read
   * yields "unknown" rather than the earlier wrong value. On the bootstrap path
   * `layoutSeqSum` came from a window read taken before the recapture, so a
   * same-activity layout pass that completed during it would make the next
   * tap-effect comparison misreport a change; it is re-read too. The two reads
   * are independent adb calls and run together.
   */
  private async refreshRecaptureSideSamples(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    expected: { packageName: string; activityName: string },
    bootstrapAttribution: boolean,
    options: { signal?: AbortSignal; readOnly?: boolean } = {},
  ): Promise<NonNullable<ObserveResult["activeWindow"]>> {
    const { signal, readOnly = false } = options;
    delete result.deviceLock;
    const [confirmedWindow] = await Promise.all([
      // Elsewhere `layoutSeqSum` is the accessibility-path zero: nothing to refresh.
      bootstrapAttribution
        ? this.refreshBootstrapLayoutSeqSum(result, activeWindow, expected, { readOnly })
        : Promise.resolve(activeWindow),
      this.deviceStateCollector.collectDeviceLock(result, signal),
    ]);
    return confirmedWindow;
  }

  /**
   * Re-read the bootstrap window after an accepted recapture and pair the tree
   * with its layout sequence. The production `Window.getActive` does not throw
   * on failure; it returns a zero-sentinel record, so a missing OR zero sequence
   * keeps the earlier correlated value rather than the sentinel (#6070), and the
   * re-read's error is surfaced on the result so the kept value is diagnosable.
   * A sequence is adopted only when the re-read names the confirmed identity: a
   * navigation landing between the confirmation and this read would otherwise
   * graft the next screen's sequence onto the confirmed tree.
   */
  private async refreshBootstrapLayoutSeqSum(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    expected: { packageName: string; activityName: string },
    options: { readOnly?: boolean } = {},
  ): Promise<NonNullable<ObserveResult["activeWindow"]>> {
    const { readOnly = false } = options;
    const refreshed: ObserveResult = { ...result, activeWindow: undefined, errors: undefined };
    await this.deviceStateCollector.collectActiveWindow(refreshed, readOnly);
    for (const error of refreshed.errors ?? []) {
      appendObserveError(result, error);
    }
    const reread = refreshed.activeWindow;
    if (!reread?.layoutSeqSum) {
      return activeWindow;
    }
    // `dumpsys window` reports an in-package activity in shorthand (`pkg/.Foo`),
    // which the Window parser keeps, while the back stack expands it to
    // `pkg.Foo`; compare the expanded form.
    const rereadActivity = reread.activityName.startsWith(".")
      ? reread.appId + reread.activityName
      : reread.activityName;
    const sameIdentity =
      reread.appId === expected.packageName && rereadActivity === expected.activityName;
    return sameIdentity ? { ...activeWindow, layoutSeqSum: reread.layoutSeqSum } : activeWindow;
  }

  private isUsableAttributionRecapture(
    hierarchy: ObserveResult["viewHierarchy"],
    expected: { packageName: string; activityName: string },
  ): hierarchy is NonNullable<ObserveResult["viewHierarchy"]> {
    if (!hierarchy) {
      return false;
    }
    return (
      hasUsableHierarchy(hierarchy) &&
      hierarchy.fresh === true &&
      hierarchy.packageName === expected.packageName &&
      this.platformValidator.validate(this.device.platform, hierarchy).valid
    );
  }

  private matchesExpectedBackStackAttribution(
    actual: { packageName: string; activityName: string } | undefined,
    expected: { packageName: string; activityName: string },
  ): boolean {
    return (
      actual?.packageName === expected.packageName && actual.activityName === expected.activityName
    );
  }

  applyRecapturedHierarchy(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    result.viewHierarchy = hierarchy;
    result.updatedAt = hierarchy.updatedAt ?? result.updatedAt;
    if (hierarchy.screenWidth && hierarchy.screenHeight) {
      result.screenSize = { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
    }
    if (this.device.platform === "ios") {
      result.screenSize = this.extractScreenSizeFromHierarchy(hierarchy) ?? result.screenSize;
      result.rotation = resolveIosObserveRotation(hierarchy.rotation, result.screenSize);
    } else {
      result.rotation = hierarchy.rotation;
    }
    result.systemInsets = hierarchy.systemInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    result.insets = hierarchy.insets ?? {
      available: false,
      source: "unavailable",
      units: "unknown",
    };
    result.wakefulness = hierarchy.wakefulness ?? result.wakefulness;
    if (hierarchy.wakefulness) {
      result.wakefulnessSource = "hierarchy";
    }
    result.intentChooserDetected = hierarchy.intentChooserDetected;
    result.notificationPermissionDetected = hierarchy.notificationPermissionDetected;
    result.focusedElement = this.viewHierarchy.findFocusedElement(hierarchy) ?? undefined;
    result.accessibilityFocusedElement =
      this.viewHierarchy.findAccessibilityFocusedElement(hierarchy) ?? undefined;
  }
}
