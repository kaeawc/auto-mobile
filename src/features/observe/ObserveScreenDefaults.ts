import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import { ViewHierarchy } from "./ViewHierarchy";
import { Window } from "./Window";
import { TakeScreenshot } from "./TakeScreenshot";
import { GetBackStack } from "./GetBackStack";
import { PredictiveUIState } from "./PredictiveUIState";
import { screenshotPathProtection } from "./ScreenshotPathProtection";
import { RealHierarchyPlatformValidator } from "./HierarchyPlatformValidator";
import { BudgetedIosLockStateProbe } from "./ios/BudgetedIosLockStateProbe";
import { getIosLockStateCache } from "./ios/IosLockStateCacheRegistry";
import { installObserveStores, type createObserveScreenWiring } from "./ObserveScreenWiring";
import type { ObserveScreenDependencies } from "./ObserveScreenDependencies";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import type { HierarchyCapture } from "./HierarchyCapture";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";
import type { ScreenshotPathProtection } from "./ScreenshotPathProtection";
import type { ObserveScreenshotRecorder } from "./screenshot/ObserveScreenshotRecorder";
import type { ScreenshotEvidenceFiles } from "./screenshot/observationScreenshotEvidence";
import type { DeviceStateCollectorPort, HierarchyCollectorPort } from "./collectors/collectorPorts";
import type { IosLockStateProbe } from "./ios/IosLockStateProbe";
import type { PerformanceAuditor } from "./audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "./audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import type { HierarchyPlatformValidator } from "./HierarchyPlatformValidator";
import type { WindowIdentityFreshnessResolver } from "./WindowIdentityFreshness";
import type { ActiveWindowAttributionReconciler } from "./ActiveWindowAttribution";

type ObserveScreenWiring = ReturnType<typeof createObserveScreenWiring>;

/** Hierarchy used for a read-only (unowned) device whose connection is gone. */
export const unavailableReadOnlyHierarchy: ViewHierarchyInterface = {
  getViewHierarchy: async () => ({
    hierarchy: { error: "Hierarchy connection unavailable", unavailableReason: "connection_lost" },
  }),
  configureRecompositionTracking: async () => {},
  findFocusedElement: () => null,
  findAccessibilityFocusedElement: () => null,
  filterOffscreenNodes: (hierarchy) => hierarchy,
};

export interface ObserveScreenDefaultsContext {
  device: BootedDevice;
  adbFactory: AdbClientFactory;
  timer: Timer;
  idGenerator: IdGenerator;
  wiring: ObserveScreenWiring;
  dependencies?: ObserveScreenDependencies;
}

export interface ResolvedObserveDataSources {
  hierarchyCapture: HierarchyCapture;
  screenshotService: ScreenshotService;
  predictiveUIState: PredictiveUIStateInterface;
  window: NonNullable<ObserveScreenDependencies["window"]>;
  backStack: NonNullable<ObserveScreenDependencies["backStack"]>;
}

export interface ResolvedObserveServices {
  pathProtection: ScreenshotPathProtection;
  screenshotRecorder: ObserveScreenshotRecorder;
  screenshotEvidenceFiles?: ScreenshotEvidenceFiles;
  hierarchyCollector: HierarchyCollectorPort;
  deviceStateCollector: DeviceStateCollectorPort;
  iosLockStateProbe: IosLockStateProbe;
  performanceAuditor: Pick<PerformanceAuditor, "run">;
  accessibilityAuditor: Pick<AccessibilityAuditor, "run">;
  accessibilityStateDetector: Pick<AccessibilityStateDetector, "run">;
  platformValidator: HierarchyPlatformValidator;
  windowIdentity: WindowIdentityFreshnessResolver;
  reconciler: ActiveWindowAttributionReconciler;
}

/** Use the injected collaborator, building the default lazily only when absent. */
function orDefault<T>(injected: T | undefined, create: () => T): T {
  return injected ?? create();
}

function readOnlyOr<T>(readOnly: boolean | undefined, whenReadOnly: () => T, normal: () => T): T {
  return readOnly ? whenReadOnly() : normal();
}

/**
 * Resolve the view hierarchy first: the wiring reads it eagerly while building the
 * hierarchy capture, so the owner must expose it before the other defaults resolve.
 */
export function resolveObserveViewHierarchy(
  context: ObserveScreenDefaultsContext,
): ViewHierarchyInterface {
  const { device, adbFactory, dependencies: deps } = context;
  return orDefault(deps?.viewHierarchy, () =>
    readOnlyOr(
      deps?.deviceReadOnly,
      () => unavailableReadOnlyHierarchy,
      () => new ViewHierarchy(device, adbFactory),
    ),
  );
}

/** Resolve the injected data sources, falling back to the device-backed defaults. */
export function resolveObserveDataSources(
  context: ObserveScreenDefaultsContext,
): ResolvedObserveDataSources {
  const { device, adbFactory, timer, idGenerator, wiring, dependencies: deps } = context;
  const readOnly = deps?.deviceReadOnly;
  return {
    hierarchyCapture: orDefault(deps?.hierarchyCapture, () =>
      wiring.createHierarchyCapture(timer, idGenerator),
    ),
    screenshotService: orDefault(deps?.screenshot, () =>
      readOnlyOr(
        readOnly,
        () => TakeScreenshot.forObservationRead(device),
        () => new TakeScreenshot(device, { adbFactory }),
      ),
    ),
    window: orDefault(deps?.window, () => new Window(device, adbFactory)),
    backStack: orDefault(deps?.backStack, () => new GetBackStack(device, adbFactory)),
    predictiveUIState: orDefault(deps?.predictiveUIState, () => new PredictiveUIState()),
  };
}

/** Resolve the screenshot-related services built on the data sources. */
export function resolveObserveScreenshotServices(
  context: ObserveScreenDefaultsContext,
  sources: ResolvedObserveDataSources,
): Pick<
  ResolvedObserveServices,
  "pathProtection" | "screenshotRecorder" | "screenshotEvidenceFiles"
> {
  const { wiring, dependencies: deps } = context;
  const pathProtection = deps?.screenshotPathProtection ?? screenshotPathProtection;
  return {
    pathProtection,
    screenshotRecorder: orDefault(deps?.screenshotRecorder, () =>
      wiring.createScreenshotRecorder(sources.screenshotService, pathProtection),
    ),
    screenshotEvidenceFiles: deps?.screenshotEvidenceFiles,
  };
}

/** Resolve the collectors, auditors and window-identity services. */
export function resolveObserveCollectionServices(
  context: ObserveScreenDefaultsContext,
  sources: ResolvedObserveDataSources,
): Omit<
  ResolvedObserveServices,
  "pathProtection" | "screenshotRecorder" | "screenshotEvidenceFiles"
> {
  const { wiring, dependencies: deps } = context;
  return {
    hierarchyCollector: orDefault(deps?.hierarchyCollector, () =>
      wiring.createHierarchyCollector(deps),
    ),
    deviceStateCollector: orDefault(deps?.deviceStateCollector, () =>
      wiring.createDeviceStateCollector(sources.window, sources.backStack),
    ),
    iosLockStateProbe: orDefault(
      deps?.iosLockStateProbe,
      () => new BudgetedIosLockStateProbe(getIosLockStateCache(), context.timer),
    ),
    performanceAuditor: orDefault(deps?.performanceAuditor, () =>
      wiring.createPerformanceAuditor(),
    ),
    accessibilityAuditor: orDefault(deps?.accessibilityAuditor, () =>
      wiring.createAccessibilityAuditor(),
    ),
    accessibilityStateDetector: orDefault(deps?.accessibilityStateDetector, () =>
      wiring.createAccessibilityStateDetector(),
    ),
    platformValidator: orDefault(
      deps?.platformValidator,
      () => new RealHierarchyPlatformValidator(),
    ),
    windowIdentity: orDefault(deps?.windowIdentityFreshnessResolver, () =>
      wiring.createWindowIdentity(),
    ),
    reconciler: orDefault(deps?.activeWindowAttributionReconciler, () => wiring.createReconciler()),
  };
}

/** Resolve the composed services that are built on top of the data sources. */
export function resolveObserveServices(
  context: ObserveScreenDefaultsContext,
  sources: ResolvedObserveDataSources,
): ResolvedObserveServices {
  installObserveStores(context.dependencies);
  return {
    ...resolveObserveScreenshotServices(context, sources),
    ...resolveObserveCollectionServices(context, sources),
  };
}

/** Resolve every default ObserveScreen collaborator; behaviour matches the former constructor. */
export function resolveObserveScreenDependencies(context: ObserveScreenDefaultsContext): {
  sources: ResolvedObserveDataSources;
  services: ResolvedObserveServices;
} {
  const sources = resolveObserveDataSources(context);
  return { sources, services: resolveObserveServices(context, sources) };
}
