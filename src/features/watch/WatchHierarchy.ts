import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import { convertToViewHierarchyResult } from "../observe/ios/IosHierarchyConverter";
import type { CtrlProxyNode } from "../observe/ios/types";

/** Fields consumed from AutoMobileSdkWire's SdkViewNode, including its decoding defaults. */
export interface WatchHierarchyNode {
  accessibilityIdentifier?: string | null;
  accessibilityLabel?: string | null;
  className: string;
  bounds: NonNullable<CtrlProxyNode["bounds"]>;
  children?: WatchHierarchyNode[] | null;
  isHidden?: boolean | null;
  isOccluded?: boolean | null;
  alpha?: number | null;
  isAccessibilityElement?: boolean | null;
  isAccessibilityFocused?: boolean | null;
  accessibilityTraits?: string[] | null;
  hasTapTarget?: boolean | null;
  isUserInteractionEnabled?: boolean | null;
}

/** AutoMobileSdkWire's SdkViewHierarchy envelope emitted by CtrlProxyWatch. */
export interface WatchHierarchy {
  timestamp: number;
  screenWidth: number;
  screenHeight: number;
  screenScale: number;
  bundleId?: string | null;
  root: WatchHierarchyNode;
}

export function isWatchHierarchy(value: unknown): value is WatchHierarchy {
  if (!value || typeof value !== "object") {
    return false;
  }
  const hierarchy = value as Record<string, unknown>;
  return (
    typeof hierarchy.timestamp === "number" &&
    Number.isFinite(hierarchy.timestamp) &&
    [hierarchy.screenWidth, hierarchy.screenHeight, hierarchy.screenScale].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0,
    ) &&
    (hierarchy.bundleId === undefined ||
      hierarchy.bundleId === null ||
      typeof hierarchy.bundleId === "string") &&
    isWatchNode(hierarchy.root)
  );
}

function isWatchNode(value: unknown): value is WatchHierarchyNode {
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as Record<string, unknown>;
  return (
    typeof node.className === "string" &&
    isWatchBounds(node.bounds) &&
    hasValidNodeProperties(node) &&
    (node.children === undefined ||
      node.children === null ||
      (Array.isArray(node.children) && node.children.every(isWatchNode)))
  );
}

function isWatchBounds(value: unknown): value is WatchHierarchyNode["bounds"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const bounds = value as Record<string, unknown>;
  return ["left", "top", "right", "bottom"].every(
    (key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]),
  );
}

function hasValidNodeProperties(node: Record<string, unknown>): boolean {
  const traits = node.accessibilityTraits ?? [];
  return (
    [node.accessibilityIdentifier, node.accessibilityLabel].every(
      (entry) => entry === undefined || entry === null || typeof entry === "string",
    ) &&
    [
      node.isHidden,
      node.isOccluded,
      node.isAccessibilityElement,
      node.isAccessibilityFocused,
      node.hasTapTarget,
      node.isUserInteractionEnabled,
    ].every((entry) => entry === undefined || entry === null || typeof entry === "boolean") &&
    Number.isFinite(node.alpha ?? 1) &&
    Array.isArray(traits) &&
    traits.every((trait: unknown) => typeof trait === "string")
  );
}

// The iOS converter has no visibility attributes; omit invisible subtrees before conversion.
function isVisible(node: WatchHierarchyNode): boolean {
  return !node.isHidden && !node.isOccluded && (node.alpha ?? 1) > 0;
}

function convertNode(node: WatchHierarchyNode): CtrlProxyNode {
  return {
    text: node.accessibilityLabel ?? undefined,
    resourceId: node.accessibilityIdentifier ?? undefined,
    className: node.className,
    bounds: node.bounds,
    enabled: String(node.isUserInteractionEnabled ?? true),
    clickable: String(node.hasTapTarget ?? false),
    focusable: String(node.isAccessibilityElement ?? false),
    accessibilityFocused: String(node.isAccessibilityFocused ?? false),
    extras: node.accessibilityTraits?.length
      ? { "sdk.accessibilityTraits": node.accessibilityTraits.join(",") }
      : undefined,
    node: (node.children ?? []).filter(isVisible).map(convertNode),
  };
}

/** Use the iOS converter and its stable node identities, bounds and attribute conventions. */
export function normalizeWatchHierarchy(value: unknown): ViewHierarchyResult {
  if (!isWatchHierarchy(value)) {
    throw new ActionableError(
      "The watch runner returned an invalid hierarchy; reconnect the runner.",
    );
  }
  return convertToViewHierarchyResult({
    updatedAt: value.timestamp,
    hierarchy: isVisible(value.root) ? convertNode(value.root) : {},
    packageName: value.bundleId ?? "",
    screenWidth: value.screenWidth,
    screenHeight: value.screenHeight,
    // Metadata only: XCTest bounds and gesture coordinates remain in points.
    screenScale: value.screenScale,
  });
}
