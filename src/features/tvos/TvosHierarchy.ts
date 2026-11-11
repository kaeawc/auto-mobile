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
  "resource-id": z.string().optional(),
  enabled: z.enum(["true", "false"]).optional(),
  focused: z.enum(["true", "false"]).optional(),
  checkable: z.enum(["true", "false"]).optional(),
  checked: z.enum(["true", "false"]).optional(),
  focusable: z.enum(["true", "false"]).optional(),
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
export type TvosHierarchy = XCTestHierarchy;
export function isTvosHierarchy(value: unknown): value is TvosHierarchy {
  return hierarchySchema.safeParse(value).success;
}
export function normalizeTvosHierarchy(value: unknown): ViewHierarchyResult {
  if (!isTvosHierarchy(value)) {
    throw new ActionableError("Invalid tvOS hierarchy; reconnect the runner.");
  }
  return convertToViewHierarchyResult({
    ...value,
    hierarchy: withFocusedCheckableState(value.hierarchy),
  });
}

/** Find state only in the actual subtree and within the focus owner's bounds. */
function nestedCheckedState(
  node: CtrlProxyNode,
  owner: NonNullable<CtrlProxyNode["bounds"]>,
): string | undefined {
  const bounds = node.bounds;
  if (
    node.checkable === "true" &&
    (node.checked === "true" || node.checked === "false") &&
    bounds &&
    bounds.left >= owner.left &&
    bounds.top >= owner.top &&
    bounds.right <= owner.right &&
    bounds.bottom <= owner.bottom
  ) {
    return node.checked;
  }
  const children = [node.node ?? []].flat();
  for (const child of children) {
    const checked = nestedCheckedState(child, owner);
    if (checked !== undefined) {
      return checked;
    }
  }
  return undefined;
}

/** SwiftUI gives the row focus while its nested switch owns the toggle state. */
function withFocusedCheckableState(node: CtrlProxyNode): CtrlProxyNode {
  const children = [node.node ?? []].flat();
  const checked =
    node.focused === "true" && node.bounds ? nestedCheckedState(node, node.bounds) : undefined;
  return {
    ...node,
    ...(checked !== undefined ? { checkable: "true", checked } : {}),
    ...(node.node ? { node: children.map(withFocusedCheckableState) } : {}),
  };
}
