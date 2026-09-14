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

/**
 * Dependencies for ObserveScreen that can be injected for testing.
 * All properties are optional - defaults will be created if not provided.
 */
export interface ObserveScreenDependencies {
  // Data sources
  viewHierarchy?: ViewHierarchy;
  window?: Window;
  screenshot?: ScreenshotService;
  backStack?: BackStack;
  predictiveUIState?: PredictiveUIState;

  // Cache + screenshot state — process-wide singletons used by server resource handlers.
  // Tests can swap these to isolate state across cases.
  cacheStore?: ObserveResultCacheStore;
  screenshotStateStore?: ScreenshotStateStore;

  // Composed services. If omitted, defaults are built from the data sources above.
  screenshotRecorder?: ObserveScreenshotRecorder;
  hierarchyCollector?: HierarchyCollector;
  deviceStateCollector?: DeviceStateCollector;
  performanceAuditor?: PerformanceAuditor;
  accessibilityAuditor?: AccessibilityAuditor;
  accessibilityStateDetector?: AccessibilityStateDetector;

  // Rejects cross-platform (stale) hierarchies. Defaults to RealHierarchyPlatformValidator.
  platformValidator?: HierarchyPlatformValidator;
}
