import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import type { Window } from "../../../src/features/observe/interfaces/Window";
import type { ActiveWindowInfo } from "../../../src/models/ActiveWindowInfo";
import type { ObserveScreenDependencies } from "../../../src/features/observe/ObserveScreenDependencies";
import { PerformanceAuditor } from "../../../src/features/observe/audits/PerformanceAuditor";
import { AccessibilityAuditor } from "../../../src/features/observe/audits/AccessibilityAuditor";
import { AccessibilityStateDetector } from "../../../src/features/observe/audits/AccessibilityStateDetector";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../../../src/utils/SystemTimer";

type TestDependencies = Partial<
  Omit<
    ObserveScreenDependencies,
    "performanceAuditor" | "accessibilityAuditor" | "accessibilityStateDetector"
  > & {
    performanceAuditor: Pick<PerformanceAuditor, "run">;
    accessibilityAuditor: Pick<AccessibilityAuditor, "run">;
    accessibilityStateDetector: Pick<AccessibilityStateDetector, "run">;
  }
>;

export function createObserveScreenForTest(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
  overrides: TestDependencies = {},
  timer?: Timer,
): RealObserveScreen {
  const { performanceAuditor, accessibilityAuditor, accessibilityStateDetector, ...dependencies } =
    overrides;
  const performanceStub: Pick<PerformanceAuditor, "run"> = performanceAuditor ?? {
    run: async () => undefined,
  };
  const accessibilityStub: Pick<AccessibilityAuditor, "run"> = accessibilityAuditor ?? {
    run: async () => undefined,
  };
  const detectorStub: Pick<AccessibilityStateDetector, "run"> = accessibilityStateDetector ?? {
    run: async () => undefined,
  };
  // The dependency bag requires concrete classes with private fields. Their constructors
  // only assign fields; replace run before injection so no real audit/detection executes.
  return new RealObserveScreen(
    device,
    adbFactory,
    {
      ...dependencies,
      performanceAuditor: Object.assign(
        new PerformanceAuditor({ device, adbFactory }),
        performanceStub,
      ),
      accessibilityAuditor: Object.assign(new AccessibilityAuditor({ device }), accessibilityStub),
      accessibilityStateDetector: Object.assign(
        new AccessibilityStateDetector({ device, adb: adbFactory.create(device) }),
        detectorStub,
      ),
    },
    timer,
  );
}

/** Flat Android attributes use the same open attribute contract as NodeAttributes. */
export interface TestHierarchyNode extends ViewHierarchyNode {
  [attribute: string]: unknown;
  node?: TestHierarchyNode[];
}

type TestHierarchy = Omit<ViewHierarchyResult, "hierarchy"> & {
  hierarchy: Omit<ViewHierarchyResult["hierarchy"], "node"> & {
    node?: TestHierarchyNode | TestHierarchyNode[];
  };
};

export type TestHierarchyResult = ViewHierarchyResult & { hierarchy: { node: TestHierarchyNode } };

export function createHierarchyForTest(
  fixture: TestHierarchy & { hierarchy: { node: TestHierarchyNode } },
): TestHierarchyResult;
export function createHierarchyForTest(fixture: TestHierarchy): ViewHierarchyResult;
export function createHierarchyForTest(fixture: TestHierarchy): ViewHierarchyResult {
  // Deliberate array-shaped roots exercise legacy/malformed captures outside the model.
  return fixture as ViewHierarchyResult;
}

export function createObserveResultForTest(
  overrides: Pick<ObserveResult, "viewHierarchy">,
): ObserveResult {
  // Deliberately incomplete observation exercises private timestamp guards before other fields are read.
  return overrides as ObserveResult;
}

export function createNullActiveWindowForTest(): Window {
  // Pre-API-28 `getActive` queries legitimately resolve null although the interface promises a window.
  return {
    getActive: async (): Promise<ActiveWindowInfo | null> => null,
    getActiveHash: async () => "hash",
    getCachedActiveWindow: async () => null,
    setCachedActiveWindow: async () => undefined,
    clearCache: async () => undefined,
  } as Window;
}

/** Array-shaped root: legacy/malformed captures that the auditors must still tolerate. */
export function createArrayRootForTest(nodes: TestHierarchyNode[]): ViewHierarchyNode {
  return nodes as ViewHierarchyNode;
}

/** A device whose platform is neither android nor ios, to exercise the unsupported-platform branch. */
export function createUnknownPlatformDeviceForTest(device: BootedDevice): BootedDevice {
  const platform: string = "unknown";
  return { ...device, platform } as BootedDevice;
}

/** Captures from the other platform (raw iOS keys on an Android run) fall outside the model. */
export function createForeignHierarchyForTest(fixture: {
  hierarchy: Record<string, unknown>;
  [field: string]: unknown;
}): ViewHierarchyResult {
  return fixture as ViewHierarchyResult;
}

/** Element stand-in carrying only the fields a test asserts on. */
export function createStaleElementForTest(fields: Partial<Element>): Element {
  return fields as Element;
}

/** Observation stand-in with only the fields a test populates (others stay absent). */
export function createPartialObserveResultForTest(fixture: Record<string, unknown>): ObserveResult {
  return fixture as ObserveResult;
}
