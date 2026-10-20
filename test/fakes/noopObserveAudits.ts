import type { ObserveScreenDependencies } from "../../src/features/observe/ObserveScreenDependencies";

/** Audit seams that do nothing, for observe tests that do not exercise audits. */
export function noopObserveAudits(): Required<
  Pick<
    ObserveScreenDependencies,
    "performanceAuditor" | "accessibilityAuditor" | "accessibilityStateDetector"
  >
> {
  const noop = { run: async (): Promise<void> => undefined };
  return {
    performanceAuditor: noop,
    accessibilityAuditor: noop,
    accessibilityStateDetector: noop,
  };
}
