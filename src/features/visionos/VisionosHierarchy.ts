import { z } from "zod/v4";
import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import { convertToViewHierarchyResult } from "../observe/ios/IosHierarchyConverter";
import type { CtrlProxyNode, XCTestHierarchy } from "../observe/ios/types";

const nodeSchema = z.object({
  className: z.string(),
  bounds: z.object({
    left: z.number().finite(),
    top: z.number().finite(),
    right: z.number().finite(),
    bottom: z.number().finite(),
  }),
  text: z.string().optional(),
  value: z.string().optional(),
  "resource-id": z.string().optional(),
  enabled: z.enum(["true", "false"]).optional(),
  focused: z.enum(["true", "false"]).optional(),
  selected: z.enum(["true", "false"]).optional(),
  get node(): z.ZodOptional<z.ZodArray<typeof nodeSchema>> {
    return z.array(nodeSchema).optional();
  },
});
const hierarchySchema = z.object({
  hierarchy: nodeSchema,
  updatedAt: z.number().finite(),
  packageName: z.string(),
  screenWidth: z.number().positive().finite(),
  screenHeight: z.number().positive().finite(),
});
export type VisionosHierarchy = XCTestHierarchy;
export function isVisionosHierarchy(value: unknown): value is VisionosHierarchy {
  return hierarchySchema.safeParse(value).success;
}
export function normalizeVisionosHierarchy(value: unknown): ViewHierarchyResult {
  if (!isVisionosHierarchy(value)) {
    throw new ActionableError("Invalid visionOS hierarchy; reconnect the runner.");
  }
  const root = value.hierarchy;
  const bounds = root.bounds!; // Required and finite at every node by hierarchySchema.
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width <= 0 || height <= 0) {
    throw new ActionableError("Invalid visionOS window bounds; reconnect the runner.");
  }
  return convertToViewHierarchyResult({
    ...value,
    hierarchy: markOrnamentScenes(root),
    // The runner's descendant max extents include scroll content and system scenes.
    // Only the root app window defines the logical window-space viewport.
    screenWidth: width,
    screenHeight: height,
  });
}

function children(node: CtrlProxyNode): CtrlProxyNode[] {
  return Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
}

function descendants(node: CtrlProxyNode): CtrlProxyNode[] {
  return [node, ...children(node).flatMap(descendants)];
}

function markOrnament(node: CtrlProxyNode): CtrlProxyNode {
  return {
    ...node,
    space: "ornament",
    ...(node.node && { node: children(node).map(markOrnament) }),
  };
}

function nodeIdentity(node: CtrlProxyNode): string | undefined {
  const identifier = "resource-id" in node ? node["resource-id"] : node.resourceId;
  const label = identifier || node.text;
  return label ? JSON.stringify([node.className, label]) : undefined;
}

function isOrnamentScene(
  scene: CtrlProxyNode,
  window: NonNullable<CtrlProxyNode["bounds"]>,
): boolean {
  const frame = scene.bounds!;
  return (
    scene.className === "4" &&
    frame.left === 0 &&
    frame.top === 0 &&
    frame.right > 0 &&
    frame.bottom > 0 &&
    frame.right < window.right - window.left &&
    frame.bottom < window.bottom - window.top
  );
}

function markOrnamentScenes(root: CtrlProxyNode): CtrlProxyNode {
  const nodes = children(root);
  const window = root.bounds!;
  const marked = new Set<CtrlProxyNode>();
  // The runner flattens snapshots in preorder. A direct-child scene (XCTest group = 4)
  // spans siblings until the next scene group; nested captures keep actual children.
  // Treat only (0,0) scenes strictly smaller in both dimensions than the app window
  // as ornament-local, with all members inside that frame and no labeled/identified
  // member repeated elsewhere in window space. Blank layout wrappers are not identities.
  // These coordinates cannot locate an ornament on the screenshot: tap by label/id.
  for (let index = 0; index < nodes.length; index++) {
    const scene = nodes[index];
    const frame = scene.bounds!;
    if (!isOrnamentScene(scene, window)) {
      continue;
    }
    const nextScene = nodes.findIndex((node, i) => i > index && node.className === "4");
    const members = scene.node
      ? descendants(scene)
      : nodes.slice(index, nextScene < 0 ? nodes.length : nextScene).flatMap(descendants);
    const memberSet = new Set(members);
    const outsideIds = new Set(
      nodes
        .flatMap(descendants)
        .filter((node) => !memberSet.has(node))
        .map(nodeIdentity)
        .filter(Boolean),
    );
    if (
      members.some((node) => {
        const b = node.bounds!;
        const identity = nodeIdentity(node);
        return (
          b.left < 0 ||
          b.top < 0 ||
          b.right > frame.right ||
          b.bottom > frame.bottom ||
          (identity !== undefined && outsideIds.has(identity))
        );
      })
    ) {
      continue;
    }
    for (const member of members) {
      marked.add(member);
    }
  }
  return { ...root, node: nodes.map((node) => (marked.has(node) ? markOrnament(node) : node)) };
}
