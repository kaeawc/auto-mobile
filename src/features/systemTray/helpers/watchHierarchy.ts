import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../models";
import { DefaultElementParser } from "../../utility/ElementParser";
import { isClickableElementProperties } from "../../utility/elementProperties";
import { toSearchable } from "../../utility/SearchableNode";
import { ResolverElementSelector } from "../../utility/ResolverElementSelector";
import { ignoreCasePolicy, INSPECT_INTENT } from "../../utility/SelectionPolicy";
import { getHierarchyRoots, getNodeProperties } from "../notificationHints";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import { createSubHierarchy, getDirectChildNodes } from "./hierarchy";

export const WEAR_SYSTEM_UI = "com.google.android.clockwork.sysui";

export function watchNodes(root: ViewHierarchyNode): ViewHierarchyNode[] {
  return [root, ...getDirectChildNodes(root).flatMap(watchNodes)];
}

function ownPackage(node: ViewHierarchyNode): string | undefined {
  const props = getNodeProperties(node);
  const pkg = props?.package ?? props?.packageName;
  return typeof pkg === "string" && pkg.length > 0 ? pkg : undefined;
}

/**
 * Every node owned by Wear SystemUI. A uiautomator dump stamps `package` on each node, but a
 * CtrlProxy capture carries none: a node inherits its window's `packageName`, then the capture's
 * (#17222). An explicit node package always wins, so a foreign subtree is never claimed.
 */
function wearOwnedNodes(hierarchy?: ViewHierarchyResult): Set<ViewHierarchyNode> {
  const owned = new Set<ViewHierarchyNode>();
  if (!hierarchy) {
    return owned;
  }
  const windowPackages = new Map(
    (hierarchy.windows ?? []).flatMap((window) =>
      window.id !== undefined && window.packageName ? [[window.id, window.packageName]] : [],
    ),
  );
  const visit = (node: ViewHierarchyNode, inherited: string | undefined): void => {
    const windowId = getNodeProperties(node)?.windowId;
    const owner =
      ownPackage(node) ??
      (typeof windowId === "number" ? windowPackages.get(windowId) : undefined) ??
      inherited;
    if (owner === WEAR_SYSTEM_UI) {
      owned.add(node);
    }
    for (const child of getDirectChildNodes(node)) {
      visit(child, owner);
    }
  };
  for (const root of getHierarchyRoots(hierarchy)) {
    visit(root, hierarchy.packageName);
  }
  return owned;
}

export function isWearHierarchy(hierarchy?: ViewHierarchyResult): boolean {
  const owned = wearOwnedNodes(hierarchy);
  return !!hierarchy && getHierarchyRoots(hierarchy).some((root) => owned.has(root));
}

const isTrayContainer = (node: ViewHierarchyNode): boolean => {
  const searchable = toSearchable(getNodeProperties(node) ?? {});
  return (
    searchable.nativeId === `${WEAR_SYSTEM_UI}:id/trayview_container` &&
    searchable.categories.scrollable
  );
};

function findStreamRoot(
  hierarchy: ViewHierarchyResult | undefined,
  owned: Set<ViewHierarchyNode>,
): ViewHierarchyNode | undefined {
  return (
    hierarchy &&
    getHierarchyRoots(hierarchy)
      .flatMap(watchNodes)
      .find(
        (node) =>
          owned.has(node) &&
          toSearchable(getNodeProperties(node) ?? {}).label === "Notifications" &&
          watchNodes(node).some(isTrayContainer),
      )
  );
}

export function watchStreamRoot(hierarchy?: ViewHierarchyResult): ViewHierarchyNode | undefined {
  return findStreamRoot(hierarchy, wearOwnedNodes(hierarchy));
}

export interface WatchNotification {
  appLabel: string;
  title: string | null;
  body: string | null;
  texts: string[];
  element: Element;
  node: ViewHierarchyNode;
}

function readWatchCard(node: ViewHierarchyNode): WatchNotification | undefined {
  const nodes = watchNodes(node);
  const app = nodes.find(
    (child) => toSearchable(getNodeProperties(child) ?? {}).nativeId === "full_view_app_name",
  );
  const element = new DefaultElementParser().parseNodeBounds(node);
  if (!app || !element) {
    return undefined;
  }
  // The captured header contains the app name and its sibling timestamp. Neither is content.
  const header = nodes.find((child) => getDirectChildNodes(child).includes(app));
  const headerNodes = new Set(header ? watchNodes(header) : [app]);
  const content = nodes
    .filter((child) => !headerNodes.has(child))
    .map((child) => toSearchable(getNodeProperties(child) ?? {}).shownText)
    .filter((text): text is string => !!text);
  return {
    appLabel: toSearchable(getNodeProperties(app) ?? {}).shownText ?? "",
    title: content[0] ?? null,
    body: content.slice(1).join("\n") || null,
    texts: nodes
      .map((child) => toSearchable(getNodeProperties(child) ?? {}).shownText)
      .filter((text): text is string => !!text),
    element,
    node,
  };
}

export function watchNotifications(hierarchy?: ViewHierarchyResult): WatchNotification[] {
  const owned = wearOwnedNodes(hierarchy);
  const root = findStreamRoot(hierarchy, owned);
  if (!root) {
    return [];
  }
  return watchNodes(root)
    .filter(
      (node) => owned.has(node) && isClickableElementProperties(getNodeProperties(node) ?? {}),
    )
    .map(readWatchCard)
    .filter((card): card is WatchNotification => card !== undefined);
}

/**
 * Whether the stream's viewport cuts `card` off at its top or bottom edge. The visible slice of a
 * clipped card is not its true extent (the bounds shrink and the row sits under the screen edge),
 * so a swipe aimed at its centre can miss it or leave the stream (#17331).
 */
export function watchCardClipped(
  hierarchy: ViewHierarchyResult | undefined,
  card: WatchNotification,
): boolean {
  const root = watchStreamRoot(hierarchy);
  const viewport = root && new DefaultElementParser().parseNodeBounds(root)?.bounds;
  return (
    !!viewport &&
    (card.element.bounds.top <= viewport.top || card.element.bounds.bottom >= viewport.bottom)
  );
}

/** A copy of the stream with every notification card subtree removed. */
function withoutCards(node: ViewHierarchyNode, cards: Set<ViewHierarchyNode>): ViewHierarchyNode {
  return {
    ...node,
    node: getDirectChildNodes(node)
      .filter((child) => !cards.has(child))
      .map((child) => withoutCards(child, cards)),
  };
}

export function watchCardMatches(
  card: WatchNotification,
  criteria: SystemTrayNotificationArgs,
  appLabel: string | undefined,
): boolean {
  if (criteria.appId && card.appLabel !== appLabel) {
    return false;
  }
  const selector = new ResolverElementSelector();
  return [criteria.title, criteria.body].every(
    (text) =>
      !text ||
      selector.select(
        createSubHierarchy(card.node),
        { text },
        { ...ignoreCasePolicy(true), ...INSPECT_INTENT },
      ).totalMatches > 0,
  );
}

/** Clear all belongs to the stream, never to an app's expanded content. */
export function watchClearAll(hierarchy?: ViewHierarchyResult): Element | undefined {
  const root = watchStreamRoot(hierarchy);
  if (!root) {
    return undefined;
  }
  // A card titled "Clear all" must never stand in for the stream footer.
  const cards = new Set(watchNotifications(hierarchy).map((card) => card.node));
  return (
    new ResolverElementSelector().select(
      createSubHierarchy(withoutCards(root, cards)),
      { text: "Clear all" },
      {
        ...ignoreCasePolicy(false),
      },
    ).element ?? undefined
  );
}

/**
 * The dismiss (X) button a swipe revealed beside `card`. Wear OS 7 only reveals the X and settings
 * buttons on a horizontal swipe, so the card is gone only once the X is tapped. The button must
 * share the swiped card's row, so another card's revealed buttons are never tapped.
 */
export function watchRevealedDismiss(
  hierarchy: ViewHierarchyResult | undefined,
  card: WatchNotification,
): Element | undefined {
  const root = watchStreamRoot(hierarchy);
  if (!root) {
    return undefined;
  }
  const owned = wearOwnedNodes(hierarchy);
  const parser = new DefaultElementParser();
  const rowTop = card.element.bounds.top;
  const rowBottom = card.element.bounds.bottom;
  const buttons = watchNodes(root)
    .filter(
      (node) =>
        owned.has(node) &&
        (toSearchable(getNodeProperties(node) ?? {}).nativeId ?? "").endsWith(
          ":id/notification_str_clear_button",
        ) &&
        isClickableElementProperties(getNodeProperties(node) ?? {}),
    )
    .flatMap((node) => parser.parseNodeBounds(node) ?? [])
    .filter(({ bounds }) => bounds.top < rowBottom && bounds.bottom > rowTop);
  return buttons.length === 1 ? buttons[0] : undefined;
}

/**
 * Narrow expanded-state hook: only a changed Wear SystemUI tree with an explicit clickable
 * text target is actionable. No expanded hierarchy has been captured; do not infer IDs,
 * coordinates, implicit content intents, reply fields or alert layouts here.
 */
export function watchExpandedTarget(
  hierarchy: ViewHierarchyResult | undefined,
  text: string,
): Element | undefined {
  if (!hierarchy || watchStreamRoot(hierarchy)) {
    return undefined;
  }
  const owned = wearOwnedNodes(hierarchy);
  const roots = getHierarchyRoots(hierarchy).filter((root) => owned.has(root));
  const targets = roots
    .map((root) =>
      new ResolverElementSelector().select(
        createSubHierarchy(root),
        { text },
        { ...ignoreCasePolicy(false) },
      ),
    )
    .filter((result) => result.totalMatches === 1 && result.element);
  return targets.length === 1 ? (targets[0].element ?? undefined) : undefined;
}
