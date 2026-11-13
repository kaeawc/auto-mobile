/**
 * How FocusNavigate tells, across reads, whether a D-pad press moved focus (#17315, #17739, #17209).
 */

import type { Element } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import { boundsEqual, intersectBounds } from "../../utils/bounds";
import type { FocusPathEntry, FocusScreen } from "./FocusNavigate";
import { stringProp } from "./FocusNavigateMatching";

/**
 * The focused element's identity across presses. A recycler row can keep fixed bounds while the
 * list scrolls under it, so the contained label is part of the key: otherwise every press on such
 * a list reads as "focus did not move" (#17315).
 */
export function focusKey(entry: FocusPathEntry | undefined): string {
  if (!entry) {
    return "";
  }
  const { left, top, right, bottom } = entry.bounds;
  return [
    entry.resourceId ?? "",
    entry.text ?? "",
    entry.contentDesc ?? "",
    `${left},${top},${right},${bottom}`,
    entry.descendantLabel ?? "",
  ].join("|");
}

/** The focused control's place on screen, ignoring its label. */
function positionKey(entry: FocusPathEntry, focused: Element | null): string {
  const { left, top, right, bottom } = entry.bounds;
  return [entry.resourceId ?? "", focused?.class ?? "", `${left},${top},${right},${bottom}`].join(
    "|",
  );
}

function boundsText({ left, top, right, bottom }: ElementBounds): string {
  return `${left},${top},${right},${bottom}`;
}

/**
 * The screen around focus: where each node outside the focused element sits, and where each label
 * is shown, the focused element's own labels included.
 */
interface Surroundings {
  /** Each node's resource id and bounds outside the focused element, without labels. */
  layout: string;
  /** The nodes outside the focused element, in {@link layout}'s order, with their labels. */
  outside: readonly OutsideNode[];
  /**
   * Each non-empty label and the bounds it is shown at, on and outside the focused element. A
   * two-slot list leaves one row outside focus; a scroll moves that row's label onto the focused
   * row, so the focused labels must be compared too.
   */
  labels: ReadonlyMap<string, ReadonlySet<string>>;
}

interface OutsideNode {
  resourceId: string;
  label: string;
}

function labelOf(element: Element): string {
  return `${stringProp(element, "text")}|${stringProp(element, "content-desc")}`;
}

function readSurroundings(screen: Pick<FocusScreen, "focused" | "elements">): Surroundings {
  const { focused } = screen;
  const outside = screen.elements.filter(
    (element) => !focused || !boundsContain(focused.bounds, element.bounds),
  );
  const labels = new Map<string, Set<string>>();
  for (const element of focused ? [focused, ...screen.elements] : screen.elements) {
    const label = labelOf(element);
    if (label !== "|") {
      const shown = labels.get(label) ?? new Set<string>();
      shown.add(boundsText(element.bounds));
      labels.set(label, shown);
    }
  }
  return {
    layout: outside
      .map((element) => `${stringProp(element, "resource-id")}@${boundsText(element.bounds)}`)
      .join("\n"),
    outside: outside.map((element) => ({
      resourceId: stringProp(element, "resource-id"),
      label: labelOf(element),
    })),
    labels,
  };
}

/**
 * Whether the screen around focus stayed put. A scroll changes the layout, or shows a label that
 * was already on screen somewhere else (a fixed-slot list's rows shift by one slot). A value
 * readout beside a slider (`Slider Value: 51%`, a progress bar's description) keeps its node and
 * bounds and shows a value that was not on screen, so it does not count as the screen moving.
 */
function surroundingsStayed(before: Surroundings, after: Surroundings): boolean {
  if (before.layout !== after.layout) {
    return false;
  }
  return [...after.labels].every(([label, shown]) => {
    const previously = before.labels.get(label);
    return !previously || [...shown].every((bounds) => previously.has(bounds));
  });
}

/**
 * Whether the screen around focus shows the control changing a value, not a list paging under it
 * (#17773). Some node outside focus, other than a sibling sharing the control's resource id, must
 * show a new label at the same place (a value readout), and some other labelled node outside focus
 * must keep its label (the screen did not page). A one-slot recycler leaves nothing outside focus,
 * and a full repage changes every row, so neither gives that evidence and both read as moving.
 */
function showsValueChange(before: Surroundings, after: Surroundings, controlId: string): boolean {
  const pairs = after.outside.map((node, index) => ({ node, was: before.outside[index] }));
  const readout = pairs.some(
    ({ node, was }) =>
      was !== undefined && node.label !== was.label && node.resourceId !== controlId,
  );
  const anchor = pairs.some(({ node, was }) => node.label !== "|" && node.label === was?.label);
  return readout && anchor;
}

function boundsContain(outer: ElementBounds, inner: ElementBounds): boolean {
  const overlap = intersectBounds(outer, inner);
  return overlap !== null && boundsEqual(overlap, inner);
}

/** One read's focus identity for {@link FocusProgress}. */
export interface FocusIdentity {
  key: string;
  /** The key the previous read used for the same control, when its label changed in place. */
  replaces?: string;
  /** Whether the control's label changed since the previous read while it kept its place. */
  changedInPlace?: boolean;
}

/**
 * Keys focus across reads. A press that changes the focused control's own label (a slider
 * announcing its new value) while it keeps its resource id, class and bounds and the screen around
 * it stays put ({@link surroundingsStayed}) and shows the new value ({@link showsValueChange}) did
 * not move focus (#17739, #17773): from then on the control is keyed without its label. A fixed-slot recycler row keeps its bounds too, but the rows around
 * it shift (#17315), so it still reads as moving.
 */
interface ReadIdentity {
  position: string;
  surroundings: Surroundings;
  label: string;
  key: string;
}

function changedInPlace(
  previous: ReadIdentity | undefined,
  next: Omit<ReadIdentity, "key">,
  entry: FocusPathEntry,
): previous is ReadIdentity {
  return (
    previous !== undefined &&
    entry.resourceId !== undefined &&
    previous.position === next.position &&
    surroundingsStayed(previous.surroundings, next.surroundings) &&
    previous.label !== next.label &&
    showsValueChange(previous.surroundings, next.surroundings, entry.resourceId)
  );
}

/**
 * Whether the control's label went back to what it read two presses ago while it kept its place
 * and the screen around it stayed put both times (#17209): a press and its opposite toggled a
 * value (a slider with no readout on screen, so {@link showsValueChange} has no evidence). A
 * multi-slot list stepped down and back up shifts its rows on each press, so it fails
 * {@link surroundingsStayed} and still reads as moving.
 */
function toggledInPlace(
  older: ReadIdentity | undefined,
  previous: ReadIdentity | undefined,
  next: Omit<ReadIdentity, "key">,
  entry: FocusPathEntry,
): previous is ReadIdentity {
  return (
    older !== undefined &&
    previous !== undefined &&
    entry.resourceId !== undefined &&
    older.position === next.position &&
    previous.position === next.position &&
    older.label === next.label &&
    previous.label !== next.label &&
    surroundingsStayed(older.surroundings, previous.surroundings) &&
    surroundingsStayed(previous.surroundings, next.surroundings)
  );
}

export function createFocusIdentity() {
  const adjustable = new Set<string>();
  let older: ReadIdentity | undefined;
  let previous: ReadIdentity | undefined;
  return (
    entry: FocusPathEntry | undefined,
    screen: Pick<FocusScreen, "focused" | "elements">,
  ): FocusIdentity => {
    if (!entry) {
      older = undefined;
      previous = undefined;
      return { key: "" };
    }
    const read = {
      position: positionKey(entry, screen.focused),
      surroundings: readSurroundings(screen),
      label: focusKey(entry),
    };
    const before = previous;
    const inPlace =
      changedInPlace(before, read, entry) || toggledInPlace(older, before, read, entry);
    if (inPlace) {
      adjustable.add(read.position);
    }
    const key = adjustable.has(read.position) ? `adjustable|${read.position}` : read.label;
    // A refused press re-reads the same label; the toggle compares against the label before it.
    if (read.label !== before?.label) {
      older = previous;
    }
    previous = { ...read, key };
    return inPlace ? { key, replaces: before.key, changedInPlace: true } : { key };
  };
}
