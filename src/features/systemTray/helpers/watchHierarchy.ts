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

function isWearNode(node: ViewHierarchyNode): boolean {
  const props = getNodeProperties(node);
  return (props?.package ?? props?.packageName) === WEAR_SYSTEM_UI;
}

export function isWearHierarchy(hierarchy?: ViewHierarchyResult): boolean {
  return !!hierarchy && getHierarchyRoots(hierarchy).some(isWearNode);
}

export function watchStreamRoot(hierarchy?: ViewHierarchyResult): ViewHierarchyNode | undefined {
  return (
    hierarchy &&
    getHierarchyRoots(hierarchy)
      .flatMap(watchNodes)
      .find(
        (node) =>
          isWearNode(node) &&
          toSearchable(getNodeProperties(node) ?? {}).label === "Notifications" &&
          watchNodes(node).some((child) => {
            const props = getNodeProperties(child);
            const searchable = toSearchable(props ?? {});
            return (
              searchable.nativeId === `${WEAR_SYSTEM_UI}:id/trayview_container` &&
              searchable.categories.scrollable
            );
          }),
      )
  );
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
  const root = watchStreamRoot(hierarchy);
  if (!root) {
    return [];
  }
  return watchNodes(root)
    .filter(
      (node) => isWearNode(node) && isClickableElementProperties(getNodeProperties(node) ?? {}),
    )
    .map(readWatchCard)
    .filter((card): card is WatchNotification => card !== undefined);
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
  return (
    new ResolverElementSelector().select(
      createSubHierarchy(root),
      { text: "Clear all" },
      {
        ...ignoreCasePolicy(false),
      },
    ).element ?? undefined
  );
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
  const roots = getHierarchyRoots(hierarchy).filter(isWearNode);
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
