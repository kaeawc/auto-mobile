import type { ViewHierarchyResult } from "../../models";
import { normalizeWatchHierarchy, type WatchHierarchyNode } from "./WatchHierarchy";
import { parseXcuiDebugDescription } from "./WatchXcuiDebugDescription";

/** The watch face app whose XCUI tree carries the Smart Stack. */
export const WATCH_CLOCK_FACE_BUNDLE_ID = "com.apple.clockface";
/** Element role given to a Smart Stack widget cell. */
export const SMART_STACK_WIDGET_ROLE = "widget";

const HEADER_ID = "Smart Stack Header";
const CELL_PREFIX = "StackCollectionView";
const WIDGET_CELL = "StackCollectionViewComplicationCell";
const FIELD_SEPARATOR = " -- ";

type Bounds = WatchHierarchyNode["bounds"];

/** The fields of a `StackCollectionViewComplicationCell -- …` identifier. */
export interface SmartStackWidgetIdentity {
  /** Per-cell UUID chosen by the face; stable while the widget stays on the stack. */
  cellId: string;
  appName: string;
  /** The widget's `configurationDisplayName`. */
  widgetName: string;
  hostBundleId: string;
  /** The raw trailing `<host>-<extension>-<kind>-<n>` field. */
  descriptor: string;
  /** The trailing `-<n>` of the descriptor. */
  index: number;
  /** Set only when the descriptor is `<host>-<host>.<suffix>-<kind>-<n>`. */
  extensionBundleId?: string;
  widgetKind?: string;
}

export interface SmartStackWidgetCard extends SmartStackWidgetIdentity {
  type: "widget";
  bounds: Bounds;
  /** The widget's own rendered text (StaticText labels), empty before its timeline renders. */
  texts: string[];
}

/** A system card such as `StackCollectionViewTriPlatterCell`, kept as a generic card. */
interface SmartStackSystemCard {
  type: "system";
  /** The cell kind with the `StackCollectionView` prefix removed, e.g. `TriPlatterCell`. */
  cellKind: string;
  bounds: Bounds;
  texts: string[];
}

export type SmartStackCard = SmartStackWidgetCard | SmartStackSystemCard;

interface SmartStackHeader {
  bounds: Bounds;
  /** Header button labels in order: the date, then the spoken time. */
  labels: string[];
}

export interface WatchSmartStack {
  header?: SmartStackHeader;
  /** Cards in hierarchy (top-to-bottom) order. */
  cards: SmartStackCard[];
}

interface WatchClockFaceObservation {
  hierarchy: ViewHierarchyResult;
  smartStack: WatchSmartStack;
}

function parseDescriptor(descriptor: string, hostBundleId: string) {
  const match = /^(.*)-(\d+)$/.exec(descriptor);
  if (!match) {
    return undefined;
  }
  const [, body, index] = match;
  const hostPrefix = `${hostBundleId}-`;
  const extension = body.startsWith(hostPrefix) ? body.slice(hostPrefix.length) : "";
  // An extension bundle id extends its host's, so the kind starts at the first "-" after that.
  const split = extension.startsWith(`${hostBundleId}.`) ? extension.indexOf("-") : -1;
  return {
    index: Number(index),
    ...(split > 0 && split < extension.length - 1
      ? { extensionBundleId: extension.slice(0, split), widgetKind: extension.slice(split + 1) }
      : {}),
  };
}

function splitNames(names: string[], appNameHint?: string): [string, string] {
  if (names.length > 2 && appNameHint) {
    const appParts = appNameHint.split(FIELD_SEPARATOR).length;
    if (names.slice(0, appParts).join(FIELD_SEPARATOR) === appNameHint && appParts < names.length) {
      return [appNameHint, names.slice(appParts).join(FIELD_SEPARATOR)];
    }
  }
  return [names[0], names.slice(1).join(FIELD_SEPARATOR)];
}

/**
 * Parse a widget cell identifier. The uuid, host bundle id and descriptor never hold " -- ", so the
 * fields are read from both ends; a " -- " inside the app or widget name is resolved with
 * `appNameHint` (the cell's app-name label) and otherwise kept in the widget name.
 */
export function parseSmartStackWidgetIdentifier(
  identifier: string,
  appNameHint?: string,
): SmartStackWidgetIdentity | undefined {
  const fields = identifier.split(FIELD_SEPARATOR);
  if (fields[0] !== WIDGET_CELL || fields.length < 6) {
    return undefined;
  }
  const [cellId, ...rest] = fields.slice(1);
  const descriptor = rest[rest.length - 1];
  const hostBundleId = rest[rest.length - 2];
  const parsed = parseDescriptor(descriptor, hostBundleId);
  if (!parsed) {
    return undefined;
  }
  const [appName, widgetName] = splitNames(rest.slice(0, -2), appNameHint);
  return { cellId, appName, widgetName, hostBundleId, descriptor, ...parsed };
}

function descendants(node: WatchHierarchyNode): WatchHierarchyNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...descendants(child)]);
}

function distinctLabels(nodes: WatchHierarchyNode[]): string[] {
  return [
    ...new Set(nodes.map((node) => node.accessibilityLabel).filter((label) => !!label)),
  ] as string[];
}

function toWidgetCard(cell: WatchHierarchyNode): SmartStackWidgetCard | undefined {
  const inner = descendants(cell);
  const appLabel = inner.find((node) => node.accessibilityLabel)?.accessibilityLabel ?? undefined;
  const identity = parseSmartStackWidgetIdentifier(cell.accessibilityIdentifier ?? "", appLabel);
  if (!identity) {
    return undefined;
  }
  const texts = distinctLabels(inner.filter((node) => node.className === "StaticText"));
  return { type: "widget", ...identity, bounds: cell.bounds, texts };
}

function toCard(cell: WatchHierarchyNode): SmartStackCard | undefined {
  const identifier = cell.accessibilityIdentifier ?? "";
  if (identifier.startsWith(`${WIDGET_CELL}${FIELD_SEPARATOR}`)) {
    return toWidgetCard(cell);
  }
  if (!identifier.startsWith(CELL_PREFIX) || identifier.includes(" ")) {
    return undefined;
  }
  return {
    type: "system",
    cellKind: identifier.slice(CELL_PREFIX.length),
    bounds: cell.bounds,
    texts: distinctLabels(descendants(cell)),
  };
}

function collectCells(root: WatchHierarchyNode) {
  return [root, ...descendants(root)]
    .filter((node) => node.className === "Cell")
    .map((cell) => ({ cell, card: toCard(cell) }));
}

function readHeader(root: WatchHierarchyNode): SmartStackHeader | undefined {
  const header = [root, ...descendants(root)].find(
    (node) => node.accessibilityIdentifier === HEADER_ID,
  );
  if (!header) {
    return undefined;
  }
  const buttons = (header.children ?? []).filter((node) => node.className === "Button");
  return { bounds: header.bounds, labels: distinctLabels(buttons) };
}

function toSmartStack(
  root: WatchHierarchyNode,
  cells: ReturnType<typeof collectCells>,
): WatchSmartStack {
  const header = readHeader(root);
  return {
    ...(header ? { header } : {}),
    cards: cells.flatMap(({ card }) => (card ? [card] : [])),
  };
}

/**
 * Parse a `com.apple.clockface` XCUI debugDescription dump into the watch observation hierarchy
 * (widget cells carry the `widget` role) and the typed Smart Stack cards.
 */
export function parseWatchClockFaceDump(
  dump: string,
  options: { timestamp: number },
): WatchClockFaceObservation {
  const tree = parseXcuiDebugDescription(dump, {
    bundleId: WATCH_CLOCK_FACE_BUNDLE_ID,
    timestamp: options.timestamp,
  });
  const cells = collectCells(tree.root);
  for (const { cell, card } of cells) {
    if (card?.type === "widget") {
      cell.role = SMART_STACK_WIDGET_ROLE;
    }
  }
  return { hierarchy: normalizeWatchHierarchy(tree), smartStack: toSmartStack(tree.root, cells) };
}
