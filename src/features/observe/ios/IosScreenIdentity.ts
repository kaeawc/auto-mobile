import type { ScreenIdentity } from "../../../models/ObserveResult";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";

type NodeAttrs = Record<string, unknown>;
type HierarchyNodeLike = ViewHierarchyNode & Record<string, unknown>;

const MODAL_CLASSES = new Set([
  "UIActionSheet",
  "UIAlertController",
  "UIAlertView",
  "UIPopoverPresentationController",
  "XCUIElementTypeAlert",
  "XCUIElementTypeSheet",
]);

interface CandidateSignals {
  bundleId?: string;
  navigationTitle?: string;
  selectedTab?: string;
  modalClass?: string;
  modalTitle?: string;
  focusedElementId?: string;
  keyboardVisible?: boolean;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function className(attrs: NodeAttrs): string | undefined {
  return asString(attrs["class"]) ?? asString(attrs["className"]);
}

function textOf(attrs: NodeAttrs): string | undefined {
  return asString(attrs["text"]) ?? asString(attrs["content-desc"]);
}

function attrsOf(node: ViewHierarchyNode | undefined): NodeAttrs {
  if (!node) {
    return {};
  }
  if (node.$ && typeof node.$ === "object") {
    return node.$;
  }
  return node as unknown as NodeAttrs;
}

function nodeChildren(node: ViewHierarchyNode | undefined): ViewHierarchyNode[] {
  if (!node?.node) {
    return [];
  }
  return Array.isArray(node.node) ? node.node : [node.node];
}

function hasNodeAttrs(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Boolean(
    record.$ ||
    record["class"] ||
    record["className"] ||
    record["text"] ||
    record["content-desc"] ||
    record["resource-id"] ||
    record["view-id"],
  );
}

function rootNode(viewHierarchy: ViewHierarchyResult | undefined): ViewHierarchyNode | undefined {
  const hierarchy = viewHierarchy?.hierarchy as unknown as HierarchyNodeLike | undefined;
  if (!hierarchy) {
    return undefined;
  }
  if (Array.isArray(hierarchy.node)) {
    if (hasNodeAttrs(hierarchy)) {
      return hierarchy;
    }
    return { $: {}, node: hierarchy.node };
  }
  return hierarchy.node ?? (hasNodeAttrs(hierarchy) ? hierarchy : undefined);
}

function walk(node: ViewHierarchyNode | undefined, visit: (node: ViewHierarchyNode) => void): void {
  if (!node) {
    return;
  }
  visit(node);
  for (const child of nodeChildren(node)) {
    walk(child, visit);
  }
}

function collectText(node: ViewHierarchyNode): string[] {
  const out: string[] = [];
  walk(node, (current) => {
    const text = textOf(attrsOf(current));
    if (text) {
      out.push(text);
    }
  });
  return out;
}

function findNavigationTitle(root: ViewHierarchyNode | undefined): string | undefined {
  let fallback: string | undefined;
  let title: string | undefined;
  walk(root, (node) => {
    if (title) {
      return;
    }
    const attrs = attrsOf(node);
    const cls = className(attrs);
    if (cls !== "UINavigationBar" && cls !== "XCUIElementTypeNavigationBar") {
      return;
    }
    fallback = textOf(attrs) ?? fallback;
    walk(node, (descendant) => {
      if (title) {
        return;
      }
      const descendantAttrs = attrsOf(descendant);
      const descendantClass = className(descendantAttrs);
      if (
        descendantClass === "_UINavigationBarTitleControl" ||
        descendantClass === "UILabel" ||
        descendantClass === "XCUIElementTypeStaticText"
      ) {
        title = textOf(descendantAttrs);
      }
    });
  });
  return title ?? fallback;
}

function findSelectedTab(root: ViewHierarchyNode | undefined): string | undefined {
  let selectedTab: string | undefined;
  const walkForTab = (node: ViewHierarchyNode | undefined, inTabBar: boolean): void => {
    if (!node || selectedTab) {
      return;
    }
    const attrs = attrsOf(node);
    const cls = className(attrs);
    const role = asString(attrs["role"]);
    const nextInTabBar = inTabBar || cls === "UITabBar" || cls === "XCUIElementTypeTabBar";
    if (isTrue(attrs["selected"])) {
      const selectedByRole = role === "tab";
      const selectedByTabBarChild =
        nextInTabBar &&
        (cls === "UITabBarButton" || cls === "UIButton" || cls === "XCUIElementTypeButton");
      if (selectedByRole || selectedByTabBarChild) {
        selectedTab = textOf(attrs) ?? asString(attrs["resource-id"]);
        return;
      }
    }
    for (const child of nodeChildren(node)) {
      walkForTab(child, nextInTabBar);
      if (selectedTab) {
        return;
      }
    }
  };
  walkForTab(root, false);
  return selectedTab;
}

function findModal(
  root: ViewHierarchyNode | undefined,
): Pick<CandidateSignals, "modalClass" | "modalTitle"> {
  let modalNode: ViewHierarchyNode | undefined;
  walk(root, (node) => {
    if (modalNode) {
      return;
    }
    const cls = className(attrsOf(node));
    if (cls && MODAL_CLASSES.has(cls)) {
      modalNode = node;
    }
  });
  if (!modalNode) {
    return {};
  }
  const attrs = attrsOf(modalNode);
  return {
    modalClass: className(attrs),
    modalTitle: collectText(modalNode)[0],
  };
}

function findFocusedElementId(root: ViewHierarchyNode | undefined): string | undefined {
  let focused: string | undefined;
  walk(root, (node) => {
    const attrs = attrsOf(node);
    if (focused || !isTrue(attrs["focused"])) {
      return;
    }
    focused =
      asString(attrs["resource-id"]) ??
      asString(attrs["view-id"]) ??
      textOf(attrs) ??
      className(attrs);
  });
  return focused;
}

function hasKeyboard(root: ViewHierarchyNode | undefined): boolean {
  let keyboardVisible = false;
  walk(root, (node) => {
    if (keyboardVisible) {
      return;
    }
    const cls = className(attrsOf(node));
    keyboardVisible =
      cls === "UIKeyboard" || cls === "UIKeyboardKey" || cls === "XCUIElementTypeKeyboard";
  });
  return keyboardVisible;
}

function makeKey(signals: CandidateSignals): string {
  const parts = [
    ["bundle", signals.bundleId],
    ["nav", signals.navigationTitle],
    ["modalClass", signals.modalClass],
    ["modalTitle", signals.modalTitle],
    ["tab", signals.selectedTab],
    ["focus", signals.focusedElementId],
    ["keyboard", signals.keyboardVisible ? "true" : undefined],
  ];
  return JSON.stringify(parts.filter(([, value]) => value !== undefined));
}

function confidence(signals: CandidateSignals): ScreenIdentity["confidence"] {
  if (signals.modalClass || signals.navigationTitle) {
    return "high";
  }
  if (signals.selectedTab || signals.focusedElementId || signals.keyboardVisible) {
    return "medium";
  }
  return "low";
}

export function deriveIosScreenIdentity(
  viewHierarchy: ViewHierarchyResult | undefined,
): ScreenIdentity | undefined {
  const root = rootNode(viewHierarchy);
  if (!root) {
    return undefined;
  }

  const modal = findModal(root);
  const signals: CandidateSignals = {
    bundleId: viewHierarchy?.packageName,
    navigationTitle: findNavigationTitle(root),
    selectedTab: findSelectedTab(root),
    ...modal,
    focusedElementId: findFocusedElementId(root),
    keyboardVisible: hasKeyboard(root) || undefined,
  };

  const hasUsefulSignal = Boolean(
    signals.navigationTitle ||
    signals.selectedTab ||
    signals.modalClass ||
    signals.modalTitle ||
    signals.focusedElementId ||
    signals.keyboardVisible,
  );
  if (!hasUsefulSignal) {
    return undefined;
  }

  return {
    platform: "ios",
    source: "heuristic",
    confidence: confidence(signals),
    key: makeKey(signals),
    components: Object.fromEntries(
      Object.entries(signals).filter(([, value]) => value !== undefined),
    ) as ScreenIdentity["components"],
  };
}
