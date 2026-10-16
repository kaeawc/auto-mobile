import type { BootedDevice, ObserveResult } from "../../models";
import { DaemonState } from "../../daemon/daemonState";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import type { ObserveScreenDependencies } from "./ObserveScreenDependencies";
import type { ObserveScreen } from "./interfaces/ObserveScreen";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import type { BackStack } from "./interfaces/BackStack";
import type { Window } from "./interfaces/Window";
import type { ViewHierarchy } from "./interfaces/ViewHierarchy";
import type { HierarchyPlatformValidator } from "./HierarchyPlatformValidator";
import type { ScreenshotPathProtection } from "./ScreenshotPathProtection";
import { setObserveCacheStore } from "./cache/ObserveCacheRegistry";
import {
  getScreenshotStateStore,
  setScreenshotStateStore,
} from "./screenshot/ScreenshotStateRegistry";
import {
  DefaultObserveScreenshotRecorder,
  type TrackedScreenshotService,
} from "./screenshot/ObserveScreenshotRecorder";
import { HierarchyCollector } from "./collectors/HierarchyCollector";
import { DeviceStateCollector } from "./collectors/DeviceStateCollector";
import { PerformanceAuditor } from "./audits/PerformanceAuditor";
import {
  AccessibilityAuditor,
  resolveObservationScreenshotPath,
} from "./audits/AccessibilityAuditor";
import { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import { DefaultWindowIdentityFreshnessResolver } from "./WindowIdentityFreshness";
import { DefaultActiveWindowAttributionReconciler } from "./ActiveWindowAttribution";
import { createDeviceHierarchyCapture } from "./DeviceHierarchyCapture";
import { RealSettleObserve } from "./SettleObserve";

interface ObserveScreenWiringSources {
  device: BootedDevice;
  adb: () => AdbExecutor;
  adbFactory: () => AdbClientFactory;
  observeScreenProvider: () => ObserveScreen;
  identity: {
    device: () => BootedDevice;
    viewHierarchy: () => ViewHierarchy;
    deviceStateCollector: () => DeviceStateCollector;
    timer: () => Timer;
    platformValidator: () => HierarchyPlatformValidator;
    resolveObservationTimestampMs: (result: ObserveResult) => number | undefined;
    extractScreenSizeFromHierarchy: (
      hierarchy: ObserveResult["viewHierarchy"],
    ) => { width: number; height: number } | null;
  };
}

export function installObserveStores(
  dependencies: Pick<ObserveScreenDependencies, "cacheStore" | "screenshotStateStore"> | undefined,
): void {
  // Install injected stores before constructing services that read the registry.
  // Instance methods and static resource/daemon accessors must share state.
  // Tests install fakes in beforeEach and reset the registries in afterEach.
  if (dependencies?.cacheStore) {
    setObserveCacheStore(dependencies.cacheStore);
  }
  if (dependencies?.screenshotStateStore) {
    setScreenshotStateStore(dependencies.screenshotStateStore);
  }
}

/** Creates lazy factories only; the caller controls construction and field assignment order. */
export function createObserveScreenWiring(sources: ObserveScreenWiringSources) {
  const { device, identity } = sources;
  return {
    createHierarchyCapture(timer: Timer, ids: IdGenerator) {
      return createDeviceHierarchyCapture(device, {
        viewHierarchy: identity.viewHierarchy(),
        settle: new RealSettleObserve(sources.observeScreenProvider(), timer),
        timer,
        ids,
      });
    },
    createScreenshotRecorder(
      screenshot: ScreenshotService,
      pathProtection: ScreenshotPathProtection,
    ) {
      return new DefaultObserveScreenshotRecorder(
        device,
        screenshot as TrackedScreenshotService,
        getScreenshotStateStore(),
        pathProtection,
      );
    },
    createHierarchyCollector(
      dependencies:
        | Pick<ObserveScreenDependencies, "onAvailabilityLost" | "daemonState">
        | undefined,
    ) {
      return new HierarchyCollector({
        device,
        viewHierarchy: identity.viewHierarchy(),
        adb: sources.adb(),
        adbFactory: sources.adbFactory(),
        timer: identity.timer(),
        onAvailabilityLost:
          dependencies?.onAvailabilityLost ??
          (device.platform === "android"
            ? (reason) => {
                const daemonState = dependencies?.daemonState ?? DaemonState.getInstance();
                if (daemonState.isInitialized()) {
                  daemonState
                    .getSessionManager()
                    .invalidateAutomationReadinessForDevice(device.deviceId, reason);
                }
              }
            : undefined),
      });
    },
    createDeviceStateCollector(window: Window, backStack: BackStack) {
      return new DeviceStateCollector({
        device,
        window,
        backStack,
        adb: sources.adb(),
        timer: identity.timer(),
      });
    },
    createPerformanceAuditor() {
      return new PerformanceAuditor({
        device,
        adbFactory: sources.adbFactory(),
        // Resolve this same instance lazily for per-tap point re-validation (#6228).
        observeScreenProvider: sources.observeScreenProvider,
      });
    },
    createAccessibilityAuditor() {
      return new AccessibilityAuditor({
        device,
        // Only this observation's capture; never the device-wide latest (#10037).
        screenshotPathResolver: (observationId) =>
          resolveObservationScreenshotPath(
            getScreenshotStateStore().getPathForObservation(
              identity.device().deviceId,
              observationId,
            ),
          ),
      });
    },
    createAccessibilityStateDetector() {
      return new AccessibilityStateDetector({ device, adb: sources.adb() });
    },
    createWindowIdentity() {
      return new DefaultWindowIdentityFreshnessResolver({
        deviceStateCollector: identity.deviceStateCollector,
        timer: identity.timer,
        resolveObservationTimestampMs: identity.resolveObservationTimestampMs,
      });
    },
    createReconciler() {
      return new DefaultActiveWindowAttributionReconciler({
        viewHierarchy: identity.viewHierarchy,
        deviceStateCollector: identity.deviceStateCollector,
        device: identity.device,
        platformValidator: identity.platformValidator,
        resolveObservationTimestampMs: identity.resolveObservationTimestampMs,
        extractScreenSizeFromHierarchy: identity.extractScreenSizeFromHierarchy,
      });
    },
  };
}
