import type { ViewHierarchyWindowInfo } from "../../models";

/** Link metadata to the exact canonical tree, never infer ownership from bounds or resource IDs. */
export function linkWindowRoots(
  hierarchy: any,
  windows?: ViewHierarchyWindowInfo[],
): ViewHierarchyWindowInfo[] | undefined {
  if (!windows) {
    return windows;
  }
  const roots = new Map<number, any>();
  const pending = [hierarchy];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Number.isInteger(node.windowId)) {
      // Malformed duplicate owner markers are ambiguous, so leave them unlinked.
      roots.set(node.windowId, roots.has(node.windowId) ? null : node);
    }
    if (node.node) {
      pending.push(node.node);
    }
  }
  return windows.map((window) => {
    const root = window.id === undefined ? undefined : roots.get(window.id);
    return root ? { ...window, hierarchy: root } : window;
  });
}
