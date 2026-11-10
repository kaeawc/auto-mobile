/**
 * How FocusNavigate tells, across reads, whether a D-pad press moved focus (#17315, #17739).
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

/** Labels and bounds of everything outside the focused element, to tell a scroll from a value. */
function surroundingsKey(screen: Pick<FocusScreen, "focused" | "elements">): string {
  const { focused } = screen;
  return screen.elements
    .filter((element) => !focused || !boundsContain(focused.bounds, element.bounds))
    .map((element) => {
      const { left, top, right, bottom } = element.bounds;
      const label = `${stringProp(element, "text")}|${stringProp(element, "content-desc")}`;
      return `${label}@${left},${top},${right},${bottom}`;
    })
    .join("\n");
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
 * Keys focus across reads. A press that changes only the focused control's own label (a slider
 * announcing its new value) while it keeps its resource id, class and bounds and nothing else on
 * screen changes did not move focus (#17739): from then on the control is keyed without its
 * label. A fixed-slot recycler row keeps its bounds too, but the rows around it scroll and it
 * carries no resource id of its own (#17315), so it still reads as moving.
 */
interface ReadIdentity {
  position: string;
  surroundings: string;
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
    previous.surroundings === next.surroundings &&
    previous.label !== next.label
  );
}

export function createFocusIdentity() {
  const adjustable = new Set<string>();
  let previous: ReadIdentity | undefined;
  return (
    entry: FocusPathEntry | undefined,
    screen: Pick<FocusScreen, "focused" | "elements">,
  ): FocusIdentity => {
    if (!entry) {
      previous = undefined;
      return { key: "" };
    }
    const read = {
      position: positionKey(entry, screen.focused),
      surroundings: surroundingsKey(screen),
      label: focusKey(entry),
    };
    const before = previous;
    const inPlace = changedInPlace(before, read, entry);
    if (inPlace) {
      adjustable.add(read.position);
    }
    const key = adjustable.has(read.position) ? `adjustable|${read.position}` : read.label;
    previous = { ...read, key };
    return inPlace ? { key, replaces: before.key, changedInPlace: true } : { key };
  };
}
