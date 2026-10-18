import { nodeAttributes } from "../../../models/ViewHierarchyResult";
import { GENERATED_VIEW_ID_PATTERN } from "../android/StableNodeIdentity";

/** Converted node format — `$` carries standard attributes, `extras` carries SDK walker data. */
export interface ConvertedNode {
  $: Record<string, unknown>;
  extras?: Record<string, string>;
  node?: ConvertedNode[];
}

/**
 * Check if a node has meaningful content (text, identifier, test-tag)
 */
export function hasContentProperties(attrs: Record<string, unknown>): boolean {
  const contentFields = ["text", "value", "resource-id", "content-desc", "test-tag", "role"];
  return Boolean(
    contentFields.some((field) => attrs[field] && attrs[field] !== "") ||
    hasMeaningfulViewId(attrs),
  );
}

export function hasChildrenOrExtras(node: ConvertedNode): boolean {
  if (node.node && node.node.length > 0) {
    return true;
  }
  if (node.extras && Object.keys(node.extras).length > 0) {
    return true;
  }
  return false;
}

export function isRedundantStaticTextChild(parentText: string, child: ConvertedNode): boolean {
  if (hasChildrenOrExtras(child)) {
    return false;
  }

  const attrs = nodeAttributes(child);
  const className = typeof attrs["class"] === "string" ? attrs["class"] : "";
  const role = typeof attrs["role"] === "string" ? attrs["role"] : "";
  if (className !== "UILabel" || (role !== "" && role !== "text")) {
    return false;
  }
  if (normalizedText(attrs["text"]) !== parentText) {
    return false;
  }
  if (Array.isArray(attrs["actions"]) && attrs["actions"].length > 0) {
    return false;
  }
  if (hasStateProperties(attrs) || hasDirectActionProperties(attrs)) {
    return false;
  }

  return !hasStandaloneContentProperties(attrs);
}

export function hasStandaloneContentProperties(attrs: Record<string, unknown>): boolean {
  return Boolean(
    (attrs["value"] && attrs["value"] !== "") ||
    (attrs["resource-id"] && attrs["resource-id"] !== "") ||
    (attrs["content-desc"] && attrs["content-desc"] !== "") ||
    (attrs["test-tag"] && attrs["test-tag"] !== "") ||
    hasMeaningfulViewId(attrs),
  );
}

export function hasMeaningfulViewId(attrs: Record<string, unknown>): boolean {
  const viewId = attrs["view-id"];
  return typeof viewId === "string" && viewId !== "" && !GENERATED_VIEW_ID_PATTERN.test(viewId);
}

export function hasDirectActionProperties(attrs: Record<string, unknown>): boolean {
  return Boolean(
    attrs["clickable"] === "true" ||
    attrs["focusable"] === "true" ||
    attrs["long-clickable"] === "true" ||
    attrs["checkable"] === "true",
  );
}

export function hasStateProperties(attrs: Record<string, unknown>): boolean {
  return Boolean(
    attrs["scrollable"] === "true" ||
    attrs["focused"] === "true" ||
    attrs["accessibility-focused"] === "true" ||
    attrs["selected"] === "true" ||
    attrs["checked"] === "true",
  );
}

export function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function noiseSiblingKey(node: ConvertedNode): string | null {
  if (hasChildrenOrExtras(node)) {
    return null;
  }

  const attrs = nodeAttributes(node);
  if (Array.isArray(attrs["actions"]) && attrs["actions"].length > 0) {
    return null;
  }
  if (hasStateProperties(attrs)) {
    return null;
  }

  const text = typeof attrs["text"] === "string" ? attrs["text"].trim().toLowerCase() : "";
  const isKnownNoise = text.includes("scroll bar") || text === "dictate" || text === "dictation";
  if (!isKnownNoise) {
    return null;
  }

  return JSON.stringify([
    ...["class", "text", "resource-id"].map((field) => attrs[field] ?? ""),
    attrs["bounds"] ?? null,
  ]);
}
