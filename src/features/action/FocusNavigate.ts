/**
 * D-pad focus navigation for focus-driven UIs such as Android TV (#14947).
 *
 * Observe, stop when the focused element matches `until`, otherwise press the D-pad key that
 * moves focus toward the nearest match and observe again. The loop only needs an observer and a
 * key presser, so it runs against fakes with no device and no real delay.
 */

import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import { DefaultTextMatcher } from "../utility/TextMatcher";
import { matchesCtrlProxyResourceId } from "../utility/SearchableNode";
import { throwIfAborted } from "../../utils/toolUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { InputKeyName } from "./InputKey";

export const FOCUS_NAVIGATE_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type FocusNavigateDirection = (typeof FOCUS_NAVIGATE_DIRECTIONS)[number];

export const FOCUS_NAVIGATE_DEFAULT_MAX_STEPS = 30;
export const FOCUS_NAVIGATE_MAX_STEPS_LIMIT = 100;
export const FOCUS_NAVIGATE_DEFAULT_SETTLE_MS = 200;
export const FOCUS_NAVIGATE_MAX_SETTLE_MS = 5000;
/** Consecutive explicit-direction presses that leave focus unchanged before the loop gives up. */
export const FOCUS_NAVIGATE_STUCK_PRESSES = 2;

export const FOCUS_NAVIGATE_STATUSES = ["focused", "max_steps", "stuck"] as const;
export type FocusNavigateStatus = (typeof FOCUS_NAVIGATE_STATUSES)[number];

/** Identity fields of the element to focus; every given field must match. */
export interface FocusNavigateTarget {
  text?: string;
  contentDesc?: string;
  resourceId?: string;
}

/** One screen read: the focused element (if any) and every element that could match. */
export interface FocusScreen {
  focused: Element | null;
  elements: readonly Element[];
}

export interface FocusObserver {
  read(signal?: AbortSignal): Promise<FocusScreen>;
}

export interface FocusKeyPresser {
  press(
    key: InputKeyName,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; verified?: boolean }>;
}

export interface FocusPathEntry {
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  bounds: ElementBounds;
}

export interface FocusNavigateOptions {
  until: FocusNavigateTarget;
  direction?: FocusNavigateDirection;
  maxSteps?: number;
  settleMs?: number;
  signal?: AbortSignal;
}

export interface FocusNavigateResult {
  success: boolean;
  status: FocusNavigateStatus;
  /** D-pad presses sent. */
  steps: number;
  /** Focused elements in the order observed; consecutive repeats are collapsed. */
  path: FocusPathEntry[];
  focusedElement?: FocusPathEntry;
  message?: string;
}

const DIRECTION_KEYS = {
  up: "arrow_up",
  down: "arrow_down",
  left: "arrow_left",
  right: "arrow_right",
} as const satisfies Record<FocusNavigateDirection, InputKeyName>;

const textMatcher = new DefaultTextMatcher();

export function focusNavigateTargetError(target: FocusNavigateTarget): string | undefined {
  const given = [target.text, target.contentDesc, target.resourceId].some(
    (value) => value !== undefined && value.length > 0,
  );
  return given
    ? undefined
    : "focusNavigate requires until.text, until.contentDesc or until.resourceId";
}

function stringProp(element: Element, key: "text" | "content-desc" | "resource-id"): string {
  const value = element[key];
  return typeof value === "string" ? value : "";
}

export function elementMatchesTarget(element: Element, target: FocusNavigateTarget): boolean {
  if (target.text && !textMatcher.createTextMatcher(target.text)(stringProp(element, "text"))) {
    return false;
  }
  if (
    target.contentDesc &&
    !textMatcher.createTextMatcher(target.contentDesc)(stringProp(element, "content-desc"))
  ) {
    return false;
  }
  return (
    !target.resourceId ||
    matchesCtrlProxyResourceId(stringProp(element, "resource-id"), target.resourceId)
  );
}

function center(bounds: ElementBounds): { x: number; y: number } {
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}

/**
 * The D-pad direction from `from` toward the nearest `until` match: the dominant axis of the
 * offset to that match. Without a focused element or a match on screen the only move left is down.
 */
export function directionToward(
  from: Element | null,
  matches: readonly Element[],
): FocusNavigateDirection {
  return directionsToward(from, matches)[0];
}

/**
 * Every D-pad direction that closes distance to the nearest match, best first: the dominant axis,
 * then the other axis when the match is offset on it. Without a focused element or a match the
 * only candidate is down.
 */
export function directionsToward(
  from: Element | null,
  matches: readonly Element[],
): [FocusNavigateDirection, ...FocusNavigateDirection[]] {
  if (!from || matches.length === 0) {
    return ["down"];
  }
  const origin = center(from.bounds);
  const offsets = matches.map((match) => {
    const point = center(match.bounds);
    return { dx: point.x - origin.x, dy: point.y - origin.y };
  });
  const nearest = offsets.reduce((best, next) =>
    Math.hypot(next.dx, next.dy) < Math.hypot(best.dx, best.dy) ? next : best,
  );
  const horizontal: FocusNavigateDirection[] =
    nearest.dx === 0 ? [] : [nearest.dx > 0 ? "right" : "left"];
  const vertical: FocusNavigateDirection[] =
    nearest.dy === 0 ? [] : [nearest.dy < 0 ? "up" : "down"];
  const ranked =
    Math.abs(nearest.dx) > Math.abs(nearest.dy)
      ? [...horizontal, ...vertical]
      : [...vertical, ...horizontal];
  const [best, ...rest] = ranked;
  return best ? [best, ...rest] : ["down"];
}

function pathEntry(element: Element): FocusPathEntry {
  const text = stringProp(element, "text");
  const contentDesc = stringProp(element, "content-desc");
  const resourceId = stringProp(element, "resource-id");
  return {
    ...(text ? { text } : {}),
    ...(contentDesc ? { contentDesc } : {}),
    ...(resourceId ? { resourceId } : {}),
    bounds: element.bounds,
  };
}

function focusKey(element: Element | null): string {
  if (!element) {
    return "";
  }
  const { left, top, right, bottom } = element.bounds;
  return [
    stringProp(element, "resource-id"),
    stringProp(element, "text"),
    stringProp(element, "content-desc"),
    `${left},${top},${right},${bottom}`,
  ].join("|");
}

/** Tracks whether the last press moved focus, and which directions failed on this element. */
interface FocusProgress {
  readonly unchanged: number;
  /** Directions that did not move focus off this element during this navigation call. */
  readonly blocked: ReadonlySet<FocusNavigateDirection>;
  /** Records an observation; returns true when focus differs from the previous one. */
  observe(key: string): boolean;
  pressed(direction: FocusNavigateDirection): void;
}

function createFocusProgress(): FocusProgress {
  const blockedByElement = new Map<string, Set<FocusNavigateDirection>>();
  let blocked = new Set<FocusNavigateDirection>();
  let unchanged = 0;
  let previousKey: string | undefined;
  let lastDirection: FocusNavigateDirection | undefined;
  return {
    get unchanged() {
      return unchanged;
    },
    get blocked() {
      return blocked;
    },
    observe(key) {
      const didNotMove = previousKey !== undefined && key === previousKey;
      const moved = key !== previousKey;
      unchanged = didNotMove ? unchanged + 1 : 0;
      if (!didNotMove) {
        blocked = blockedByElement.get(key) ?? new Set<FocusNavigateDirection>();
        blockedByElement.set(key, blocked);
      } else if (lastDirection) {
        blocked.add(lastDirection);
      }
      previousKey = key;
      return moved;
    },
    pressed(direction) {
      lastDirection = direction;
    },
  };
}

export class FocusNavigate {
  constructor(
    private readonly observer: FocusObserver,
    private readonly keys: FocusKeyPresser,
    private readonly timer: Timer,
  ) {}

  async execute(options: FocusNavigateOptions): Promise<FocusNavigateResult> {
    const targetError = focusNavigateTargetError(options.until);
    if (targetError) {
      throw new ActionableError(targetError);
    }
    const maxSteps = options.maxSteps ?? FOCUS_NAVIGATE_DEFAULT_MAX_STEPS;
    const settleMs = options.settleMs ?? FOCUS_NAVIGATE_DEFAULT_SETTLE_MS;
    const { signal } = options;

    const path: FocusPathEntry[] = [];
    let steps = 0;
    const progress = createFocusProgress();

    for (;;) {
      throwIfAborted(signal);
      const screen = await this.observer.read(signal);
      const { focused } = screen;
      const key = focusKey(focused);
      if (progress.observe(key) && focused) {
        path.push(pathEntry(focused));
      }
      const { unchanged, blocked } = progress;

      const direction = options.direction ?? this.nextDirection(screen, options, blocked);
      const exhausted = options.direction ? unchanged >= FOCUS_NAVIGATE_STUCK_PRESSES : !direction;
      const done = this.exitFor(options, focused, {
        steps,
        stuck: exhausted ? Math.max(1, unchanged, blocked.size) : 0,
        maxSteps,
        path,
      });
      if (done) {
        return done;
      }
      if (!direction) {
        throw new ActionableError("focusNavigate has no direction to press");
      }
      await this.press(direction, signal);
      progress.pressed(direction);
      steps += 1;
      await this.timer.sleep(settleMs);
    }
  }

  private exitFor(
    options: FocusNavigateOptions,
    focused: Element | null,
    progress: { steps: number; stuck: number; maxSteps: number; path: FocusPathEntry[] },
  ): FocusNavigateResult | undefined {
    const { steps, stuck, maxSteps, path } = progress;
    if (focused && elementMatchesTarget(focused, options.until)) {
      return { success: true, status: "focused", steps, path, focusedElement: pathEntry(focused) };
    }
    if (stuck > 0) {
      return this.stopped("stuck", steps, path, {
        focused,
        message: `Focus did not move after ${stuck} ${stuck === 1 ? "press" : "presses"}`,
      });
    }
    if (steps >= maxSteps) {
      return this.stopped("max_steps", steps, path, {
        focused,
        message: `Reached maxSteps (${maxSteps})`,
      });
    }
    return undefined;
  }

  /** The best direction toward the target that has not already failed to move focus. */
  private nextDirection(
    screen: FocusScreen,
    options: FocusNavigateOptions,
    blocked: ReadonlySet<FocusNavigateDirection>,
  ): FocusNavigateDirection | undefined {
    const matches = screen.elements.filter((element) =>
      elementMatchesTarget(element, options.until),
    );
    return directionsToward(screen.focused, matches).find((direction) => !blocked.has(direction));
  }

  private async press(
    direction: FocusNavigateDirection,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const pressed = await this.keys.press(DIRECTION_KEYS[direction], signal);
    if (!pressed.success) {
      throw new ActionableError(pressed.error ?? `Failed to press D-pad ${direction}`);
    }
  }

  private stopped(
    status: "stuck" | "max_steps",
    steps: number,
    path: FocusPathEntry[],
    { focused, message }: { focused: Element | null; message: string },
  ): FocusNavigateResult {
    return {
      success: false,
      status,
      steps,
      path,
      ...(focused ? { focusedElement: pathEntry(focused) } : {}),
      message: `${message}; the target was not focused. Observe before retrying.`,
    };
  }
}
