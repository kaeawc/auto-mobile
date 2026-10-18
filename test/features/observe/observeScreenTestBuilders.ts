import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import type { ObserveScreenDependencies } from "../../../src/features/observe/ObserveScreenDependencies";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../../../src/utils/SystemTimer";

const noopAudit = { run: async () => undefined };

export function createObserveScreenForTest(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
  overrides: ObserveScreenDependencies = {},
  timer?: Timer,
): RealObserveScreen {
  // Audits are replaced by no-ops unless a test supplies its own, so no real audit/detection runs.
  return new RealObserveScreen(
    device,
    adbFactory,
    {
      ...overrides,
      performanceAuditor: overrides.performanceAuditor ?? noopAudit,
      accessibilityAuditor: overrides.accessibilityAuditor ?? noopAudit,
      accessibilityStateDetector: overrides.accessibilityStateDetector ?? noopAudit,
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
  hierarchy: Omit<ViewHierarchyResult["hierarchy"], "node"> & { node?: TestHierarchyNode };
};

export type TestHierarchyResult = ViewHierarchyResult & { hierarchy: { node: TestHierarchyNode } };

export function createHierarchyForTest(
  fixture: TestHierarchy & { hierarchy: { node: TestHierarchyNode } },
): TestHierarchyResult;
export function createHierarchyForTest(fixture: TestHierarchy): ViewHierarchyResult;
export function createHierarchyForTest(fixture: TestHierarchy): ViewHierarchyResult {
  return fixture;
}

/** A complete minimal observation carrying `viewHierarchy`; every other field is a neutral default. */
export function createObserveResultForTest(
  overrides: Pick<ObserveResult, "viewHierarchy">,
): ObserveResult {
  return {
    display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    observationId: "test-observation",
    updatedAt: 0,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}
