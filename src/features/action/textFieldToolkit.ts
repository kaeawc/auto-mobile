import type { Element } from "../../models/Element";
import {
  nodeAttributes,
  nodeBounds,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
} from "../../models/ViewHierarchyResult";
import { boundsEqual, parseBounds } from "../../utils/bounds";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { isTruthyFlag } from "../utility/elementProperties";

/** The UI toolkit that drew an editable field. */
export type TextFieldToolkit = "compose" | "view";

/**
 * Which toolkit drew a focused editable field. Class name cannot tell them apart: a Compose
 * `TextField` reports `android.widget.EditText` too. A package-qualified resource-id
 * (`pkg:id/name`) is a View id. Otherwise the field's ancestry in the read decides: Compose
 * semantics nodes sit under the `ComposeView`/`AndroidComposeView` that hosts them, so a field
 * with such an ancestor is Compose and a located field without one is a View (#17488). Only
 * when the read carries no hierarchy, or the field is not in it, does a bare or missing id fall
 * back to Compose, since a bare id is how Compose reports `Modifier.testTag`.
 */
export function textFieldToolkit(
  field: Element,
  hierarchy: ViewHierarchyResult | undefined,
): TextFieldToolkit {
  const resourceId = field["resource-id"];
  if (typeof resourceId === "string" && resourceId.includes(":id/")) {
    return "view";
  }
  const ancestors = hierarchy ? ancestorsOf(field, captureRoot(hierarchy)) : undefined;
  if (!ancestors) {
    return "compose";
  }
  return ancestors.some(isComposeHost) ? "compose" : "view";
}

function isComposeHost(node: ViewHierarchyNode): boolean {
  const className = nodeAttributes(node)["class"];
  return typeof className === "string" && className.includes("ComposeView");
}

/** A classless wrapper over the capture's top-level nodes, so one walk covers every root. */
function captureRoot(hierarchy: ViewHierarchyResult): ViewHierarchyNode {
  const top = hierarchy.hierarchy?.node;
  if (!top) {
    return {};
  }
  return { node: Array.isArray(top) ? top : [top] };
}

function childrenOf(node: ViewHierarchyNode): ViewHierarchyNode[] {
  const { node: children } = node;
  if (!children) {
    return [];
  }
  return Array.isArray(children) ? children : [children];
}

/**
 * The field's ancestors, root first, or undefined when it is not in the tree. The field's own
 * capture node is matched by identity; a field parsed from another read (or a scoped copy of
 * this one) falls back to the first focused node with the same bounds.
 */
function ancestorsOf(field: Element, root: ViewHierarchyNode): ViewHierarchyNode[] | undefined {
  const source = getHierarchyNodeSource(field);
  const sameNode = source ? findPath(root, (node) => node === source) : undefined;
  return sameNode ?? findPath(root, (node) => isFocusedAt(node, field.bounds));
}

function isFocusedAt(node: ViewHierarchyNode, bounds: Element["bounds"]): boolean {
  if (!isTruthyFlag(nodeAttributes(node)["focused"])) {
    return false;
  }
  const nodeRect = parseBounds(nodeBounds(node));
  return nodeRect !== null && boundsEqual(nodeRect, bounds);
}

/** Depth-first path (ancestors only, root first) to the first node `matches` accepts. */
function findPath(
  root: ViewHierarchyNode,
  matches: (node: ViewHierarchyNode) => boolean,
): ViewHierarchyNode[] | undefined {
  const path: ViewHierarchyNode[] = [];
  const search = (node: ViewHierarchyNode): boolean => {
    if (matches(node)) {
      return true;
    }
    path.push(node);
    if (childrenOf(node).some(search)) {
      return true;
    }
    path.pop();
    return false;
  };
  return search(root) ? path : undefined;
}
