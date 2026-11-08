import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import { convertToViewHierarchyResult } from "../observe/ios/IosHierarchyConverter";
import type { CtrlProxyNode } from "../observe/ios/types";

/** Fields consumed from AutoMobileSdkWire's SdkViewNode, including its decoding defaults. */
export interface WatchHierarchyNode {
  accessibilityIdentifier?: string | null;
  accessibilityLabel?: string | null;
  /** Semantic role for observe elements (e.g. `widget` on a Smart Stack cell); the SDK wire omits it. */
  role?: string | null;
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
    [node.accessibilityIdentifier, node.accessibilityLabel, node.role].every(
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

/**
 * XCUIElementType raw values (the runner reports `XCUIElementType(<rawValue>)`) whose
 * elements activate on tap: buttons, cells/rows, links, menu items, switches/toggles,
 * keys and text inputs. The runner's `hasTapTarget` is always false for XCUI snapshots,
 * so without this every watch row has no affordance (#17548).
 */
const TAP_ELEMENT_TYPES: ReadonlySet<number> = new Set([
  9, 10, 12, 14, 15, 16, 17, 20, 27, 30, 40, 41, 42, 45, 49, 50, 52, 54, 56, 59, 60, 75, 80,
]);
/** searchField, textField, secureTextField, textView. */
const TEXT_INPUT_ELEMENT_TYPES: ReadonlySet<number> = new Set([45, 49, 50, 52]);
/** table, collectionView, scrollView. */
const SCROLL_ELEMENT_TYPES: ReadonlySet<number> = new Set([26, 32, 46]);

function xcuiElementType(className: string): number | undefined {
  const match = /^XCUIElementType\((\d+)\)$/.exec(className);
  return match ? Number(match[1]) : undefined;
}

function hasElementType(node: WatchHierarchyNode, types: ReadonlySet<number>): boolean {
  const type = xcuiElementType(node.className);
  return type !== undefined && types.has(type);
}

/** Affordance fields from the wire tap flag and the XCUI element type; disabled controls get none. */
function affordanceFields(
  node: WatchHierarchyNode,
  enabled: boolean,
): Pick<CtrlProxyNode, "clickable" | "scrollable" | "actions"> {
  const tappable = enabled && hasElementType(node, TAP_ELEMENT_TYPES);
  const input = enabled && hasElementType(node, TEXT_INPUT_ELEMENT_TYPES);
  return {
    clickable: String((node.hasTapTarget ?? false) || tappable),
    scrollable: hasElementType(node, SCROLL_ELEMENT_TYPES) ? "true" : undefined,
    actions: input ? ["set_text"] : undefined,
  };
}

function convertNode(node: WatchHierarchyNode): CtrlProxyNode {
  const enabled = node.isUserInteractionEnabled ?? true;
  return {
    text: node.accessibilityLabel ?? undefined,
    resourceId: node.accessibilityIdentifier ?? undefined,
    role: node.role ?? undefined,
    className: node.className,
    bounds: node.bounds,
    enabled: String(enabled),
    ...affordanceFields(node, enabled),
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
