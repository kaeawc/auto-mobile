import {
  nodeAttributes,
  type Hierarchy,
  type ViewHierarchyNode,
} from "../../../models/ViewHierarchyResult";
import { parseBounds } from "../../../utils/bounds";
import type { ConvertibleNode } from "./types";

type SnapshotNode = Hierarchy | ViewHierarchyNode | ConvertibleNode;

function collectNodeWidths(
  node: SnapshotNode,
  contentWidths: number[],
  cardWidths: number[],
): void {
  const attrs = nodeAttributes(node as ViewHierarchyNode);
  const identifier = attrs["resource-id"] ?? attrs.resourceId;
  const bounds = parseBounds(node.bounds ?? attrs.bounds);
  if (bounds && bounds.right > bounds.left && bounds.bottom > bounds.top) {
    const width = bounds.right - bounds.left;
    if (identifier === "AppSwitcherContentView") {
      contentWidths.push(width);
    } else if (typeof identifier === "string" && identifier.startsWith("card:")) {
      cardWidths.push(width);
    }
  }
}

/** Mirrors CtrlProxy's AppSwitcherSnapshotClassifier: retained full-screen cards are not visible. */
export function isIosAppSwitcherVisible(root: SnapshotNode | undefined): boolean {
  const contentWidths: number[] = [];
  const cardWidths: number[] = [];
  const pending: SnapshotNode[] = root ? [root] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    collectNodeWidths(node, contentWidths, cardWidths);
    if (node.node) {
      pending.push(...(Array.isArray(node.node) ? node.node : [node.node]));
    }
  }
  return contentWidths.some((content) => cardWidths.some((card) => card < content * 0.9));
}
