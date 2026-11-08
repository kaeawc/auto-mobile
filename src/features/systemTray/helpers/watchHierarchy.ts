import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../models";
import { DefaultElementParser } from "../../utility/ElementParser";
import { isClickableElementProperties } from "../../utility/elementProperties";
import { matchesCtrlProxyResourceId, toSearchable } from "../../utility/SearchableNode";
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

/** The Wear app list, where the open swipe does nothing (#17443). */
export function isWatchAppList(hierarchy?: ViewHierarchyResult): boolean {
  const owned = wearOwnedNodes(hierarchy);
  return (
    !!hierarchy &&
    getHierarchyRoots(hierarchy)
      .flatMap(watchNodes)
      .some(
        (node) =>
          owned.has(node) &&
          matchesCtrlProxyResourceId(
            toSearchable(getNodeProperties(node) ?? {}).nativeId,
            "appsList",
          ),
      )
  );
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
  // The header is the app name and its sibling timestamp; neither is content. On Wear OS 7 the app
  // name, time, title and body are all siblings under the card, so the app's parent is not a header
  // (#17317). The app's parent is only dropped (not its descendants) when it is a wrapper below
  // the card.
  const parent = nodes.find((child) => getDirectChildNodes(child).includes(app));
  const siblings = parent ? getDirectChildNodes(parent) : [];
  const time = siblings[siblings.indexOf(app) + 1];
  const headerNodes = new Set([
    ...watchNodes(app),
    ...(time ? watchNodes(time) : []),
    ...(parent && parent !== node ? [parent] : []),
  ]);
  // An expanded card's Reply/Archive actions are clickable rows inside it, not its content.
  const actionNodes = new Set(
    nodes
      .filter(
        (child) => child !== node && isClickableElementProperties(getNodeProperties(child) ?? {}),
      )
      .flatMap(watchNodes),
  );
  const content = nodes
    .filter((child) => !headerNodes.has(child) && !actionNodes.has(child))
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
 * Where the stream is scrolled. Its collection node offers scroll_backward only once it has
 * scrolled away from the top; a capture without actions says nothing ("unknown").
 */
export function watchStreamScroll(hierarchy?: ViewHierarchyResult): "top" | "scrolled" | "unknown" {
  const root = watchStreamRoot(hierarchy);
  const actions = (root ? watchNodes(root) : [])
    .filter(
      (node) =>
        !isTrayContainer(node) && toSearchable(getNodeProperties(node) ?? {}).categories.scrollable,
    )
    .map((node) => getNodeProperties(node)?.actions);
  if (actions.length === 0 || !actions.every(Array.isArray)) {
    return "unknown";
  }
  return actions.some((list) => list.includes("scroll_backward")) ? "scrolled" : "top";
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
  const edges = watchCardClipEdges(hierarchy, card);
  return edges.top || edges.bottom;
}

/** Which viewport edges cut `card` off: a card taller than the viewport touches both. */
export function watchCardClipEdges(
  hierarchy: ViewHierarchyResult | undefined,
  card: WatchNotification,
): { top: boolean; bottom: boolean } {
  const root = watchStreamRoot(hierarchy);
  const viewport = root && new DefaultElementParser().parseNodeBounds(root)?.bounds;
  return {
    top: !!viewport && card.element.bounds.top <= viewport.top,
    bottom: !!viewport && card.element.bounds.bottom >= viewport.bottom,
  };
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
 * The cards expanded in place: clickable nodes with clickable rows inside them (Wear OS 7 shows a
 * card's Reply/Archive actions that way and keeps the stream root in the tree, #17317). Found by
 * structure, not by the card's header, which scrolls out of the capture while its actions are on
 * screen.
 */
function expandedCardNodes(hierarchy?: ViewHierarchyResult): ViewHierarchyNode[] {
  const root = watchStreamRoot(hierarchy);
  const owned = wearOwnedNodes(hierarchy);
  const isClickable = (node: ViewHierarchyNode) =>
    isClickableElementProperties(getNodeProperties(node) ?? {});
  const expanded = (root ? watchNodes(root) : []).filter(
    (node) =>
      owned.has(node) &&
      isClickable(node) &&
      watchNodes(node).some((child) => child !== node && isClickable(child)),
  );
  return expanded.filter(
    (node) => !expanded.some((other) => other !== node && watchNodes(other).includes(node)),
  );
}

export function watchHasExpandedCard(hierarchy?: ViewHierarchyResult): boolean {
  return expandedCardNodes(hierarchy).length > 0;
}

/**
 * The clickable target labelled `text` after a card was tapped. Wear OS 7 expands the card in
 * place, so the search stays inside the one expanded card and an identical label on another card
 * is never tapped. Without a readable stream, only a changed Wear SystemUI tree with an explicit
 * clickable text target is actionable. No implicit content intents, reply fields or alert layouts
 * are inferred here.
 */
export function watchExpandedTarget(
  hierarchy: ViewHierarchyResult | undefined,
  text: string,
): Element | undefined {
  if (!hierarchy) {
    return undefined;
  }
  if (watchStreamRoot(hierarchy)) {
    const cards = expandedCardNodes(hierarchy);
    return cards.length === 1 ? uniqueTarget(cards[0], text) : undefined;
  }
  const owned = wearOwnedNodes(hierarchy);
  const targets = getHierarchyRoots(hierarchy)
    .filter((root) => owned.has(root))
    .map((root) => uniqueTarget(root, text))
    .filter((element): element is Element => element !== undefined);
  return targets.length === 1 ? targets[0] : undefined;
}

function uniqueTarget(root: ViewHierarchyNode, text: string): Element | undefined {
  const result = new ResolverElementSelector().select(
    createSubHierarchy(root),
    { text },
    { ...ignoreCasePolicy(false) },
  );
  return result.totalMatches === 1 ? (result.element ?? undefined) : undefined;
}
