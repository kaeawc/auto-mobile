/**
 * Finding a focus target that is not composed yet (#18027). A lazily composed row (a Compose
 * `LazyRow`, a Leanback rail) only holds the cards on screen, so a card further along it is in no
 * read until focus scrolls the row. When the target is absent, the row whose labels have as many
 * words as the target's and share all of them but the last ("Trending card 1" for "Trending card
 * 8") is the row to search: focus moves into it and along it, and never leaves it for an unrelated row.
 */

import type { Element } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import { normalize } from "../utility/ElementResolverMatching";
import { stringProp } from "./FocusNavigateMatching";
import type { FocusNavigateTarget, FocusPathEntry } from "./FocusNavigate";
import type { FocusNavigateDirection } from "./FocusNavigateDirections";
import { describeEntry } from "./FocusTrapMessage";

/** The on-screen elements whose labels resemble an absent target, and the shared label prefix. */
export interface FocusRowAnchor {
  elements: Element[];
  /** The words every anchor label shares with the target, as the first anchor spells them. */
  name: string;
}

/** The directions that search a row, in order: further along it, then back toward its start. */
export const FOCUS_ROW_SEARCH_DIRECTIONS = [
  "right",
  "left",
] as const satisfies readonly FocusNavigateDirection[];

function words(value: string): string[] {
  const normalized = normalize(value);
  return normalized ? normalized.split(" ") : [];
}

function commonLeadingWords(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  const index = Array.from({ length: limit }, (_, i) => i).find((i) => a[i] !== b[i]);
  return index ?? limit;
}

function elementLabel(element: Element): string {
  return stringProp(element, "text") || stringProp(element, "content-desc");
}

/** The label a target names, if it names one. */
export function targetLabel(target: FocusNavigateTarget): string | undefined {
  return target.label ?? target.text ?? target.contentDesc;
}

/**
 * The elements whose label has as many words as the target's and shares all but its last word: the
 * other cards of its row. A row header ("Featured" for "Featured 02") is not one, and a one-word
 * label has no row prefix, so it has no anchor. Only a horizontal row counts: at least two such
 * cards side by side and none stacked above another. A vertical list already continues downward,
 * and a grid has no single row to stay in.
 */
export function findRowAnchor(
  elements: readonly Element[],
  target: FocusNavigateTarget,
): FocusRowAnchor | undefined {
  const label = targetLabel(target);
  const wanted = label ? words(label) : [];
  const needed = wanted.length - 1;
  if (needed < 1) {
    return undefined;
  }
  const anchors = elements.filter((element) => {
    const label = words(elementLabel(element));
    return label.length === wanted.length && commonLeadingWords(label, wanted) === needed;
  });
  if (!isHorizontalRow(anchors)) {
    return undefined;
  }
  const name = elementLabel(anchors[0]).trim().split(/\s+/).slice(0, needed).join(" ");
  return { elements: anchors, name };
}

function sharesBand(a: ElementBounds, b: ElementBounds): boolean {
  return Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

function isHorizontalRow(elements: readonly Element[]): boolean {
  const pairs = elements.flatMap((a, i) => elements.slice(i + 1).map((b) => [a, b] as const));
  return pairs.length > 0 && pairs.every(([a, b]) => sharesBand(a.bounds, b.bounds));
}

/** Whether the focused element sits in the anchor's row: it shares a band with an anchor. */
export function isInRow(focused: Element, anchor: FocusRowAnchor): boolean {
  return anchor.elements.some((element) => sharesBand(element.bounds, focused.bounds));
}

/**
 * The row sweep: right until a right press leaves focus where it was, then left until a left press
 * does; undefined once both ends refused. A sweep, not per-card memory, because a scrolling row
 * moves every card, so a card revisited on the way back reads as a new element.
 */
export function createRowSearch(): (
  refused: ReadonlySet<FocusNavigateDirection>,
) => FocusNavigateDirection | undefined {
  let phase = 0;
  return (refused) => {
    while (
      phase < FOCUS_ROW_SEARCH_DIRECTIONS.length &&
      refused.has(FOCUS_ROW_SEARCH_DIRECTIONS[phase])
    ) {
      phase += 1;
    }
    return FOCUS_ROW_SEARCH_DIRECTIONS[phase];
  };
}

function describeTarget(target: FocusNavigateTarget): string {
  const label = targetLabel(target);
  if (label) {
    return JSON.stringify(label);
  }
  const id = target.elementId ?? target.resourceId;
  return id ? `id=${id}` : "The target";
}

/**
 * Why a walk whose target was in no read stopped: the row searched (or that none resembled the
 * target), where focus ended, and what to try next. `inRow` says focus ended in that row.
 */
export function notOnScreenMessage(
  target: FocusNavigateTarget,
  row: FocusRowAnchor | undefined,
  inRow: boolean,
  focusedElement: FocusPathEntry | undefined,
): string {
  const subject = `${describeTarget(target)} was not on screen in any read`;
  const ended = focusedElement
    ? `; focus ended on${describeEntry(focusedElement)}`
    : "; nothing had focus";
  if (!row) {
    return (
      `${subject} and no on-screen row holds labels like it, so the walk pressed down until ` +
      `focus stopped moving${ended}. If it sits further along a row, move focus into that row and call ` +
      `focusNavigate with direction "right"`
    );
  }
  const rowName = `the row of ${JSON.stringify(`${row.name} …`)} items`;
  return inRow
    ? `${subject}: D-pad right and left reached both ends of ${rowName} without it${ended}. ` +
        `Check the label, or scroll that row into view another way`
    : `${subject}, and focus could not reach ${rowName}, where it should be${ended}. Move focus ` +
        `into that row, then call focusNavigate with direction "right"`;
}
