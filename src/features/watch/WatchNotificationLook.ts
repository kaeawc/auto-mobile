import type { Timer } from "../../utils/SystemTimer";
import {
  isWatchTapElement,
  visibleWatchChildren,
  type WatchHierarchy,
  type WatchHierarchyNode,
} from "./WatchHierarchy";

const ALERT_CLASS = "XCUIElementType(7)";
const STATIC_TEXT_CLASS = "XCUIElementType(48)";
const IMAGE_CLASS = "XCUIElementType(43)";

/**
 * How long observe and tapOn wait for a notification short look to expand into its long look. On
 * a watchOS 27.2 simulator the short look lasted about 0.6 s before the long look replaced it.
 */
export const WATCH_SHORT_LOOK_SETTLE_MS = 2000;
const WATCH_SHORT_LOOK_POLL_MS = 150;

function alerts(node: WatchHierarchyNode): WatchHierarchyNode[] {
  const children = visibleWatchChildren(node);
  return node.className === ALERT_CLASS ? [node] : children.flatMap(alerts);
}

function intersectsScreen(node: WatchHierarchyNode, hierarchy: WatchHierarchy): boolean {
  const { left, top, right, bottom } = node.bounds;
  return (
    right > left &&
    bottom > top &&
    right > 0 &&
    bottom > 0 &&
    left < hierarchy.screenWidth &&
    top < hierarchy.screenHeight
  );
}

function descendants(node: WatchHierarchyNode): WatchHierarchyNode[] {
  return visibleWatchChildren(node).flatMap((child) => [child, ...descendants(child)]);
}

/** Static text or a control: the status-bar alert (clock, icons) has neither. */
function isLookContent(node: WatchHierarchyNode): boolean {
  return (
    isWatchTapElement(node) || (node.className === STATIC_TEXT_CLASS && !!node.accessibilityLabel)
  );
}

/**
 * A compact banner puts the title beside the app icon; the short look stacks it under a large icon.
 * A banner does not expand into a long look on its own (a tap on it opens the long look).
 */
function isBanner(nodes: readonly WatchHierarchyNode[]): boolean {
  const icons = nodes.filter((node) => node.className === IMAGE_CLASS);
  return nodes.some(
    (text) =>
      text.className === STATIC_TEXT_CLASS &&
      !!text.accessibilityLabel &&
      icons.some(
        ({ bounds: icon }) =>
          text.bounds.left >= icon.right &&
          text.bounds.top < icon.bottom &&
          text.bounds.bottom > icon.top,
      ),
  );
}

function isShortLook(alert: WatchHierarchyNode, hierarchy: WatchHierarchy): boolean {
  const nodes = descendants(alert);
  const content = nodes.filter(isLookContent);
  return (
    content.length > 0 &&
    !content.some((node) => isWatchTapElement(node) && intersectsScreen(node, hierarchy)) &&
    !isBanner(nodes)
  );
}

/**
 * Whether the runner reports a system alert with content: the permission prompt or a notification
 * look, not the status-bar alert that can accompany them.
 */
export function hasWatchSystemAlert(hierarchy: WatchHierarchy): boolean {
  return alerts(hierarchy.root).some((alert) => descendants(alert).some(isLookContent));
}

/**
 * A notification short look: a system alert with text or controls but no control on screen, whose
 * title sits under the app icon. The short look shows the app icon, title and body only (watchOS 27
 * adds a Close and Manage Notifications toolbar below the screen); the long look that replaces it
 * shows the action buttons. The permission prompt and a long look without actions both have a
 * control at least partly on screen, the status-bar alert has neither text nor controls, and a
 * compact banner puts its title beside the icon.
 */
export function isWatchNotificationShortLook(hierarchy: WatchHierarchy): boolean {
  return alerts(hierarchy.root).some((alert) => isShortLook(alert, hierarchy));
}

/**
 * Read the runner hierarchy, re-reading while a notification short look is up until its long look
 * (with the action buttons) replaces it or {@link WATCH_SHORT_LOOK_SETTLE_MS} elapses. A failed
 * re-read propagates: the look changed, so the earlier short look no longer describes the screen.
 */
export async function readSettledWatchHierarchy(
  read: () => Promise<WatchHierarchy>,
  timer: Timer,
  signal?: AbortSignal,
): Promise<WatchHierarchy> {
  let hierarchy = await read();
  const deadline = timer.now() + WATCH_SHORT_LOOK_SETTLE_MS;
  while (isWatchNotificationShortLook(hierarchy)) {
    const remaining = deadline - timer.now();
    if (remaining <= 0) {
      return hierarchy;
    }
    await timer.sleep(Math.min(WATCH_SHORT_LOOK_POLL_MS, remaining));
    signal?.throwIfAborted();
    hierarchy = await read();
  }
  return hierarchy;
}
