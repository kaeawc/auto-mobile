import { createHash } from "node:crypto";
import type { ViewHierarchyNode } from "../../../models";

export interface IosLayoutTelemetryNode {
  className?: string;
  "resource-id"?: string;
  text?: string;
  "content-desc"?: string;
  scrollable?: string;
  node?: IosLayoutTelemetryNode[];
}

// 100 nodes retains the complete 55-node Settings golden frame and keeps the
// 865-node replay below 8 KB. Full counts and observation trees remain available.
const MAX_LAYOUT_TELEMETRY_NODES = 100;

/** Android-compatible display properties, bounded in depth-first pre-order. */
export function buildIosLayoutTelemetryTree(root: ViewHierarchyNode | undefined): {
  node: IosLayoutTelemetryNode;
  truncated: boolean;
} {
  let remaining = MAX_LAYOUT_TELEMETRY_NODES;
  let truncated = false;
  const visit = (node: ViewHierarchyNode): IosLayoutTelemetryNode | undefined => {
    if (remaining === 0) {
      truncated = true;
      return undefined;
    }
    remaining--;
    const compact = compactDisplayProperties(node);
    if (node.node) {
      const children = Array.isArray(node.node) ? node.node : [node.node];
      compact.node = [];
      for (const child of children) {
        const converted = visit(child);
        if (!converted) {
          break;
        }
        compact.node.push(converted);
      }
    }
    return compact;
  };
  return { node: root ? visit(root)! : {}, truncated };
}

function compactDisplayProperties(node: ViewHierarchyNode): IosLayoutTelemetryNode {
  const attrs = node.$ ?? {};
  const compact: IosLayoutTelemetryNode = {};
  const fields = [
    ["class", "className"],
    ["resource-id", "resource-id"],
    ["text", "text"],
    ["content-desc", "content-desc"],
  ] as const;
  for (const [source, destination] of fields) {
    const value = attrs[source];
    if (typeof value === "string" && value) {
      compact[destination] = value;
    }
  }
  if (attrs.scrollable === "true") {
    compact.scrollable = "true";
  }
  return compact;
}

/**
 * Fingerprint the full display tree, independently of the stored payload cap.
 * Stream projected nodes and child boundaries rather than serializing a second
 * full tree. Capture timestamps are excluded: each unchanged poll gets a new one.
 */
export function hashIosLayoutTelemetryTree(
  root: ViewHierarchyNode | undefined,
  packageName: string | undefined,
  windowCount: number,
  nodeCount: number,
): string {
  const hash = createHash("sha1");
  hash.update(JSON.stringify([packageName ?? null, windowCount, nodeCount]));
  const visit = (node: ViewHierarchyNode): void => {
    hash.update(JSON.stringify(compactDisplayProperties(node)));
    if (node.node) {
      hash.update("[");
      const children = Array.isArray(node.node) ? node.node : [node.node];
      for (const child of children) {
        visit(child);
      }
      hash.update("]");
    }
  };
  if (root) {
    visit(root);
  }
  return hash.digest("hex");
}
