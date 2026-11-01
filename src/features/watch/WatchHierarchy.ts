import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import { convertToViewHierarchyResult } from "../observe/ios/IosHierarchyConverter";
import type { CtrlProxyNode } from "../observe/ios/types";

/** AutoMobileSdkWire's SdkViewHierarchy, as emitted by CtrlProxyWatch. */
export interface WatchHierarchyNode {
  id: string;
  label: string;
  type: number;
  enabled: boolean;
  frame: [number, number, number, number];
  children: WatchHierarchyNode[];
}

export function isWatchHierarchy(value: unknown): value is WatchHierarchyNode {
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as Record<string, unknown>;
  return (
    typeof node.id === "string" &&
    typeof node.label === "string" &&
    typeof node.type === "number" &&
    typeof node.enabled === "boolean" &&
    Array.isArray(node.frame) &&
    node.frame.length === 4 &&
    node.frame.every((entry: unknown) => typeof entry === "number" && Number.isFinite(entry)) &&
    Array.isArray(node.children) &&
    node.children.every(isWatchHierarchy)
  );
}

function convertNode(node: WatchHierarchyNode): CtrlProxyNode {
  const [x, y, width, height] = node.frame;
  const names: Record<number, string> = {
    2: "Application",
    4: "Window",
    9: "Button",
    25: "NavigationBar",
    46: "ScrollView",
    48: "StaticText",
  };
  return {
    text: node.label,
    resourceId: node.id,
    className: `XCUIElementType${names[node.type] ?? "Other"}`,
    enabled: String(node.enabled),
    clickable: String(node.type === 9),
    scrollable: String(node.type === 46),
    bounds: { left: x, top: y, right: x + width, bottom: y + height },
    node: node.children.map(convertNode),
  };
}

/** Use the iOS converter and its stable node identities, bounds and attribute conventions. */
export function normalizeWatchHierarchy(value: unknown): ViewHierarchyResult {
  if (!isWatchHierarchy(value)) {
    throw new ActionableError(
      "The watch runner returned an invalid hierarchy; reconnect the runner.",
    );
  }
  const normalized = convertToViewHierarchyResult({
    // The wire tree has no clock. Satisfy the iOS adapter input without publishing a fabricated timestamp.
    updatedAt: 0,
    hierarchy: convertNode(value),
    packageName: "",
    screenWidth: value.frame[2],
    screenHeight: value.frame[3],
  });
  delete normalized.updatedAt;
  return normalized;
}
