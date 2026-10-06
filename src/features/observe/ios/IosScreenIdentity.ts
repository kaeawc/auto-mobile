import type { ScreenIdentity } from "../../../models/ObserveResult";
import { nodeAttributes, type ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import { parseBounds } from "../../../utils/bounds";

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

/** The screen's usable extent in points, or undefined when either side is not a positive finite number. */
export function usableScreenExtent(
  width: unknown,
  height: unknown,
): { width: number; height: number } | undefined {
  return typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : undefined;
}

/** Clip `[left, top, right, bottom]` to the screen; undefined when nothing of it is on screen. */
export function clipRectToScreen(
  rect: readonly [number, number, number, number],
  screen: { width: number; height: number },
): [number, number, number, number] | undefined {
  if (
    ![...rect, screen.width, screen.height].every(Number.isFinite) ||
    !usableScreenExtent(screen.width, screen.height)
  ) {
    return undefined;
  }
  const clipped: [number, number, number, number] = [
    Math.max(0, rect[0]),
    Math.max(0, rect[1]),
    Math.min(screen.width, rect[2]),
    Math.min(screen.height, rect[3]),
  ];
  return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : undefined;
}

// Ignore sub-two-point animation slivers; they do not constitute a usable software keyboard.
export const IOS_KEYBOARD_MIN_VISIBLE_HEIGHT = 2;

/** Whether a (possibly off-screen) keyboard rectangle has a usable visible part on screen. */
export function isVisibleIosKeyboardRect(
  rect: readonly [number, number, number, number],
  screen: { width: number; height: number },
): boolean {
  const clipped = clipRectToScreen(rect, screen);
  return clipped !== undefined && clipped[3] - clipped[1] >= IOS_KEYBOARD_MIN_VISIBLE_HEIGHT;
}

function keyboardNodeIsOnScreen(
  node: HierarchyNodeLike,
  screen: { width: number; height: number },
): boolean {
  const bounds = parseBounds(node["bounds"] ?? attrsOf(node)["bounds"]);
  // A keyboard node with no bounds cannot be shown parked, so it keeps the class-only reading.
  return (
    !bounds ||
    isVisibleIosKeyboardRect([bounds.left, bounds.top, bounds.right, bounds.bottom], screen)
  );
}

/**
 * The one definition of "the iOS soft keyboard is visible": a keyboard
 * container or keycap is present AND its frame has a non-empty part, at least
 * {@link IOS_KEYBOARD_MIN_VISIBLE_HEIGHT} tall, within the screen. A keyboard
 * parked below the bottom edge (a hardware-keyboard minimize) keeps its
 * `UIKeyboard` node but is not visible. Without a usable screen size the
 * class-only reading is kept. Shared by the screen identity, the skeleton
 * `keyboard` / `<ime>` row (which applies the same clip to its measured union)
 * and the diff's keyboard collapse so they cannot disagree.
 */
export function isIosKeyboardVisible(
  viewHierarchy: ViewHierarchyResult | undefined,
  fallbackScreen?: { width?: number; height?: number },
): boolean {
  const screen =
    usableScreenExtent(viewHierarchy?.screenWidth, viewHierarchy?.screenHeight) ??
    usableScreenExtent(fallbackScreen?.width, fallbackScreen?.height);
  let visible = false;
  walk(rootNode(viewHierarchy), (node) => {
    if (visible || !isIosKeyboardClass(className(attrsOf(node)))) {
      return;
    }
    visible = !screen || keyboardNodeIsOnScreen(node, screen);
  });
  return visible;
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
    keyboardVisible: isIosKeyboardVisible(viewHierarchy) || undefined,
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
