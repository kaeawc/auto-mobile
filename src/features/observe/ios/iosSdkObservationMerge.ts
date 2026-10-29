import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import { nodeAttributes, nodeBounds } from "../../../models/ViewHierarchyResult";
import type { IosSdkObservation, IosSdkObservationNode } from "./sdkObservationBridge";

/**
 * Merges an iOS SDK observation-bridge snapshot into the XCTest hierarchy (#5159).
 *
 * The bridge's visible nodes are attached under the app node, so system UI, alerts and the
 * keyboard stay observable. Each bridge node maps onto the existing attributes (`id` →
 * `resource-id` and `test-tag`, `label` → `content-desc`, `value` → `text`, `role` → `class`), so
 * the shared selector schema and resolver match it unchanged. It also carries
 * `sdk-element-id` and `sdk-capture-identity`, which route a tap on it through the bridge.
 */

/** Marker shared with the runner's own SDK-walker nodes (`sdk.source` in `extras`). */
export const IOS_SDK_BRIDGE_SOURCE = "sdkBridge";
export const SDK_ELEMENT_ID_ATTRIBUTE = "sdk-element-id";
export const SDK_CAPTURE_IDENTITY_ATTRIBUTE = "sdk-capture-identity";

/** The bridge identity a node merged from an observation carries, if any. */
export interface IosSdkBridgeTarget {
  elementId: string;
  observationIdentity: number;
}

export function iosSdkBridgeTarget(attributes: Record<string, unknown>): IosSdkBridgeTarget | null {
  const elementId = attributes[SDK_ELEMENT_ID_ATTRIBUTE];
  const identity = Number(attributes[SDK_CAPTURE_IDENTITY_ATTRIBUTE]);
  if (typeof elementId !== "string" || elementId.length === 0 || !Number.isSafeInteger(identity)) {
    return null;
  }
  return { elementId, observationIdentity: identity };
}

function convertNode(
  node: IosSdkObservationNode,
  captureIdentity: number,
): ViewHierarchyNode | null {
  if (!node.visible) {
    return null;
  }
  const actionable = node.enabled;
  const $: Record<string, unknown> = {
    "resource-id": node.id,
    "test-tag": node.id,
    class: node.role,
    role: node.role,
    bounds: { ...node.bounds },
    enabled: String(node.enabled),
    [SDK_ELEMENT_ID_ATTRIBUTE]: node.id,
    [SDK_CAPTURE_IDENTITY_ATTRIBUTE]: String(captureIdentity),
    ...(node.label !== undefined ? { "content-desc": node.label } : {}),
    ...(node.value !== undefined ? { text: node.value } : {}),
    ...(actionable ? { clickable: "true" } : {}),
    ...(node.focused ? { focused: "true" } : {}),
  };
  const children = node.children
    .map((child) => convertNode(child, captureIdentity))
    .filter((child): child is ViewHierarchyNode => child !== null);
  return {
    $,
    extras: { "sdk.source": IOS_SDK_BRIDGE_SOURCE },
    ...(children.length > 0 ? { node: children } : {}),
  };
}

/** Hierarchy children may arrive as one object rather than an array (XML-shaped nodes). */
function childrenOf(node: ViewHierarchyNode): ViewHierarchyNode[] {
  const children: unknown = node.node;
  if (Array.isArray(children)) {
    return children;
  }
  return children && typeof children === "object" ? [children as ViewHierarchyNode] : [];
}

function boundsKey(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const { left, top, right, bottom } = value as Record<string, unknown>;
  if ([left, top, right, bottom].some((part) => typeof part !== "number")) {
    return null;
  }
  return `${left},${top},${right},${bottom}`;
}

/** Bounds plus the label or id a bridge node exposes: what an XCTest duplicate would also show. */
function bridgeSignatures(node: IosSdkObservationNode, into: Set<string>): void {
  if (!node.visible) {
    return;
  }
  const key = boundsKey(node.bounds);
  if (key) {
    for (const name of [node.id, node.label, node.value]) {
      if (name) {
        into.add(`${key}|${name}`);
      }
    }
  }
  for (const child of node.children) {
    bridgeSignatures(child, into);
  }
}

function isCoveredLeaf(node: ViewHierarchyNode, signatures: Set<string>): boolean {
  if (childrenOf(node).length > 0) {
    return false;
  }
  const key = boundsKey(nodeBounds(node));
  if (!key) {
    return false;
  }
  const attributes = nodeAttributes(node);
  return ["resource-id", "content-desc", "text"].some((name) => {
    const value = attributes[name];
    return typeof value === "string" && value.length > 0 && signatures.has(`${key}|${value}`);
  });
}

/** Removes XCTest leaves a bridge node already covers: same bounds and the same label or id. */
function removeCoveredLeaves(node: ViewHierarchyNode, signatures: Set<string>): number {
  const children = childrenOf(node);
  if (children.length === 0) {
    return 0;
  }
  const kept = children.filter((child) => !isCoveredLeaf(child, signatures));
  let removed = children.length - kept.length;
  node.node = kept;
  for (const child of kept) {
    removed += removeCoveredLeaves(child, signatures);
  }
  return removed;
}

export interface IosSdkMergeSummary {
  /** Bridge nodes attached (visible nodes only). */
  attached: number;
  /** XCTest leaves removed as duplicates of a bridge node. */
  deduplicated: number;
}

function countNodes(node: ViewHierarchyNode): number {
  return 1 + childrenOf(node).reduce((total, child) => total + countNodes(child), 0);
}

/**
 * Attaches the bridge snapshot under the hierarchy's app node, in place, so a snapshot identity
 * already bound to `hierarchy` stays valid. Returns null and changes nothing when the hierarchy
 * has no app node or the bridge has no visible root.
 */
export function mergeIosSdkObservation(
  hierarchy: ViewHierarchyResult,
  observation: IosSdkObservation,
): IosSdkMergeSummary | null {
  const appNode = hierarchy.hierarchy?.node;
  if (!appNode || !observation.root) {
    return null;
  }
  const bridgeRoot = convertNode(observation.root, observation.captureIdentity);
  if (!bridgeRoot) {
    return null;
  }
  const signatures = new Set<string>();
  bridgeSignatures(observation.root, signatures);
  const deduplicated = removeCoveredLeaves(appNode, signatures);
  appNode.node = [...childrenOf(appNode), bridgeRoot];
  return { attached: countNodes(bridgeRoot), deduplicated };
}
