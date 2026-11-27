import {
  nodeAttributes,
  type Hierarchy,
  type ViewHierarchyNode,
} from "../../../models/ViewHierarchyResult";
import type { ElementBounds } from "../../../models/ElementBounds";
import { parseBounds } from "../../../utils/bounds";
import type { ConvertibleNode } from "./types";

type SnapshotNode = Hierarchy | ViewHierarchyNode | ConvertibleNode;

/** An iPad window parked by Home (Windowed Apps) keeps a scaled card with this value (#18828). */
const STASHED_CARD_VALUE = "Stashed";

/** Stage Manager strip cards are under a tenth of the screen wide; switcher cards are far wider. */
const STRIP_CARD_MAX_WIDTH_FRACTION = 0.15;

function width(bounds: ElementBounds): number {
  return bounds.right - bounds.left;
}

function collectNode(node: SnapshotNode, contents: ElementBounds[], cards: ElementBounds[]): void {
  const attrs = nodeAttributes(node as ViewHierarchyNode);
  const identifier = attrs["resource-id"] ?? attrs.resourceId;
  const bounds = parseBounds(node.bounds ?? attrs.bounds);
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return;
  }
  if (identifier === "AppSwitcherContentView") {
    contents.push(bounds);
  } else if (
    typeof identifier === "string" &&
    identifier.startsWith("card:") &&
    attrs.value !== STASHED_CARD_VALUE
  ) {
    cards.push(bounds);
  }
}

/** A small Stage Manager strip card wholly inside the content view: no switcher is open. */
function showsStageManagerStrip(content: ElementBounds, cards: ElementBounds[]): boolean {
  return cards.some(
    (bounds) =>
      bounds.left >= content.left &&
      bounds.right <= content.right &&
      width(bounds) < width(content) * STRIP_CARD_MAX_WIDTH_FRACTION,
  );
}

/**
 * Mirrors CtrlProxy's AppSwitcherSnapshotClassifier: retained full-screen cards are not visible.
 * Stage Manager keeps an inset stage card and small strip cards, all scaled, while no switcher is
 * open. A strip card fully on screen means the switcher is not presented; opening it moves the
 * strip cards partly off screen and enlarges them (#19457). CtrlProxy's live-card rule is not
 * mirrored: the runner hierarchy sends `value` only for text inputs, so cards arrive without one.
 */
export function isIosAppSwitcherVisible(root: SnapshotNode | undefined): boolean {
  const contents: ElementBounds[] = [];
  const cards: ElementBounds[] = [];
  const pending: SnapshotNode[] = root ? [root] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    collectNode(node, contents, cards);
    if (node.node) {
      pending.push(...(Array.isArray(node.node) ? node.node : [node.node]));
    }
  }
  return contents.some(
    (content) =>
      !showsStageManagerStrip(content, cards) &&
      cards.some((bounds) => width(bounds) < width(content) * 0.9),
  );
}
