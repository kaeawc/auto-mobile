import { hasIosHeaderTrait } from "./semanticRoles";

const GENERATED_VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IosHierarchyNode = Record<string, unknown> & {
  node?: IosHierarchyNode | IosHierarchyNode[];
};

type NoiseSiblingScope = {
  additions: string[];
  seen: Set<string>;
};

export function cleanupIosXCTestHierarchy<T>(hierarchy: T): T {
  if (!hierarchy || typeof hierarchy !== "object") {
    return hierarchy;
  }

  const root = hierarchy as Record<string, unknown>;
  return {
    ...root,
    hierarchy: cleanupNodeSlot(root.hierarchy),
  } as T;
}

function cleanupNodeSlot(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.flatMap((child) => {
      const cleaned = cleanupNode(child as IosHierarchyNode);
      return cleaned ? [cleaned] : [];
    });
  }
  if (node && typeof node === "object") {
    return cleanupNode(node as IosHierarchyNode);
  }
  return node;
}

function cleanupNode(
  node: IosHierarchyNode,
  siblingNoiseScope?: NoiseSiblingScope,
): IosHierarchyNode | null {
  const childNoiseScope = siblingNoiseScope ?? createNoiseSiblingScope();
  const originalChildren = normalizeChildren(node.node);
  const compactedChildren: IosHierarchyNode[] = [];
  for (const child of originalChildren) {
    const additionsStart = childNoiseScope.additions.length;
    const cleaned = cleanupNode(child, childNoiseScope);
    if (
      cleaned &&
      !isRedundantStaticTextChildForParent(node, cleaned) &&
      !isStructuralWrapperWithOnlyScrollBarNoise(cleaned) &&
      !wasStructuralWrapperEmptiedByScopedDedupe(child, cleaned)
    ) {
      compactedChildren.push(cleaned);
    } else {
      rollbackNoiseAdditions(childNoiseScope, additionsStart);
    }
  }
  if (
    isSingleChildStructuralWrapper(node, compactedChildren) &&
    (originalChildren.length === 1 || isNoiseOnlyCollapse(originalChildren, compactedChildren[0]))
  ) {
    return compactedChildren[0];
  }
  const result = withHeadingRole(node);

  if (compactedChildren.length === 0) {
    delete result.node;
  } else {
    result.node = compactedChildren.length === 1 ? compactedChildren[0] : compactedChildren;
  }

  return dedupeCurrentNoiseSibling(result, siblingNoiseScope);
}

function withHeadingRole(node: IosHierarchyNode): IosHierarchyNode {
  return hasIosHeaderTrait(node.extras) ? { ...node, role: "heading" } : { ...node };
}

function normalizeChildren(node: IosHierarchyNode["node"]): IosHierarchyNode[] {
  if (!node) {
    return [];
  }
  return Array.isArray(node) ? node : [node];
}

function isRedundantStaticTextChildForParent(
  parent: IosHierarchyNode,
  child: IosHierarchyNode,
): boolean {
  const parentText = normalizedText(parent.text);
  if (!parentText || !canOwnStaticText(parent)) {
    return false;
  }

  return isRedundantStaticTextChild(parentText, child);
}

function canOwnStaticText(node: IosHierarchyNode): boolean {
  const role = typeof node.role === "string" ? node.role : "";
  return node.clickable === "true" || role === "button" || role === "link" || role === "listitem";
}

function isRedundantStaticTextChild(parentText: string, child: IosHierarchyNode): boolean {
  if (child.node) {
    return false;
  }
  if (hasExtras(child)) {
    return false;
  }

  const className = readClassName(child);
  const role = typeof child.role === "string" ? child.role : "";
  if (className !== "UILabel" || (role !== "" && role !== "text")) {
    return false;
  }
  if (normalizedText(child.text) !== parentText) {
    return false;
  }
  if (hasActions(child) || hasStateProperties(child) || hasDirectActionProperties(child)) {
    return false;
  }

  return !hasStandaloneContentProperties(child);
}

function wasStructuralWrapperEmptiedByScopedDedupe(
  original: IosHierarchyNode,
  cleaned: IosHierarchyNode,
): boolean {
  if (normalizeChildren(cleaned.node).length !== 0) {
    return false;
  }

  const originalChildren = normalizeChildren(original.node);
  if (isStructuralWrapperWithOnlyScrollBarNoise(original)) {
    return true;
  }
  if (originalChildren.length === 0) {
    return false;
  }

  return (
    isContentlessNodeOfClass(cleaned, readClassName(original)) &&
    isContentlessStructuralWrapper(original) &&
    originalChildren.every(isNoiseOnlyStructuralSubtree)
  );
}

function isContentlessNodeOfClass(node: IosHierarchyNode, className: unknown): boolean {
  return (
    readClassName(node) === className &&
    !normalizedText(node.text) &&
    !hasStandaloneContentProperties(node) &&
    !hasExtras(node) &&
    !hasActions(node) &&
    !hasStateProperties(node) &&
    !hasDirectActionProperties(node)
  );
}

function isContentlessStructuralWrapper(node: IosHierarchyNode): boolean {
  const className = readClassName(node);
  return (
    (className === "UIView" || className === "WKWebView") &&
    !normalizedText(node.text) &&
    !hasStandaloneContentProperties(node) &&
    !hasExtras(node) &&
    !hasActions(node) &&
    !hasStateProperties(node) &&
    !hasDirectActionProperties(node)
  );
}

function isNoiseOnlyStructuralSubtree(node: IosHierarchyNode): boolean {
  if (noiseSiblingKey(node) !== null) {
    return true;
  }

  const children = normalizeChildren(node.node);
  return (
    children.length > 0 &&
    isContentlessStructuralWrapper(node) &&
    children.every(isNoiseOnlyStructuralSubtree)
  );
}

function dedupeCurrentNoiseSibling(
  node: IosHierarchyNode,
  scope: NoiseSiblingScope | undefined,
): IosHierarchyNode | null {
  if (!scope) {
    return node;
  }

  const key = noiseSiblingKey(node);
  if (key) {
    if (scope.seen.has(key)) {
      return null;
    }
    scope.seen.add(key);
    scope.additions.push(key);
  }

  return node;
}

function createNoiseSiblingScope(): NoiseSiblingScope {
  return {
    additions: [],
    seen: new Set<string>(),
  };
}

function rollbackNoiseAdditions(scope: NoiseSiblingScope, additionsStart: number): void {
  while (scope.additions.length > additionsStart) {
    const key = scope.additions.pop();
    if (key) {
      scope.seen.delete(key);
    }
  }
}

function noiseSiblingKey(node: IosHierarchyNode): string | null {
  if (node.node) {
    return null;
  }
  if (hasExtras(node) || hasActions(node)) {
    return null;
  }
  if (hasStateProperties(node)) {
    return null;
  }

  const text = normalizedText(node.text).toLowerCase();
  const isKnownNoise = text.includes("scroll bar") || text === "dictate" || text === "dictation";
  if (!isKnownNoise) {
    return null;
  }

  return JSON.stringify([
    readClassName(node),
    node.text ?? "",
    readResourceId(node),
    node.bounds ?? null,
  ]);
}

function hasStandaloneContentProperties(node: IosHierarchyNode): boolean {
  return Boolean(
    hasNonEmptyString(node.value) ||
    hasNonEmptyString(readResourceId(node)) ||
    hasNonEmptyString(readContentDesc(node)) ||
    hasNonEmptyString(readHintText(node)) ||
    hasNonEmptyString(node["test-tag"]) ||
    hasNonEmptyString(node.testTag) ||
    hasMeaningfulViewId(node),
  );
}

function isStructuralWrapperWithOnlyScrollBarNoise(node: IosHierarchyNode): boolean {
  const children = normalizeChildren(node.node);
  if (
    readClassName(node) !== "UIView" ||
    children.length === 0 ||
    normalizedText(node.text) ||
    hasStandaloneContentProperties(node) ||
    hasExtras(node) ||
    hasActions(node) ||
    hasStateProperties(node) ||
    hasDirectActionProperties(node)
  ) {
    return false;
  }

  return children.every((child) => isScrollBarNoise(child) && !isProtectedNoiseNode(child));
}

function isSingleChildStructuralWrapper(
  node: IosHierarchyNode,
  children: IosHierarchyNode[],
): boolean {
  if (children.length !== 1 || hasExtras(node) || hasActions(node)) {
    return false;
  }
  if (readClassName(node) !== "WKWebView") {
    return false;
  }
  if (normalizedText(node.text) || hasStandaloneContentProperties(node)) {
    return false;
  }

  return !hasStateProperties(node) && !hasDirectActionProperties(node);
}

function isNoiseOnlyCollapse(
  originalChildren: IosHierarchyNode[],
  remainingChild: IosHierarchyNode | undefined,
): boolean {
  return Boolean(
    remainingChild &&
    isNoiseOnlyStructuralSubtree(remainingChild) &&
    originalChildren.every(isNoiseOnlyStructuralSubtree),
  );
}

function hasStateProperties(node: IosHierarchyNode): boolean {
  return Boolean(
    node.scrollable === "true" ||
    node.focused === "true" ||
    node.accessibilityFocused === "true" ||
    node["accessibility-focused"] === "true" ||
    node.selected === "true" ||
    node.checked === "true",
  );
}

function hasMeaningfulViewId(node: IosHierarchyNode): boolean {
  const viewId = readViewId(node);
  return typeof viewId === "string" && viewId !== "" && !GENERATED_VIEW_ID_PATTERN.test(viewId);
}

function hasDirectActionProperties(node: IosHierarchyNode): boolean {
  return Boolean(
    node.clickable === "true" ||
    node.focusable === "true" ||
    node["long-clickable"] === "true" ||
    node.longClickable === "true" ||
    node.checkable === "true",
  );
}

function isProtectedNoiseNode(node: IosHierarchyNode): boolean {
  return Boolean(
    hasExtras(node) ||
    hasActions(node) ||
    hasStateProperties(node) ||
    hasDirectActionProperties(node) ||
    hasStandaloneContentProperties(node),
  );
}

function isScrollBarNoise(node: IosHierarchyNode): boolean {
  return normalizedText(node.text).toLowerCase().includes("scroll bar");
}

function hasActions(node: IosHierarchyNode): boolean {
  return Array.isArray(node.actions) && node.actions.length > 0;
}

function hasExtras(node: IosHierarchyNode): boolean {
  return !!node.extras && typeof node.extras === "object" && Object.keys(node.extras).length > 0;
}

function readClassName(node: IosHierarchyNode): unknown {
  return node.className ?? node.class ?? "";
}

function readResourceId(node: IosHierarchyNode): unknown {
  return node["resource-id"] ?? node.resourceId;
}

function readContentDesc(node: IosHierarchyNode): unknown {
  return node["content-desc"] ?? node.contentDesc;
}

function readHintText(node: IosHierarchyNode): unknown {
  return node["hint-text"] ?? node.hintText;
}

function readViewId(node: IosHierarchyNode): unknown {
  return node["view-id"] ?? node.viewId;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
