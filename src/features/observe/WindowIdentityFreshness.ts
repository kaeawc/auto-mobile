import type { ObserveResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import { PROTOTYPE_WINDOW_TYPE, isOwnPrototypeFocused } from "./ownWindowFocus";
import { maxObservationAgeMs } from "./observationFreshness";
import {
  SYSTEM_UI_WINDOW_PACKAGES,
  type PostCaptureForegroundIdentity,
} from "./ActiveWindowAttribution";
import type { DeviceStateCollector } from "./collectors/DeviceStateCollector";

function isStatusBarOnlyCandidate(
  hierarchy: ObserveResult["viewHierarchy"],
  foreground: string | undefined,
): foreground is string {
  const observed = hierarchy?.packageName;
  return (
    foreground !== undefined &&
    !SYSTEM_UI_WINDOW_PACKAGES.has(foreground) &&
    (observed === undefined
      ? hierarchy?.ctrlProxyIncomplete === true
      : SYSTEM_UI_WINDOW_PACKAGES.has(observed))
  );
}

/**
 * A focused window that legitimately differs from the resumed activity: a
 * system-UI panel (a window, not an ActivityRecord), or the product's own
 * focusable prototype, which owns focus while the app stays resumed behind it
 * (issue #10000). Neither is a stale wrong-window capture. The prototype case is
 * judged from the capture's own windows, so it only counts when the capture is
 * current (`ownWindowEvidenceCurrent`): a stale capture taken while the prototype
 * had focus says nothing about the device now.
 */
function isExpectedFocusDivergence(
  hierarchy: ObserveResult["viewHierarchy"],
  observed: string,
  foreground: string,
  ownWindowEvidenceCurrent: boolean,
): boolean {
  return (
    SYSTEM_UI_WINDOW_PACKAGES.has(observed) ||
    SYSTEM_UI_WINDOW_PACKAGES.has(foreground) ||
    (ownWindowEvidenceCurrent && isOwnPrototypeFocused(hierarchy))
  );
}

export function isStatusBarOnlyHierarchy(result: ObserveResult): boolean {
  const statusBarHeight = result.systemInsets.top;
  const root = result.viewHierarchy?.hierarchy.node;
  if (statusBarHeight <= 0 || !root) {
    return false;
  }

  let hasBounds = false;
  const nodes = Array.isArray(root) ? [...root] : [root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) {
      continue;
    }
    if (node.bounds) {
      hasBounds = true;
      if (node.bounds.bottom > statusBarHeight) {
        return false;
      }
    }
    const children = node.node;
    if (children) {
      nodes.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  return hasBounds;
}

/**
 * The status-bar-only verdict inputs (issue #6151): whether the service itself
 * reported the focused window as unreadable, and the device API level that
 * decides whether that can be Android 14+ data-sensitive withholding.
 */
function describeStatusBarOnlyCapture(
  hierarchy: ObserveResult["viewHierarchy"],
  foreground: string,
): {
  foreground: string;
  ctrlProxyIncomplete: boolean;
  sdkInt: number | undefined;
  accessibilityTool: boolean | undefined;
} {
  return {
    foreground,
    ctrlProxyIncomplete: hierarchy?.ctrlProxyIncomplete === true,
    sdkInt: hierarchy?.sdkInt,
    accessibilityTool: hierarchy?.accessibilityTool,
  };
}

/** The post-capture evidence and request floor a window-identity mismatch is confirmed against. */
export interface WindowIdentityMismatchCheck {
  postCaptureForeground: PostCaptureForegroundIdentity;
  getConfirmedFrameworkErrorDialog: () => Promise<boolean>;
  minTimestamp: number;
  signal?: AbortSignal;
}

export interface WindowIdentityFreshnessResolver {
  resolveWindowIdentityMismatch(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    check: WindowIdentityMismatchCheck,
  ): Promise<{ observed: string; foreground: string } | undefined>;
  attributeFocusedOwnWindowToForeground(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    minTimestamp: number,
  ): Promise<void>;
  resolveStatusBarOnlyHierarchy(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof describeStatusBarOnlyCapture> | undefined>;
  confirmForegroundIdentity(
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  resolveHostReceivedAtMs(result: ObserveResult): number | undefined;
}

interface WindowIdentityFreshnessDependencies {
  deviceStateCollector: () => Pick<DeviceStateCollector, "collectForegroundIdentity">;
  timer: () => Timer;
  resolveObservationTimestampMs: (result: ObserveResult) => number | undefined;
}

export class DefaultWindowIdentityFreshnessResolver implements WindowIdentityFreshnessResolver {
  constructor(private readonly dependencies: WindowIdentityFreshnessDependencies) {}

  private get deviceStateCollector() {
    return this.dependencies.deviceStateCollector();
  }
  private get timer() {
    return this.dependencies.timer();
  }
  private get resolveObservationTimestampMs() {
    return this.dependencies.resolveObservationTimestampMs;
  }

  /**
   * Compare the app the observed hierarchy was captured from against the
   * device's ground-truth resumed activity (issue #5867). Returns a mismatch
   * descriptor only when both are known and their package names differ — the
   * cross-app stale-window case. A same-package activity change, an unknown
   * ground truth, or an unknown observed window all yield `undefined` (no
   * comparison, no false alarm). iOS never supplies a ground truth and so is
   * always `undefined`.
   *
   * A system-UI window (`com.android.systemui`) on either side is excluded: when
   * the notification shade, quick settings, volume, or power dialog takes
   * accessibility focus, the a11y active window is systemui while the resumed
   * activity behind the panel is the underlying app — a legitimate divergence,
   * not a stale capture. Excluding it keeps first-class shade workflows (the
   * `systemTray` tool) from misfiring while still catching the app-vs-app case
   * the issue reported.
   *
   * The parallel sample is taken before hierarchy capture, so during an A→B app
   * transition it can lag the (valid, newer) captured window and read a spurious
   * mismatch. A detected mismatch is therefore confirmed against a second read
   * taken now — after capture: freshness is retracted only when the device is
   * *stably* on a different app (both samples agree, and still differ from the
   * observed window). The extra dumpsys runs only on the rare mismatch path.
   *
   * The observed package is `viewHierarchy.packageName` — the package of the
   * tree actually being validated — in preference to `activeWindow.appId`. The
   * latter is derived from the accessibility `foregroundActivity`, which with an
   * active soft keyboard can be the IME root's package while the captured
   * hierarchy is the underlying app; comparing the IME package would falsely
   * retract a valid application hierarchy. Falls back to `activeWindow.appId`
   * only when the hierarchy carries no package (e.g. the bootstrap path, whose
   * appId is itself a resumed-activity read in the same domain as the ground truth).
   */
  async resolveWindowIdentityMismatch(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    {
      postCaptureForeground,
      getConfirmedFrameworkErrorDialog,
      minTimestamp,
      signal,
    }: WindowIdentityMismatchCheck,
  ): Promise<{ observed: string; foreground: string } | undefined> {
    const foreground = await foregroundIdentity;
    const observed = result.viewHierarchy?.packageName ?? result.activeWindow?.appId;
    if (!foreground || !observed) {
      return undefined;
    }
    if (
      isExpectedFocusDivergence(
        result.viewHierarchy,
        observed,
        foreground,
        this.isOwnWindowEvidenceCurrent(result, minTimestamp),
      )
    ) {
      return undefined;
    }
    const confirmed = await this.resolvePostCaptureForegroundIdentity(
      foreground,
      observed,
      postCaptureForeground,
      signal,
    );
    if (!confirmed || confirmed !== foreground || confirmed === observed) {
      return undefined;
    }
    if (await getConfirmedFrameworkErrorDialog()) {
      return undefined;
    }
    return { observed, foreground };
  }

  /**
   * Whether the capture is recent enough for its own "prototype holds focus" claim
   * to describe the device now. That claim is read from the very capture being
   * validated, so it cannot vouch for itself: a stale capture taken while a
   * text-field prototype had focus would otherwise be accepted as fresh and
   * relabelled with whatever app is in front today. The independent evidence is
   * the capture's own device stamp against the request (`minTimestamp`) and the
   * freshness age budget; with no stamp the claim cannot be dated and is not
   * trusted.
   */
  private isOwnWindowEvidenceCurrent(result: ObserveResult, minTimestamp: number): boolean {
    const stamp = this.resolveObservationTimestampMs(result);
    if (stamp === undefined || (minTimestamp > 0 && stamp < minTimestamp)) {
      return false;
    }
    const ageBasis = this.resolveHostReceivedAtMs(result) ?? stamp;
    return this.timer.now() - ageBasis <= maxObservationAgeMs();
  }

  /**
   * While CtrlProxy's own prototype holds window focus, name the app
   * behind it as the active app (issue #10000) and keep the prototype's presence
   * visible through `activeWindow.type`. The device-confirmed resumed app is the
   * attribution source; with no ground truth, or a SystemUI surface on top, the
   * window is left as captured.
   */
  async attributeFocusedOwnWindowToForeground(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    minTimestamp: number,
  ): Promise<void> {
    const activeWindow = result.activeWindow;
    if (
      activeWindow?.appId !== CTRL_PROXY_PACKAGE ||
      !isOwnPrototypeFocused(result.viewHierarchy) ||
      !this.isOwnWindowEvidenceCurrent(result, minTimestamp)
    ) {
      return;
    }
    const foreground = await foregroundIdentity;
    if (
      !foreground ||
      foreground === CTRL_PROXY_PACKAGE ||
      SYSTEM_UI_WINDOW_PACKAGES.has(foreground)
    ) {
      return;
    }
    result.activeWindow = {
      ...activeWindow,
      appId: foreground,
      type: activeWindow.type ?? PROTOTYPE_WINDOW_TYPE,
    };
  }

  /**
   * Status-bar-only capture gate. The returned `ctrlProxyIncomplete` distinguishes
   * the two device-side causes so the verdict can name the right recovery:
   * a stale window the runner keeps serving (home/relaunch recovers it) versus a
   * focused application window the accessibility service could not read at all
   * (issue #6151 — an accessibility-data-sensitive surface such as a runtime
   * permission dialog or the Settings Wi-Fi picker, which Android 14+ withholds
   * from a service that does not declare `isAccessibilityTool`; only a CtrlProxy
   * update recovers it, and home/relaunch does not).
   */
  async resolveStatusBarOnlyHierarchy(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof describeStatusBarOnlyCapture> | undefined> {
    const foreground = await foregroundIdentity;
    const hierarchy = result.viewHierarchy;

    // Two independent entry conditions, both cheap (no device round-trip):
    //  - package identity: a system-UI or incomplete tree is being served while a
    //    real app is foregrounded (isStatusBarOnlyCandidate); or
    //  - geometry: every extracted node lies within the status-bar strip. This is
    //    the reliable signal after #5976 corrected the reported package to the
    //    focused application — the label then matches the foreground app while the
    //    selected window stays status-bar-only (#5981), silencing the identity
    //    check and leaving the geometry as the only evidence.
    const geometryStatusBarOnly = isStatusBarOnlyHierarchy(result);
    if (!isStatusBarOnlyCandidate(hierarchy, foreground) && !geometryStatusBarOnly) {
      return undefined;
    }
    // A real (non-system) app must be the resumed foreground for this to be a
    // wrong-window capture rather than a legitimate system surface (e.g. an open
    // notification shade owned by com.android.systemui).
    if (foreground === undefined || SYSTEM_UI_WINDOW_PACKAGES.has(foreground)) {
      return undefined;
    }
    // When the tree is geometrically status-bar-only it carries no application
    // content regardless of the package it is labelled with, so the observed/foreground
    // equality that short-circuits resolvePostCaptureForegroundIdentity is exactly the
    // #5981 shape (label corrected to the foreground app) and must not block the gate.
    // Still take the confirming foreground read so a genuine A→B transition reports the
    // settled app. Otherwise (identity-only candidate) confirm the foreground is stably
    // a real app before retracting.
    const confirmed = geometryStatusBarOnly
      ? await this.confirmForegroundIdentity(postCaptureForeground, signal)
      : await this.resolvePostCaptureForegroundIdentity(
          foreground,
          hierarchy?.packageName ?? "",
          postCaptureForeground,
          signal,
        );
    if (
      !confirmed ||
      SYSTEM_UI_WINDOW_PACKAGES.has(confirmed) ||
      !isStatusBarOnlyHierarchy(result)
    ) {
      return undefined;
    }
    return describeStatusBarOnlyCapture(hierarchy, confirmed);
  }

  /**
   * The confirming (post-capture) foreground read, without the observed/foreground
   * equality short-circuit that {@link resolvePostCaptureForegroundIdentity} applies
   * for the window-identity path. The status-bar geometry gate must fire even when the
   * capture is labelled with the foreground app itself (#5981), so equality cannot be a
   * reason to skip confirmation. Reuses an already-sampled read when one exists.
   */
  async confirmForegroundIdentity(
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (postCaptureForeground.sampled) {
      return postCaptureForeground.identity;
    }
    return this.deviceStateCollector.collectForegroundIdentity(signal, {
      displayId: postCaptureForeground.displayId,
    });
  }

  private async resolvePostCaptureForegroundIdentity(
    foreground: string,
    observed: string,
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (postCaptureForeground.sampled) {
      return postCaptureForeground.identity;
    }
    if (foreground === observed) {
      return undefined;
    }
    return this.deviceStateCollector.collectForegroundIdentity(signal, {
      displayId: postCaptureForeground.displayId,
    });
  }

  /**
   * Host-clock-domain receipt time for the observed tree, when the delegate
   * reports one (Android). Used as the age basis so clock skew between a device
   * and the host is not misreported as observation age (issue #5377). Absent on
   * iOS (shares the host clock), where age falls back to the device timestamp.
   */
  resolveHostReceivedAtMs(result: ObserveResult): number | undefined {
    const candidate = result.viewHierarchy?.receivedAt;
    if (typeof candidate === "number" && !Number.isNaN(candidate)) {
      return candidate;
    }
    return undefined;
  }
}
