/**
 * Bounded D-pad advance through a scrollable list (#17233).
 *
 * A focus-driven list (Android TV rails and vertical lists) scrolls only when focus moves past
 * its last visible row, so swiping it is not how a remote reveals more rows. This steers focus
 * into the container if it is elsewhere, then presses the list's direction until a row that was
 * not on screen appears inside it, and stops when focus stops moving, leaves the list, or a press
 * bound is reached. It only needs an
 * observer and a key presser, so it runs against fakes with no device and no real delay.
 */

import type { Element } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError } from "../../models/ActionableError";
import type {
  FocusKeyPresser,
  FocusNavigateDirection,
  FocusObserver,
  FocusScreen,
} from "./FocusNavigate";
import { directionToward, FOCUS_NAVIGATE_DEFAULT_SETTLE_MS } from "./FocusNavigate";

/**
 * Most presses one advance sends along the list: its visible rows plus a scroll, on a 1080p TV.
 * Steering focus into the list first has its own bound of the same size.
 */
export const FOCUS_LIST_ADVANCE_MAX_PRESSES = 12;

/** Consecutive presses that leave focus where it was before the list counts as exhausted. */
const FOCUS_LIST_ADVANCE_STUCK_PRESSES = 2;

const DIRECTION_KEYS = {
  up: "arrow_up",
  down: "arrow_down",
  left: "arrow_left",
  right: "arrow_right",
} as const satisfies Record<FocusNavigateDirection, string>;

/** The directions a list advances in: down a vertical list, right along a horizontal rail. */
export type FocusListAdvanceDirection = Extract<FocusNavigateDirection, "down" | "right">;

/** `not_entered`: focus moved but never reached the list within the entry bound. */
export type FocusListAdvanceStatus =
  | "revealed"
  | "stuck"
  | "left_list"
  | "not_entered"
  | "max_presses";

export interface FocusListAdvanceOptions {
  /** The scrollable container's bounds; rows count when their centre falls inside them. */
  container: ElementBounds;
  /** Defaults to the axis of the rows on the first read (see {@link listAdvanceDirection}). */
  direction?: FocusListAdvanceDirection;
  maxPresses?: number;
  settleMs?: number;
  signal?: AbortSignal;
}

export interface FocusListAdvanceResult {
  /** True when the advance revealed at least one row that was not on screen before it. */
  success: boolean;
  status: FocusListAdvanceStatus;
  direction: FocusListAdvanceDirection;
  /** D-pad presses sent. */
  presses: number;
  /** Identities of the rows that appeared, in hierarchy order. */
  revealed: string[];
  message?: string;
}

/**
 * The direction a list scrolls: the axis its visible rows are laid out along (rows stacked
 * vertically advance down, rows side by side advance right). Without two rows to compare, the
 * container's long axis decides, so a wide, short container is a horizontal rail.
 */
export function listAdvanceDirection(
  container: ElementBounds,
  rows: readonly Element[] = [],
): FocusListAdvanceDirection {
  const inside = topLevel(rows.filter((row) => withinList(row.bounds, container)));
  if (inside.length >= 2) {
    const xs = inside.map((row) => (row.bounds.left + row.bounds.right) / 2);
    const ys = inside.map((row) => (row.bounds.top + row.bounds.bottom) / 2);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    return spread(xs) > spread(ys) ? "right" : "down";
  }
  const width = container.right - container.left;
  const height = container.bottom - container.top;
  return width > height ? "right" : "down";
}

function contains(outer: ElementBounds, inner: ElementBounds): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom &&
    !sameBounds(outer, inner)
  );
}

/**
 * The row-level peers among `elements`: those no other element contains. A row's own labels and
 * icons sit inside it, so they never decide the axis (a 1000px row with a title at its left edge
 * and a price at its right is one row, not a horizontal pair).
 */
function topLevel(elements: readonly Element[]): Element[] {
  return elements.filter(
    (element) => !elements.some((other) => contains(other.bounds, element.bounds)),
  );
}

function text(element: Element, key: "text" | "content-desc" | "resource-id"): string {
  const value = element[key];
  return typeof value === "string" ? value : "";
}

/** A row's identity: what names it, never its bounds, which a recycled row reuses. */
export function rowIdentity(element: Element): string | null {
  const parts = [
    text(element, "resource-id"),
    text(element, "text"),
    text(element, "content-desc"),
  ];
  return parts.some((part) => part.length > 0) ? parts.join("|") : null;
}

export function centreInside(bounds: ElementBounds | undefined, container: ElementBounds): boolean {
  if (!bounds) {
    return false;
  }
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  return x >= container.left && x < container.right && y >= container.top && y < container.bottom;
}

/**
 * A node inside the list: its centre lies inside the container and it does not enclose the
 * container. A full-screen ancestor's centre can fall inside a wide list; excluding it keeps it
 * from standing in for every row. A node with the container's own bounds is kept here: it may be a
 * card that fills a one-card-per-page rail, and the container itself never reads as revealed,
 * because its identity is already on the first read.
 */
function insideList(bounds: ElementBounds | undefined, container: ElementBounds): boolean {
  return bounds !== undefined && centreInside(bounds, container) && !contains(bounds, container);
}

/**
 * A row candidate for axis inference: inside the list and not the container's own box. A card that
 * fills the rail is excluded too, which only loses an axis signal a single card cannot give.
 */
function withinList(bounds: ElementBounds | undefined, container: ElementBounds): boolean {
  return bounds !== undefined && insideList(bounds, container) && !sameBounds(bounds, container);
}

/** Named nodes inside the list (see {@link insideList}). */
function rowsInside(screen: FocusScreen, container: ElementBounds): string[] {
  return screen.elements
    .filter((element) => insideList(element.bounds, container))
    .map(rowIdentity)
    .filter((identity): identity is string => identity !== null);
}

function sameBounds(a: ElementBounds | undefined, b: ElementBounds): boolean {
  return (
    a !== undefined &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom
  );
}

function focusIdentity(focused: Element | null): string {
  if (!focused) {
    return "";
  }
  const { left, top, right, bottom } = focused.bounds;
  return `${rowIdentity(focused) ?? ""}@${left},${top},${right},${bottom}`;
}

/** Where focus is across one advance: whether it stopped moving or left the list. */
interface FocusTrail {
  focus: string;
  entered: boolean;
  unchanged: number;
  /** Presses spent steering focus into the list, and then along it. */
  entering: number;
  advancing: number;
}

function startTrail(screen: FocusScreen, container: ElementBounds): FocusTrail {
  return {
    focus: focusIdentity(screen.focused),
    entered: centreInside(screen.focused?.bounds, container),
    unchanged: 0,
    entering: 0,
    advancing: 0,
  };
}

type Stop = { status: Exclude<FocusListAdvanceStatus, "revealed">; message: string };

/**
 * The next key to press: toward the list until focus is inside it, then along it. A stop once
 * either phase has spent its bound.
 */
function nextPress(
  trail: FocusTrail,
  screen: FocusScreen,
  {
    container,
    direction,
    maxPresses,
  }: { container: ElementBounds; direction: FocusListAdvanceDirection; maxPresses: number },
): FocusNavigateDirection | Stop {
  if (trail.entered) {
    if (trail.advancing >= maxPresses) {
      return { status: "max_presses", message: `Reached maxPresses (${maxPresses})` };
    }
    trail.advancing += 1;
    return direction;
  }
  if (trail.entering >= maxPresses) {
    return {
      status: "not_entered",
      message: `Focus did not reach the list in ${maxPresses} presses`,
    };
  }
  trail.entering += 1;
  return directionToward(screen.focused, [{ bounds: container }]);
}

/** Follow focus to `screen`; the reason the list is exhausted, if focus says it is. */
function followFocus(
  trail: FocusTrail,
  screen: FocusScreen,
  container: ElementBounds,
): Stop | undefined {
  const focus = focusIdentity(screen.focused);
  trail.unchanged = focus === trail.focus ? trail.unchanged + 1 : 0;
  trail.focus = focus;
  if (trail.unchanged >= FOCUS_LIST_ADVANCE_STUCK_PRESSES) {
    return { status: "stuck", message: `Focus did not move after ${trail.unchanged} presses` };
  }
  const inside = centreInside(screen.focused?.bounds, container);
  if (trail.entered && !inside) {
    return { status: "left_list", message: "Focus left the list" };
  }
  trail.entered ||= inside;
  return undefined;
}

export class FocusListAdvance {
  constructor(
    private readonly observer: FocusObserver,
    private readonly keys: FocusKeyPresser,
    private readonly timer: Timer,
  ) {}

  /**
   * Steer focus into `container` if it is elsewhere (discovery picks the list, not what holds
   * focus), then press `direction` until a row that was not on screen appears inside it. Rows
   * already seen never count, so a list that wraps back to its first rows ends on the press bound.
   * Stops without revealing when focus does not move for two presses (the end of the list, or a
   * list focus cannot reach), leaves the list after entering it, or a phase spends its bound.
   */
  async execute(options: FocusListAdvanceOptions): Promise<FocusListAdvanceResult> {
    const { container, signal } = options;
    const maxPresses = options.maxPresses ?? FOCUS_LIST_ADVANCE_MAX_PRESSES;

    throwIfAborted(signal);
    const first = await this.observer.read(signal);
    const direction = options.direction ?? listAdvanceDirection(container, first.elements);
    const seen = new Set(rowsInside(first, container));
    const trail = startTrail(first, container);
    const bounds = { container, direction, maxPresses };

    let screen = first;
    for (let presses = 1; ; presses++) {
      const next = nextPress(trail, screen, bounds);
      if (typeof next !== "string") {
        return this.exhausted(next.status, direction, presses - 1, next.message);
      }
      screen = await this.pressAndRead(next, options);
      const revealed = rowsInside(screen, container).filter((row) => !seen.has(row));
      if (revealed.length > 0) {
        return { success: true, status: "revealed", direction, presses, revealed };
      }
      const stop = followFocus(trail, screen, container);
      if (stop) {
        return this.exhausted(stop.status, direction, presses, stop.message);
      }
    }
  }

  /** One press, its settle, and a fresh read. */
  private async pressAndRead(
    direction: FocusNavigateDirection,
    { signal, settleMs = FOCUS_NAVIGATE_DEFAULT_SETTLE_MS }: FocusListAdvanceOptions,
  ): Promise<FocusScreen> {
    throwIfAborted(signal);
    const pressed = await this.keys.press(DIRECTION_KEYS[direction], signal);
    if (!pressed.success) {
      throw new ActionableError(pressed.error ?? `Failed to press D-pad ${direction}`);
    }
    // The settle is the advance's longest wait; a cancelled request must not sit through it.
    await awaitWhileRequestIsLive(this.timer.sleep(settleMs), signal);
    return await this.observer.read(signal);
  }

  private exhausted(
    status: Stop["status"],
    direction: FocusListAdvanceDirection,
    presses: number,
    message: string,
  ): FocusListAdvanceResult {
    return {
      success: false,
      status,
      direction,
      presses,
      revealed: [],
      message: `${message}; no new rows appeared in the list.`,
    };
  }
}
