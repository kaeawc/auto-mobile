import { logger } from "../../../utils/logger";
import { errorMessage as describeError } from "../../../utils/describeUnknownError";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type {
  BootedDevice,
  ObserveResult,
  ScreenIdentity,
  ViewHierarchyResult,
} from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type {
  ViewHierarchy as ViewHierarchyInterface,
  HierarchyReadOptions,
} from "../interfaces/ViewHierarchy";
import {
  isAccessibilityViewClass,
  resolveBackStackActivityAttribution,
} from "../ActiveWindowAttribution";
import { deriveAndroidScreenIdentity } from "../android/AndroidScreenIdentity";
import { displayTransitions } from "../DisplayTransition";
import { resolveTargetDisplay } from "../DisplaySelection";
import type { DeviceStateCollectorPort, HierarchyCollectorPort } from "./collectorPorts";

export interface PlatformCollectionContext {
  result: ObserveResult;
  queryOptions: ViewHierarchyQueryOptions | undefined;
  perf: PerformanceTracker;
  skipWaitForFresh: boolean;
  minTimestamp: number;
  signal: AbortSignal | undefined;
  readOnly: boolean;
  capturedHierarchy: ViewHierarchyResult | undefined;
  readOptions: number | HierarchyReadOptions | undefined;
}

export interface AndroidCollectionContext extends PlatformCollectionContext {
  skipBackStack: boolean;
  displayId: number;
}

/** Platform-specific hierarchy-plus-device-state collection for Android observations. */
export interface AndroidObservationCollector {
  collect(context: AndroidCollectionContext): Promise<void>;
}

export interface AndroidObservationCollectorDeps {
  hierarchyCollector: () => HierarchyCollectorPort;
  deviceStateCollector: () => DeviceStateCollectorPort;
  viewHierarchy: () => ViewHierarchyInterface;
  device: () => BootedDevice;
}

export function scopeActiveWindowToBackStack(result: ObserveResult): void {
  if ((result.backStack?.displayCount ?? 0) > 1 && result.activeWindow) {
    const scopedActivity = resolveBackStackActivityAttribution(result);
    if (scopedActivity) {
      result.activeWindow = {
        ...result.activeWindow,
        appId: scopedActivity.packageName,
        activityName: scopedActivity.activityName,
      };
    }
  }
}

export class DefaultAndroidObservationCollector implements AndroidObservationCollector {
  constructor(private readonly deps: AndroidObservationCollectorDeps) {}

  async collect(context: AndroidCollectionContext): Promise<void> {
    const {
      result,
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      readOnly,
      capturedHierarchy,
      readOptions,
    } = context;
    perf.serial("phase1_hierarchy");
    await this.deps.hierarchyCollector().collect(result, {
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      readOnly,
      capturedHierarchy,
      readOptions,
    });
    perf.end();

    // Prefer accessibility-service-supplied metadata for screen/insets/rotation/wakefulness/foreground.
    const hierarchy = result.viewHierarchy;
    if (hierarchy?.screenWidth && hierarchy?.screenHeight) {
      result.screenSize = { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
      this.applyHierarchyDeviceMetadata(result, hierarchy);
      const parallelTasks = this.startDeviceStateTasks(context, !hierarchy.wakefulness);
      if (parallelTasks.length > 0) {
        await Promise.all(parallelTasks);
      }
      logger.debug("[OBSERVE] Using device metadata from accessibility service");
    } else {
      this.applyKnownPanelScreenSize(result);
      await Promise.all(this.startDeviceStateTasks(context, true));
    }

    // CtrlProxy is installed lazily. Preserve active-window attribution for
    // that bootstrap interval only; once CtrlProxy supplied an app/activity
    // or hierarchy package, never make the legacy Window query.
    if (!result.activeWindow) {
      await this.deps.deviceStateCollector().collectActiveWindow(result, readOnly);
    }

    this.backfillActiveWindowPackage(result);

    // CtrlProxy pairs the captured root package with the last window-state
    // class it heard, which may belong to another display. The back-stack
    // dump already sampled above scopes its resumed activity to the logical
    // display mapped from `result.display.key`. Only use it when
    // the activity belongs to the captured hierarchy's app.
    scopeActiveWindowToBackStack(result);
    await this.applyAndroidScreenIdentity(result);

    if (result.notificationPermissionDetected && result.activeWindow) {
      result.activeWindow.type = "notification_permission_dialog";
    }
  }

  /** Screen size, rotation, insets and foreground activity the accessibility service reported. */
  private applyHierarchyDeviceMetadata(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    if (hierarchy.rotation !== undefined) {
      result.rotation = hierarchy.rotation;
    }
    if (hierarchy.systemInsets) {
      result.systemInsets = hierarchy.systemInsets;
    }
    if (hierarchy.insets) {
      result.insets = hierarchy.insets;
    }
    if (hierarchy.foregroundActivity && !isAccessibilityViewClass(hierarchy.foregroundActivity)) {
      this.applyAndroidForegroundActivity(result, hierarchy.foregroundActivity);
    }
  }

  /**
   * Start the concurrent device-state reads (wakefulness unless the hierarchy supplied it, device
   * lock, back stack) and return their promises in that order for the caller to await once.
   */
  private startDeviceStateTasks(
    { result, perf, signal, skipBackStack, displayId }: AndroidCollectionContext,
    collectWakefulness: boolean,
  ): Promise<void>[] {
    const tasks: Promise<void>[] = [];
    if (collectWakefulness) {
      tasks.push(
        perf.track("wakefulness", () =>
          this.deps.deviceStateCollector().collectWakefulness(result, signal),
        ),
      );
    } else {
      result.wakefulness = result.viewHierarchy?.wakefulness;
      result.wakefulnessSource = "hierarchy";
    }
    tasks.push(
      perf.track("deviceLock", () =>
        this.deps.deviceStateCollector().collectDeviceLock(result, signal),
      ),
    );
    if (!skipBackStack) {
      // Fork: collectBackStack's own perf.track() calls run concurrently with the other tracks
      // on this same Promise.all. A shared tracker's cursor is ambient mutable state, so without
      // a fork, block-open/close activity deep in the back stack collector could misparent (or
      // wrongly pop) the sibling tracks' timings (issue #6706).
      tasks.push(
        perf.track("backStack", () =>
          this.deps.deviceStateCollector().collectBackStack(result, perf.fork(), signal, displayId),
        ),
      );
    }
    return tasks;
  }

  /** Backfill the active window's package from the hierarchy when the legacy query had none. */
  private backfillActiveWindowPackage(result: ObserveResult): void {
    // Preserve package attribution when the accessibility service did not
    // provide a usable activity and the legacy window query also failed.
    // `!result.activeWindow?.appId` (not `!result.activeWindow`): the legacy
    // query's own failure sentinel is a TRUTHY object with an empty appId
    // (`Window.getActive`'s catch branch), which would otherwise short-circuit
    // this fallback and leave a readable, package-attributed capture wrongly
    // reporting no foreground window (issue #6220 false-positive).
    if (result.viewHierarchy?.packageName && !result.activeWindow?.appId) {
      // Backfill ONLY the missing appId. The legacy query's failure sentinel
      // is a truthy object that still carries a real `layoutSeqSum` (summed
      // independently of package/activity parse success) and often an
      // `activityName`/`type`/`systemOverlay`; replacing the whole object
      // would zero `layoutSeqSum` and blank those fields, masking
      // screen-change detection (issue #6320 regression of #6239). Only the
      // genuinely-absent case constructs a fresh object with empty defaults.
      result.activeWindow = result.activeWindow
        ? { ...result.activeWindow, appId: result.viewHierarchy.packageName }
        : {
            appId: result.viewHierarchy.packageName,
            activityName: "",
            layoutSeqSum: 0,
          };
    }
  }

  /**
   * Name the Android screen when the activity does not (single-activity Compose apps): the SDK's
   * navigation route for the captured app, else the foreground app window's pane title. Left unset
   * when neither exists, so consumers fall back to the activity.
   */
  private async applyAndroidScreenIdentity(result: ObserveResult): Promise<void> {
    const packageName = result.viewHierarchy?.packageName;
    if (!packageName) {
      return;
    }
    let sdkScreenIdentity: ScreenIdentity | undefined;
    try {
      sdkScreenIdentity = await this.deps.viewHierarchy().getScreenIdentity?.(packageName);
    } catch (error) {
      // The SDK route is optional; the pane-title fallback still applies without it.
      logger.debug(
        `[Android] SDK screen identity read failed; using hierarchy identity: ${describeError(error)}`,
      );
    }
    const identity = deriveAndroidScreenIdentity(result.viewHierarchy, sdkScreenIdentity);
    if (identity) {
      result.screenIdentity = identity;
    }
  }

  private applyAndroidForegroundActivity(result: ObserveResult, foregroundActivity: string): void {
    const parts = foregroundActivity.split("/");
    const packageName = parts[0];
    const activityName = parts[1]?.startsWith(".") ? packageName + parts[1] : parts[1] || "";
    result.activeWindow = {
      appId: packageName,
      activityName,
      layoutSeqSum: 0,
    };
  }

  /**
   * Called when the accessibility service gave no screen info. A degraded read still knows the panel's physical size from the
   * display inventory, the same source the `display: "all"` fallback uses. Without
   * it the 0x0 placeholder breaks screenshot raster geometry on every read.
   */
  private applyKnownPanelScreenSize(result: ObserveResult): void {
    logger.warn("[OBSERVE] No screen info from accessibility service - check if APK is updated");
    if (result.screenSize.width > 0 && result.screenSize.height > 0) {
      return;
    }
    // "active" never throws on a degraded read, unlike a pin or explicit panel request.
    const panel = resolveTargetDisplay(this.deps.device().displays, "active", {
      focusedPanelKey: displayTransitions.observedPanel(this.deps.device().deviceId)?.key,
    });
    if (panel.sizePx.width > 0 && panel.sizePx.height > 0) {
      result.screenSize = { ...panel.sizePx };
    }
  }
}
