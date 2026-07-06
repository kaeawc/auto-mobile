const GENERATED_VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IosHierarchyNode = Record<string, unknown> & {
  node?: IosHierarchyNode | IosHierarchyNode[];
};

export function cleanupIosXCTestHierarchy<T>(hierarchy: T): T {
  if (!hierarchy || typeof hierarchy !== "object") {
    return hierarchy;
  }

  const root = hierarchy as Record<string, unknown>;
  return {
    ...root,
    hierarchy: cleanupNodeSlot(root.hierarchy)
  } as T;
}

function cleanupNodeSlot(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.flatMap(child => {
      const cleaned = cleanupNode(child as IosHierarchyNode);
      return cleaned ? [cleaned] : [];
    });
  }
  if (node && typeof node === "object") {
    return cleanupNode(node as IosHierarchyNode);
  }
  return node;
}

function cleanupNode(node: IosHierarchyNode): IosHierarchyNode | null {
  const children = normalizeChildren(node.node)
    .map(cleanupNode)
    .filter((child): child is IosHierarchyNode => child !== null);
  const compactedChildren = dedupeNoiseSiblings(
    dropStructuralScrollBarWrappers(dropRedundantStaticTextChildren(node, children))
  );
  if (isSingleChildStructuralWrapper(node, compactedChildren)) {
    return compactedChildren[0];
  }
  const result: IosHierarchyNode = { ...node };

  if (compactedChildren.length === 0) {
    delete result.node;
  } else {
    result.node = compactedChildren.length === 1 ? compactedChildren[0] : compactedChildren;
  }

  return result;
}

function normalizeChildren(node: IosHierarchyNode["node"]): IosHierarchyNode[] {
  if (!node) {
    return [];
  }
  return Array.isArray(node) ? node : [node];
}

function dropRedundantStaticTextChildren(
  parent: IosHierarchyNode,
  children: IosHierarchyNode[]
): IosHierarchyNode[] {
  const parentText = normalizedText(parent.text);
  if (!parentText || !canOwnStaticText(parent)) {
    return children;
  }

  return children.filter(child => !isRedundantStaticTextChild(parentText, child));
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

function dedupeNoiseSiblings(children: IosHierarchyNode[]): IosHierarchyNode[] {
  const seen = new Set<string>();

  return children
    .map(child => dedupeNoiseDescendants(child, seen))
    .filter((child): child is IosHierarchyNode => child !== null);
}

function dropStructuralScrollBarWrappers(children: IosHierarchyNode[]): IosHierarchyNode[] {
  return children.filter(child => !isStructuralWrapperWithOnlyScrollBarNoise(child));
}

function dedupeNoiseDescendants(
  node: IosHierarchyNode,
  seen: Set<string>
): IosHierarchyNode | null {
  const key = noiseSiblingKey(node);
  if (key) {
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
  }

  const children = normalizeChildren(node.node);
  if (children.length === 0) {
    return node;
  }

  const result: IosHierarchyNode[] = [];
  let changed = false;

  for (const child of children) {
    const cleaned = dedupeNoiseDescendants(child, seen);
    if (cleaned) {
      result.push(cleaned);
      if (cleaned !== child) {
        changed = true;
      }
    } else {
      changed = true;
    }
  }

  if (!changed) {
    return node;
  }

  const cleanedNode = { ...node };
  if (result.length === 0) {
    delete cleanedNode.node;
  } else {
    cleanedNode.node = result.length === 1 ? result[0] : result;
  }
  return cleanedNode;
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
    hasMeaningfulViewId(node)
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

  return children.every(child => isScrollBarNoise(child) && !isProtectedNoiseNode(child));
}

function isSingleChildStructuralWrapper(
  node: IosHierarchyNode,
  children: IosHierarchyNode[]
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

function hasStateProperties(node: IosHierarchyNode): boolean {
  return Boolean(
    node.scrollable === "true" ||
    node.focused === "true" ||
    node.accessibilityFocused === "true" ||
    node["accessibility-focused"] === "true" ||
    node.selected === "true" ||
    node.checked === "true"
  );
}

function hasMeaningfulViewId(node: IosHierarchyNode): boolean {
  const viewId = readViewId(node);
  return typeof viewId === "string" &&
    viewId !== "" &&
    !GENERATED_VIEW_ID_PATTERN.test(viewId);
}

function hasDirectActionProperties(node: IosHierarchyNode): boolean {
  return Boolean(
    node.clickable === "true" ||
    node.focusable === "true" ||
    node["long-clickable"] === "true" ||
    node.longClickable === "true" ||
    node.checkable === "true"
  );
}

function isProtectedNoiseNode(node: IosHierarchyNode): boolean {
  return Boolean(
    hasExtras(node) ||
    hasActions(node) ||
    hasStateProperties(node) ||
    hasDirectActionProperties(node) ||
    hasStandaloneContentProperties(node)
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
