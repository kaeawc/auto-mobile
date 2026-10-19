import type {
  CtrlProxyHierarchyResponse,
  CtrlProxyNode,
  CtrlProxySyncedHierarchy,
  XCTestHierarchy,
} from "../../src/features/observe/ios/types";

/** A minimal runner capture for `packageName` whose root node is `root` (empty by default). */
export function xcTestHierarchyFor(
  packageName: string,
  root: CtrlProxyNode = {},
  updatedAt = 0,
): XCTestHierarchy {
  return { updatedAt, packageName, hierarchy: root };
}

/** A synchronous runner response carrying an empty capture for `packageName`. */
export function syncedHierarchyFor(packageName: string): CtrlProxySyncedHierarchy {
  return { hierarchy: xcTestHierarchyFor(packageName), fresh: true };
}

/** A cache read that has no capture yet. */
export const NO_CACHED_HIERARCHY: CtrlProxyHierarchyResponse = { hierarchy: null, fresh: false };
