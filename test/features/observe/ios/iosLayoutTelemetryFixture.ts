import { readFileSync } from "node:fs";
import { convertToViewHierarchyResult } from "../../../../src/features/observe/ios/IosHierarchyConverter";
import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../../../src/models";

const frame: { push: { data: XCTestHierarchy } } = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/ios/ctrlproxy-golden/settings-tap-general/0002-push-hierarchy_update.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function goldenLayoutHierarchy(): ViewHierarchyResult {
  return convertToViewHierarchyResult(frame.push.data);
}

export function largeLayoutHierarchy(): ViewHierarchyResult {
  const result = goldenLayoutHierarchy();
  const root = result.hierarchy.node!;
  // The real converted root has 54 descendants: 1 + 16 * 54 = exactly 865 nodes.
  root.node = Array.from({ length: 16 }, () => root.node ?? []).flat();
  return result;
}

/** Exact details_json payload written before compaction, for byte comparisons. */
export function previousLayoutDetails(hierarchy: ViewHierarchyResult, nodeCount: number): string {
  return JSON.stringify({
    nodeCount,
    packageName: hierarchy.packageName,
    hierarchy: hierarchy.hierarchy,
    windows: hierarchy.windows,
    updatedAt: hierarchy.updatedAt,
  });
}
