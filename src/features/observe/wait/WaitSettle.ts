import { ViewHierarchyResult } from "../../../models";
import { nodeAttributes, type ViewHierarchyNode } from "../../../models/ViewHierarchyResult";
import { logger } from "../../../utils/logger";
import { NodeCryptoService } from "../../../utils/crypto";
import { SDK_CAPTURE_IDENTITY_ATTRIBUTE } from "../../../utils/hierarchyFingerprint";

const SETTLE_VOLATILE_NODE_FIELDS = new Set([
  SDK_CAPTURE_IDENTITY_ATTRIBUTE,
  "extras",
  "occlusionState",
  "occludedBy",
  "occludedByViewId",
  "recomposition",
  "recompositionMetrics",
]);

function normalizeSettleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSettleValue);
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeSettleValue((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

function normalizeSettleAttributes(
  attributes: Record<string, unknown>,
  excludedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(attributes).sort()) {
    if (!excludedFields.has(key)) {
      normalized[key] = normalizeSettleValue(attributes[key]);
    }
  }
  return normalized;
}

function normalizeSettleNode(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const node = value as ViewHierarchyNode;
  const nodeRecord: Record<string, unknown> = { ...node };
  const attributes = nodeAttributes(node);
  const normalized = normalizeSettleAttributes(
    nodeRecord,
    new Set([...SETTLE_VOLATILE_NODE_FIELDS, "node", "$"]),
  );
  // Hash every node field by default so newly added accessibility attributes
  // (for example iOS value or Android hint/error) cannot hide UI changes.
  // Only known capture noise is excluded from the settle signal.
  if (node.$ !== undefined) {
    normalized.$ = normalizeSettleAttributes(attributes, SETTLE_VOLATILE_NODE_FIELDS);
  }
  const children = node.node;
  if (children !== undefined) {
    const childNodes = Array.isArray(children) ? children : [children];
    normalized.node = childNodes.map(normalizeSettleNode);
  }
  return normalized;
}

function normalizeHierarchyForSettle(hierarchy: ViewHierarchyResult["hierarchy"]): unknown {
  const root = hierarchy.node;
  if (root === undefined) {
    return hierarchy.bounds === undefined
      ? null
      : { bounds: normalizeSettleValue(hierarchy.bounds) };
  }
  const nodes = Array.isArray(root) ? root : [root];
  return {
    ...(hierarchy.bounds === undefined ? {} : { bounds: normalizeSettleValue(hierarchy.bounds) }),
    node: nodes.map(normalizeSettleNode),
  };
}

// Compact stable hash of the hierarchy node tree, used only to detect quiet
// (settled) periods. Screen size / window metadata are excluded so cosmetic,
// non-hierarchy churn does not defeat the gate. A missing hierarchy hashes to a
// stable sentinel, so it counts as "quiet". Returns null when the tree cannot be
// hashed, which the settle gate treats as unstable (never settle on it).
export const hashHierarchyForSettle = (viewHierarchy?: ViewHierarchyResult): string | null => {
  try {
    const normalized = viewHierarchy ? normalizeHierarchyForSettle(viewHierarchy.hierarchy) : null;
    return NodeCryptoService.generateCacheKey(JSON.stringify(normalized));
  } catch (error) {
    // Non-serializable hierarchy is unexpected; a constant sentinel would compare
    // equal across consecutive failures and be mistaken for a quiet tree, so
    // return null and let settleReady restart the quiet window instead.
    logger.debug(`[observe] Failed to hash hierarchy for settle gate: ${error}`);
    return null;
  }
};
