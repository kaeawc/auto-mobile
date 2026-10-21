import type {
  BootedDevice,
  ElementBounds,
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

/**
 * Flat Android attributes use the same open attribute contract as NodeAttributes.
 * Captured wire nodes from older runners carry compact `[left, top, right, bottom]` bounds,
 * which the model type does not admit but `ElementParser` tolerates, so fixtures may state them.
 */
export interface TestHierarchyNode extends Omit<ViewHierarchyNode, "bounds" | "node"> {
  [attribute: string]: unknown;
  bounds?: ElementBounds | number[];
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
