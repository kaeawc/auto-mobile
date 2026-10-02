import type { ScreenshotPathProtection } from "./ScreenshotPathProtection";
import type { HierarchyCapture } from "./HierarchyCapture";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import type { ViewHierarchy } from "./interfaces/ViewHierarchy";
import type { Window } from "./interfaces/Window";
import type { BackStack } from "./interfaces/BackStack";
import type { PredictiveUIState } from "./interfaces/PredictiveUIState";
import type { ObserveResultCacheStore } from "./cache/ObserveResultCacheStore";
import type { ScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import type { ObserveScreenshotRecorder } from "./screenshot/ObserveScreenshotRecorder";
import type { HierarchyCollector } from "./collectors/HierarchyCollector";
import type { DeviceStateCollector } from "./collectors/DeviceStateCollector";
import type { PerformanceAuditor } from "./audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "./audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import type { HierarchyPlatformValidator } from "./HierarchyPlatformValidator";
import type { DaemonStateLike } from "../../daemon/daemonState";
import type { IosLockStateProbe } from "./ios/IosLockStateProbe";
import type { ScreenshotEvidenceFiles } from "./screenshot/observationScreenshotEvidence";

/**
 * Dependencies for ObserveScreen that can be injected for testing.
 * All properties are optional - defaults will be created if not provided.
 */
export interface ObserveScreenDependencies {
  /** Avoid normal screenshot-cache eviction when observing an unowned device. */
  deviceReadOnly?: boolean;
  /** Tool-level display request retained through waitFor polls. */
  display?: string;
  // Data sources
  viewHierarchy?: ViewHierarchy;
  hierarchyCapture?: HierarchyCapture;
  window?: Window;
  screenshot?: ScreenshotService;
  backStack?: BackStack;
  predictiveUIState?: PredictiveUIState;

  // Cache + screenshot state — process-wide singletons used by server resource handlers.
  // Tests can swap these to isolate state across cases.
  cacheStore?: ObserveResultCacheStore;
  screenshotStateStore?: ScreenshotStateStore;
  screenshotEvidenceFiles?: ScreenshotEvidenceFiles;
  screenshotPathProtection?: ScreenshotPathProtection;

  // Composed services. If omitted, defaults are built from the data sources above.
  screenshotRecorder?: ObserveScreenshotRecorder;
  hierarchyCollector?: HierarchyCollector;
  onAvailabilityLost?: (reason: string) => void;
  daemonState?: Pick<DaemonStateLike, "isInitialized" | "getSessionManager">;
  deviceStateCollector?: DeviceStateCollector;
  iosLockStateProbe?: IosLockStateProbe;
  performanceAuditor?: PerformanceAuditor;
  accessibilityAuditor?: AccessibilityAuditor;
  accessibilityStateDetector?: AccessibilityStateDetector;

  // Rejects cross-platform (stale) hierarchies. Defaults to RealHierarchyPlatformValidator.
  platformValidator?: HierarchyPlatformValidator;
}
