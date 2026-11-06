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
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import { DefaultTextMatcher } from "../utility/TextMatcher";
import { normalize } from "../utility/ElementResolverMatching";
import { isTruthyFlag } from "../utility/elementProperties";
import { matchesCtrlProxyResourceId } from "../utility/SearchableNode";
import { throwIfAborted } from "../../utils/toolUtils";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import { compareSelectionRank } from "../utility/selectionRank";
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
  /** Matches an element whose text or content-desc matches, as tapOn's text selector does. */
  label?: string;
  /** Require `label` to equal the text or content-desc; see {@link exactFirstTarget}. */
  labelExact?: boolean;
  /**
   * tapOn's elementId: the native resource-id, or the synthetic `view-id` an observation gives an
   * id-less node (`s2-…`).
   */
  elementId?: string;
  /**
   * Only the element at these bounds counts; null means nothing on this screen is the target.
   * See {@link firstMatchTarget} and {@link FocusNavigateOptions.pinTarget}.
   */
  atBounds?: ElementBounds | null;
}

/** One screen read: the focused element (if any) and every element that could match. */
export interface FocusScreen {
  focused: Element | null;
  elements: readonly Element[];
  /** The read's hierarchy, for callers that resolve the target with tapOn's own selector. */
  hierarchy?: ViewHierarchyResult;
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
  /** Label of a contained node; the identity fields and bounds still describe the focused parent. */
  descendantLabel?: string;
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
  /** Press the D-pad select key (enter) once focus lands on the target. */
  select?: boolean;
  signal?: AbortSignal;
  /**
   * Only the first-ranked match on each read counts, as tapOn's default selection does, so focus
   * already resting on another duplicate is not accepted. See {@link firstMatchTarget}.
   */
  firstMatch?: boolean;
  /**
   * Resolve the target on each read: its bounds, null when nothing on the screen is the target,
   * or undefined to fall back to matching `until` here. tapOn's D-pad path resolves with the
   * touch selector so both inputs pick the same element.
   */
  pinTarget?: (screen: FocusScreen) => ElementBounds | null | undefined;
}

export interface FocusNavigateResult {
  success: boolean;
  status: FocusNavigateStatus;
  /** D-pad presses sent. */
  steps: number;
  /** Focused elements in the order observed; consecutive repeats are collapsed. */
  path: FocusPathEntry[];
  focusedElement?: FocusPathEntry;
  /** With `select`: whether the select key was sent to the focused target. */
  selected?: boolean;
  message?: string;
}

/** The key that activates the focused element; TV views treat enter as D-pad center. */
export const FOCUS_NAVIGATE_SELECT_KEY = "enter" satisfies InputKeyName;

const DIRECTION_KEYS = {
  up: "arrow_up",
  down: "arrow_down",
  left: "arrow_left",
  right: "arrow_right",
} as const satisfies Record<FocusNavigateDirection, InputKeyName>;

const textMatcher = new DefaultTextMatcher();

export function focusNavigateTargetError(target: FocusNavigateTarget): string | undefined {
  const given = [
    target.text,
    target.contentDesc,
    target.resourceId,
    target.label,
    target.elementId,
  ].some((value) => value !== undefined && value.length > 0);
  return given
    ? undefined
    : "focusNavigate requires until.text, until.contentDesc or until.resourceId";
}

function stringProp(
  element: Element,
  key: "text" | "content-desc" | "resource-id" | "view-id",
): string {
  const value = element[key];
  return typeof value === "string" ? value : "";
}

/**
 * Label matching normalized as tapOn's touch resolver does (quotes, trimmed, whitespace collapsed,
 * case-insensitive), so ` Movies ` equals `Movies` and a wrapped `Sign\nin` matches `Sign in`.
 */
function labelMatches(label: string, exact: boolean, fields: readonly string[]): boolean {
  const query = normalize(label);
  if (!query) {
    return false;
  }
  return fields.some((field) => {
    const value = normalize(field);
    return value.length > 0 && (exact ? value === query : value.includes(query));
  });
}

/** Text-field checks: text, contentDesc and label. Each given field must match. */
function textFieldsMatch(element: Element, target: FocusNavigateTarget): boolean {
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
    !target.label ||
    labelMatches(target.label, Boolean(target.labelExact), [
      stringProp(element, "text"),
      stringProp(element, "content-desc"),
    ])
  );
}

/** Identity checks: elementId (native or synthetic view-id) and resourceId. */
function idFieldsMatch(element: Element, target: FocusNavigateTarget): boolean {
  const resourceId = stringProp(element, "resource-id");
  if (
    target.elementId &&
    !matchesCtrlProxyResourceId(resourceId, target.elementId) &&
    stringProp(element, "view-id") !== target.elementId
  ) {
    return false;
  }
  return !target.resourceId || matchesCtrlProxyResourceId(resourceId, target.resourceId);
}

export function elementMatchesTarget(element: Element, target: FocusNavigateTarget): boolean {
  if (target.atBounds === null) {
    return false;
  }
  if (target.atBounds && !boundsEqual(element.bounds, target.atBounds)) {
    return false;
  }
  return textFieldsMatch(element, target) && idFieldsMatch(element, target);
}

/**
 * Exact matches win over containing ones, as in tapOn's touch resolver: when an element on this
 * screen has `label` as its whole text or content-desc, a node that merely contains it (`Movies
 * Plus` for `Movies`) is not the target.
 */
export function exactFirstTarget(
  screen: FocusScreen,
  target: FocusNavigateTarget,
): FocusNavigateTarget {
  if (!target.label || target.labelExact) {
    return target;
  }
  const exact = { ...target, labelExact: true };
  return screen.elements.some((element) => elementMatchesTarget(element, exact)) ? exact : target;
}

/** The target for one screen read: exact-first, then pinned to the first match when asked. */
function resolveTarget(screen: FocusScreen, options: FocusNavigateOptions): FocusNavigateTarget {
  const pinned = options.pinTarget?.(screen);
  if (pinned !== undefined) {
    return { atBounds: pinned };
  }
  const exact = exactFirstTarget(screen, options.until);
  return options.firstMatch ? firstMatchTarget(screen, exact) : exact;
}

/**
 * Pin `target` to the first match on this screen as tapOn's `first` selection ranks it: smallest
 * area, then hierarchy order (the same {@link compareSelectionRank} ordering tvOS tapOn uses).
 */
export function firstMatchTarget(
  screen: FocusScreen,
  target: FocusNavigateTarget,
): FocusNavigateTarget {
  const [first] = screen.elements
    .filter((element) => elementMatchesTarget(element, target))
    .map((element, order) => ({
      element,
      windowRank: 0,
      area: boundsArea(element.bounds),
      order,
      interactive: false,
    }))
    .sort((a, b) => compareSelectionRank(a, b));
  return first ? { ...target, atBounds: first.element.bounds } : target;
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

function pathEntry(element: Element, descendant?: Element): FocusPathEntry {
  const text = stringProp(element, "text");
  const contentDesc = stringProp(element, "content-desc");
  const resourceId = stringProp(element, "resource-id");
  const descendantLabel =
    descendant &&
    (stringProp(descendant, "text") ||
      stringProp(descendant, "content-desc") ||
      stringProp(descendant, "resource-id"));
  return {
    ...(descendantLabel ? { descendantLabel } : {}),
    ...(text ? { text } : {}),
    ...(contentDesc ? { contentDesc } : {}),
    ...(resourceId ? { resourceId } : {}),
    bounds: element.bounds,
  };
}

function isActionable(element: Element): boolean {
  return isTruthyFlag(element.clickable) || isTruthyFlag(element.focusable);
}

/** Match each contained node independently, preserving the focused container's identity. */
function describeFocus(
  screen: FocusScreen,
  target: FocusNavigateTarget,
): { focusedElement: FocusPathEntry | undefined; matches: boolean } {
  const { focused } = screen;
  // The observer supplies flattened nodes, so require full bounds containment, not overlap.
  const contained = focused
    ? screen.elements.filter((element) => {
        if (element === focused) {
          return false;
        }
        const intersection = intersectBounds(focused.bounds, element.bounds);
        return intersection !== null && boundsEqual(intersection, element.bounds);
      })
    : [];
  // A pinned target is the control a touch tap would act on; an independently actionable child
  // (a Delete button in a focused row) must own focus itself, not borrow its parent's.
  const matchingDescendant = contained.find(
    (element) =>
      elementMatchesTarget(element, target) && !(target.atBounds && isActionable(element)),
  );
  const matches = Boolean(focused && (elementMatchesTarget(focused, target) || matchingDescendant));
  const label =
    matchingDescendant ??
    contained.find(
      (element) =>
        stringProp(element, "text") ||
        stringProp(element, "content-desc") ||
        stringProp(element, "resource-id"),
    );
  return { focusedElement: focused ? pathEntry(focused, label) : undefined, matches };
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
      const until = resolveTarget(screen, options);
      const { focusedElement, matches } = describeFocus(screen, until);
      const key = focusKey(focused);
      if (progress.observe(key) && focusedElement) {
        path.push(focusedElement);
      }
      const { unchanged, blocked } = progress;

      const direction = options.direction ?? this.nextDirection(screen, until, blocked);
      const exhausted = options.direction ? unchanged >= FOCUS_NAVIGATE_STUCK_PRESSES : !direction;
      const done = this.exitFor(focusedElement, matches, {
        steps,
        stuck: exhausted ? Math.max(1, unchanged, blocked.size) : 0,
        maxSteps,
        path,
      });
      if (done) {
        return await this.finish(done, options.select === true, signal);
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
    focusedElement: FocusPathEntry | undefined,
    matches: boolean,
    progress: { steps: number; stuck: number; maxSteps: number; path: FocusPathEntry[] },
  ): FocusNavigateResult | undefined {
    const { steps, stuck, maxSteps, path } = progress;
    if (matches) {
      return { success: true, status: "focused", steps, path, focusedElement };
    }
    if (stuck > 0) {
      return this.stopped("stuck", steps, path, {
        focusedElement,
        message: `Focus did not move after ${stuck} ${stuck === 1 ? "press" : "presses"}`,
      });
    }
    if (steps >= maxSteps) {
      return this.stopped("max_steps", steps, path, {
        focusedElement,
        message: `Reached maxSteps (${maxSteps})`,
      });
    }
    return undefined;
  }

  /** The best direction toward the target that has not already failed to move focus. */
  private nextDirection(
    screen: FocusScreen,
    until: FocusNavigateTarget,
    blocked: ReadonlySet<FocusNavigateDirection>,
  ): FocusNavigateDirection | undefined {
    const matches = screen.elements.filter((element) => elementMatchesTarget(element, until));
    return directionsToward(screen.focused, matches).find((direction) => !blocked.has(direction));
  }

  /** With `select`, activate a focused target with the select key; a refused key fails the call. */
  private async finish(
    done: FocusNavigateResult,
    select: boolean,
    signal: AbortSignal | undefined,
  ): Promise<FocusNavigateResult> {
    if (!select) {
      return done;
    }
    if (!done.success) {
      return { ...done, selected: false };
    }
    throwIfAborted(signal);
    // The select key, not the first arrow, is what can navigate: time the recorded call from it.
    reportToolDispatched();
    const pressed = await this.keys.press(FOCUS_NAVIGATE_SELECT_KEY, signal);
    if (!pressed.success) {
      throw new ActionableError(pressed.error ?? "Failed to press the D-pad select key");
    }
    return { ...done, selected: true };
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
    { focusedElement, message }: { focusedElement: FocusPathEntry | undefined; message: string },
  ): FocusNavigateResult {
    return {
      success: false,
      status,
      steps,
      path,
      ...(focusedElement ? { focusedElement } : {}),
      message: `${message}; the target was not focused. Observe before retrying.`,
    };
  }
}
