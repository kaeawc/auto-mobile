import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { Element } from "../../models/Element";
import { isTruthy } from "../../models/Element";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../utils/androidPackageName";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { chooserRowPackages } from "../utility/chooserAppMetadata";
import { searchableNativeId } from "../utility/SearchableNode";
import type { ShareRow } from "./ShareTarget";

const INTENT_RESOLVER = "com.android.intentresolver";
const HOSTS = new Set(["android", INTENT_RESOLVER]);
const SUGGESTED_APPS_ID = `${INTENT_RESOLVER}:id/suggested_apps_container`;
const ACTION_IDS = new Set([
  "android:id/chooser_copy_button",
  `${INTENT_RESOLVER}:id/copy`,
  `${INTENT_RESOLVER}:id/reselection_action`,
]);

interface AndroidShareRow extends ShareRow {
  primaryLabel?: string;
  /** In the intentresolver suggested-apps row, which repeats targets from the full app list. */
  suggested?: boolean;
  /**
   * The accessibility collection index of the list item holding the row (`row:column`), from the
   * row itself or its nearest indexed ancestor. The index belongs to the adapter position, so it
   * survives a scroll: it identifies a row across pages without measuring other rows (#19099).
   */
  listPosition?: string;
}

interface AndroidShareSheet {
  sheetKind: "android-intentresolver" | "android-legacy";
  rows: AndroidShareRow[];
  list: Element;
  /** The drag handle header while the sheet is collapsed and can still expand. */
  collapsedHandle?: Element;
}

type Properties = {
  actions?: unknown;
  "resource-id"?: string;
  "content-desc"?: string;
  "visible-to-user"?: boolean | string;
  "long-clickable"?: boolean | string;
  package?: string;
  packageName?: string;
  clickable?: boolean | string;
  enabled?: boolean | string;
  text?: string;
  "collection-row-index"?: number | string;
  "collection-column-index"?: number | string;
};

function isHidden(value: Properties["visible-to-user"]): boolean {
  return value === false || value === "false";
}

function collectionIndex(value: number | string | undefined): number | undefined {
  const index = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

function collectionPosition(properties: Properties): string | undefined {
  const row = collectionIndex(properties["collection-row-index"]);
  return row === undefined
    ? undefined
    : `${row}:${collectionIndex(properties["collection-column-index"]) ?? 0}`;
}

function nodeLabel(properties: Properties): string | undefined {
  return properties.text?.trim() || properties["content-desc"]?.trim() || undefined;
}

export function extractAndroidShareSheet(
  hierarchy: ViewHierarchyResult,
  parser: ElementParser,
): AndroidShareSheet | undefined {
  const host = hierarchy.packageName;
  if (!host || !HOSTS.has(host)) {
    return;
  }

  for (const root of parser.extractRootNodes(hierarchy)) {
    let header: ViewHierarchyNode | undefined;
    let expandable = false;
    let list: ViewHierarchyNode | undefined;
    let alwaysOrOnce = false;
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const properties: Properties = parser.extractNodeProperties(node);
      if (isHidden(properties["visible-to-user"])) {
        return;
      }
      switch (searchableNativeId(properties)) {
        case "android:id/chooser_header":
          header = node;
          break;
        case "android:id/contentPanel":
          // The drawer layout offers "expand" only while collapsed.
          expandable = Array.isArray(properties.actions) && properties.actions.includes("expand");
          break;
        case "android:id/resolver_list":
          list = node;
          break;
        case "android:id/button_always":
        case "android:id/button_once":
          alwaysOrOnce = true;
          break;
      }
    });
    // ACTION_VIEW also has a resolver_list, but uses the resolver button bar instead of
    // the sharesheet header.
    if (header && list && !alwaysOrOnce) {
      const listElement = parser.parseNodeBounds(list);
      const handle = expandable ? parser.parseNodeBounds(header) : null;
      if (listElement) {
        return {
          sheetKind: host === INTENT_RESOLVER ? "android-intentresolver" : "android-legacy",
          rows: extractRows(root, list, host, parser),
          list: listElement,
          ...(handle ? { collapsedHandle: handle } : {}),
        };
      }
    }
  }
}

/**
 * Follows a depth-first traversal and reports whether the current node sits below the nearest
 * container with `containerId`.
 */
function insideContainer(containerId: string) {
  let containerDepth = Infinity;
  return (id: string | undefined, depth: number): boolean => {
    if (depth <= containerDepth) {
      containerDepth = id === containerId ? depth : Infinity;
    }
    return depth > containerDepth;
  };
}

/**
 * Follows a depth-first traversal inside the list and returns the collection position of the
 * current node, or of its nearest indexed ancestor.
 */
function collectionPositions() {
  const positions: Array<string | undefined> = [];
  return (properties: Properties, depth: number, inList: boolean): string | undefined => {
    positions.length = depth;
    positions[depth] = inList
      ? (collectionPosition(properties) ?? positions[depth - 1])
      : undefined;
    return positions[depth];
  };
}

/** Actions are neither suggested apps nor list items, so they carry neither trait. */
function withListTraits(
  row: AndroidShareRow,
  { isAction, suggested, position }: { isAction: boolean; suggested: boolean; position?: string },
): AndroidShareRow {
  return isAction
    ? row
    : {
        ...row,
        ...(suggested ? { suggested: true } : {}),
        ...(position === undefined ? {} : { listPosition: position }),
      };
}

function extractRows(
  root: ViewHierarchyNode,
  list: ViewHierarchyNode,
  host: string,
  parser: ElementParser,
): AndroidShareRow[] {
  const rows: AndroidShareRow[] = [];
  let listDepth = Infinity;
  const inActionRow = insideContainer("android:id/chooser_action_row");
  const inSuggestedApps = insideContainer(SUGGESTED_APPS_ID);
  const positionAt = collectionPositions();
  let skipDepth = Infinity;
  parser.traverseNode(root, (node: ViewHierarchyNode, depth: number) => {
    if (depth > skipDepth) {
      return;
    }
    skipDepth = Infinity;
    if (depth <= listDepth) {
      listDepth = node === list ? depth : Infinity;
    }
    const properties: Properties = parser.extractNodeProperties(node);
    if (isHidden(properties["visible-to-user"])) {
      skipDepth = depth;
      return;
    }
    const inList = listDepth !== Infinity;
    const position = positionAt(properties, depth, inList);
    const id = searchableNativeId(properties);
    const actionRow = inActionRow(id, depth);
    const suggested = inSuggestedApps(id, depth);
    if (!isTruthy(properties.clickable)) {
      return;
    }
    const scope = { host, inList, depthInList: depth - listDepth };
    const isAction = actionRow || ACTION_IDS.has(id ?? "");
    const row = isAction
      ? extractActionRow(node, properties, parser)
      : extractTargetRow(node, properties, scope, parser);
    if (row) {
      rows.push(withListTraits(row, { isAction, suggested, position }));
      skipDepth = depth;
    }
  });
  return rows;
}

function extractActionRow(
  node: ViewHierarchyNode,
  properties: Properties,
  parser: ElementParser,
): AndroidShareRow | undefined {
  const label = nodeLabel(properties);
  const element = extractRowElement(node, parser);
  if (label && element) {
    return { target: { label, kind: "action" }, element };
  }
}

function extractRowElement(node: ViewHierarchyNode, parser: ElementParser): Element | undefined {
  const element = parser.parseNodeBounds(node);
  if (
    element &&
    !isHidden(element.enabled) &&
    element.bounds.bottom > element.bounds.top &&
    element.bounds.right > element.bounds.left
  ) {
    return element;
  }
}

function extractTargetRow(
  node: ViewHierarchyNode,
  properties: Properties,
  { host, inList, depthInList }: { host: string; inList: boolean; depthInList: number },
  parser: ElementParser,
): AndroidShareRow | undefined {
  if (!inList) {
    return;
  }
  const element = extractRowElement(node, parser);
  if (!element) {
    return;
  }
  const direct =
    host === INTENT_RESOLVER
      ? depthInList >= 3 // Direct Share adds a wrapper around the regular grid row.
      : !isTruthy(properties["long-clickable"]); // The legacy chooser only adds the menu to app rows.
  let primaryLabel: string | undefined;
  let secondaryLabel: string | undefined;
  const packages = new Set<string>();
  parser.traverseNode(node, (child: ViewHierarchyNode) => {
    const properties: Properties = parser.extractNodeProperties(child);
    if (isHidden(properties["visible-to-user"])) {
      return;
    }
    const nativeId = searchableNativeId(properties);
    if (nativeId === "android:id/text1") {
      primaryLabel = nodeLabel(properties);
    } else if (nativeId === "android:id/text2") {
      secondaryLabel = nodeLabel(properties);
    }
    for (const appId of chooserRowPackages(properties, host)) {
      if (ANDROID_PACKAGE_NAME_PATTERN.test(appId)) {
        packages.add(appId);
      }
    }
  });
  // Chooser placeholders have clickable icon cells without a text1 label.
  if (!primaryLabel) {
    return;
  }
  const appId = packages.size === 1 ? [...packages][0] : undefined;
  return {
    primaryLabel,
    element,
    target: {
      label: secondaryLabel ?? primaryLabel,
      ...(appId === undefined ? {} : { appId }),
      kind: direct ? "direct" : "app",
    },
  };
}
