import { CtrlProxyHierarchy } from "../../src/features/observe/ios/CtrlProxyHierarchy";
import type { ConvertibleHierarchy } from "../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../src/models";
import { createIosDelegateHarness } from "./iosDelegateHarness";

/** The production runner-wire to view-hierarchy converter, driven by an inert delegate context. */
export function createIosHierarchyConverter(): CtrlProxyHierarchy {
  return new CtrlProxyHierarchy(createIosDelegateHarness().context);
}

/**
 * Convert a runner hierarchy as `IOSCtrlProxyClient.convertToViewHierarchyResult` does, including
 * re-attaching the daemon capture sequence the converter itself drops.
 */
export function convertIosHierarchy(hierarchy: ConvertibleHierarchy): ViewHierarchyResult {
  const converted = createIosHierarchyConverter().convertToViewHierarchyResult(hierarchy);
  return hierarchy.captureSequence === undefined
    ? converted
    : { ...converted, captureSequence: hierarchy.captureSequence };
}
