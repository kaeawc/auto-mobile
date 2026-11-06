/**
 * Bounded D-pad advance through a scrollable list (#17233).
 *
 * A focus-driven list (Android TV rails and vertical lists) scrolls only when focus moves past
 * its last visible row, so swiping it is not how a remote reveals more rows. This presses the
 * list's direction until a row that was not on screen appears inside the container, and stops
 * when focus stops moving, leaves the list, or the press bound is reached. It only needs an
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
import { FOCUS_NAVIGATE_DEFAULT_SETTLE_MS } from "./FocusNavigate";

/** Most presses one advance sends: a list's visible rows plus a scroll, on a 1080p TV. */
export const FOCUS_LIST_ADVANCE_MAX_PRESSES = 12;

/** Consecutive presses that leave focus where it was before the list counts as exhausted. */
const FOCUS_LIST_ADVANCE_STUCK_PRESSES = 2;

const DIRECTION_KEYS = {
  down: "arrow_down",
  right: "arrow_right",
} as const;

/** The directions a list advances in: down a vertical list, right along a horizontal rail. */
export type FocusListAdvanceDirection = Extract<
  FocusNavigateDirection,
  keyof typeof DIRECTION_KEYS
>;

export type FocusListAdvanceStatus = "revealed" | "stuck" | "left_list" | "max_presses";

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
  const inside = rows.filter(
    (row) => centreInside(row.bounds, container) && !sameBounds(row.bounds, container),
  );
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

function text(element: Element, key: "text" | "content-desc" | "resource-id"): string {
  const value = element[key];
  return typeof value === "string" ? value : "";
}

/** A row's identity: what names it, never its bounds, which a recycled row reuses. */
function rowIdentity(element: Element): string | null {
  const parts = [
    text(element, "resource-id"),
    text(element, "text"),
    text(element, "content-desc"),
  ];
  return parts.some((part) => part.length > 0) ? parts.join("|") : null;
}

function centreInside(bounds: ElementBounds | undefined, container: ElementBounds): boolean {
  if (!bounds) {
    return false;
  }
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  return x >= container.left && x < container.right && y >= container.top && y < container.bottom;
}

/** Named rows inside the container, the container itself excluded. */
function rowsInside(screen: FocusScreen, container: ElementBounds): string[] {
  return screen.elements
    .filter((element) => centreInside(element.bounds, container))
    .filter((element) => !sameBounds(element.bounds, container))
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
}

function startTrail(screen: FocusScreen, container: ElementBounds): FocusTrail {
  return {
    focus: focusIdentity(screen.focused),
    entered: centreInside(screen.focused?.bounds, container),
    unchanged: 0,
  };
}

/** Follow focus to `screen`; the reason the list is exhausted, if focus says it is. */
function followFocus(
  trail: FocusTrail,
  screen: FocusScreen,
  container: ElementBounds,
): { status: "stuck" | "left_list"; message: string } | undefined {
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
   * Press `direction` until a row that was not on screen appears inside `container`. Rows already
   * seen never count, so a list that wraps back to its first rows ends on the press bound. Stops
   * without revealing when focus does not move for two presses (the end of the list) or leaves
   * the list after entering it.
   */
  async execute(options: FocusListAdvanceOptions): Promise<FocusListAdvanceResult> {
    const { container, signal } = options;
    const maxPresses = options.maxPresses ?? FOCUS_LIST_ADVANCE_MAX_PRESSES;

    throwIfAborted(signal);
    const first = await this.observer.read(signal);
    const direction = options.direction ?? listAdvanceDirection(container, first.elements);
    const seen = new Set(rowsInside(first, container));
    const trail = startTrail(first, container);

    for (let presses = 1; presses <= maxPresses; presses++) {
      const screen = await this.pressAndRead(direction, options);
      const revealed = rowsInside(screen, container).filter((row) => !seen.has(row));
      if (revealed.length > 0) {
        return { success: true, status: "revealed", direction, presses, revealed };
      }
      const stop = followFocus(trail, screen, container);
      if (stop) {
        return this.exhausted(stop.status, direction, presses, stop.message);
      }
    }
    return this.exhausted(
      "max_presses",
      direction,
      maxPresses,
      `Reached maxPresses (${maxPresses})`,
    );
  }

  /** One press, its settle, and a fresh read. */
  private async pressAndRead(
    direction: FocusListAdvanceDirection,
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
    status: Exclude<FocusListAdvanceStatus, "revealed">,
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
