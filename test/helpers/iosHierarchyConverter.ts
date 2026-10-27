import { convertToViewHierarchyResult } from "../../src/features/observe/ios/IosHierarchyConverter";
import type { ConvertibleHierarchy } from "../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../src/models";

/**
 * Convert a runner hierarchy as `IOSCtrlProxyClient.convertToViewHierarchyResult` does, including
 * re-attaching the daemon capture sequence the converter itself drops.
 */
export function convertIosHierarchy(hierarchy: ConvertibleHierarchy): ViewHierarchyResult {
  const converted = convertToViewHierarchyResult(hierarchy);
  return hierarchy.captureSequence === undefined
    ? converted
    : { ...converted, captureSequence: hierarchy.captureSequence };
}
