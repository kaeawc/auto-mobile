import type { ScreenIdentity } from "../../../models/ObserveResult";
import { nodeAttributes, type ViewHierarchyResult } from "../../../models/ViewHierarchyResult";

type NodeAttrs = Record<string, unknown>;
type HierarchyNodeLike = {
  [key: string]: unknown;
  $?: NodeAttrs;
  node?: HierarchyNodeLike | HierarchyNodeLike[];
};

const MODAL_CLASSES = new Set([
  "UIActionSheet",
  "UIAlertController",
  "UIAlertView",
  "UIPopoverPresentationController",
  "XCUIElementTypeAlert",
  "XCUIElementTypeSheet",
]);

export const IOS_KEYBOARD_CONTAINER_CLASSES = new Set(["UIKeyboard", "XCUIElementTypeKeyboard"]);

/** An individual iOS keycap; may appear without a container in a partial capture. */
export const IOS_KEYBOARD_KEY_CLASS = "UIKeyboardKey";

/**
 * Whether a class name belongs to the iOS soft keyboard: its container or one
 * of its keycaps. The single source of truth for the screen identity, the
 * element collector (and so the skeleton `<ime>` row) and the diff flattening.
 */
export function isIosKeyboardClass(cls: string | undefined): boolean {
  return IOS_KEYBOARD_CONTAINER_CLASSES.has(cls ?? "") || cls === IOS_KEYBOARD_KEY_CLASS;
}

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

function attrsOf(node: HierarchyNodeLike | undefined): NodeAttrs {
  return node ? nodeAttributes(node) : {};
}

function nodeChildren(node: HierarchyNodeLike | undefined): HierarchyNodeLike[] {
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

function rootNode(viewHierarchy: ViewHierarchyResult | undefined): HierarchyNodeLike | undefined {
  const hierarchy: HierarchyNodeLike | undefined = viewHierarchy?.hierarchy;
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

function walk(node: HierarchyNodeLike | undefined, visit: (node: HierarchyNodeLike) => void): void {
  if (!node) {
    return;
  }
  visit(node);
  for (const child of nodeChildren(node)) {
    walk(child, visit);
  }
}

function collectText(node: HierarchyNodeLike): string[] {
  const out: string[] = [];
  walk(node, (current) => {
    const text = textOf(attrsOf(current));
    if (text) {
      out.push(text);
    }
  });
  return out;
}

function findNavigationTitle(root: HierarchyNodeLike | undefined): string | undefined {
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

function isTabBarButtonClass(cls: string | undefined): boolean {
  return cls === "UITabBarButton" || cls === "UIButton" || cls === "XCUIElementTypeButton";
}

function findSelectedTab(root: HierarchyNodeLike | undefined): string | undefined {
  let selectedTab: string | undefined;
  const walkForTab = (node: HierarchyNodeLike | undefined, inTabBar: boolean): void => {
    if (!node || selectedTab) {
      return;
    }
    const attrs = attrsOf(node);
    const cls = className(attrs);
    const role = asString(attrs["role"]);
    const nextInTabBar = inTabBar || cls === "UITabBar" || cls === "XCUIElementTypeTabBar";
    if (isTrue(attrs["selected"])) {
      const selectedByRole = role === "tab";
      const selectedByTabBarChild = nextInTabBar && isTabBarButtonClass(cls);
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
  root: HierarchyNodeLike | undefined,
): Pick<CandidateSignals, "modalClass" | "modalTitle"> {
  let modalNode: HierarchyNodeLike | undefined;
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

function findFocusedElementId(root: HierarchyNodeLike | undefined): string | undefined {
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

function hasKeyboard(root: HierarchyNodeLike | undefined): boolean {
  let keyboardVisible = false;
  walk(root, (node) => {
    if (keyboardVisible) {
      return;
    }
    const cls = className(attrsOf(node));
    keyboardVisible = isIosKeyboardClass(cls);
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
