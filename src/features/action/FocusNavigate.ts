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
import { isEditableElementProperties, isTruthyFlag } from "../utility/elementProperties";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import { compareSelectionRank } from "../utility/selectionRank";
import type { Timer } from "../../utils/SystemTimer";
import type { InputKeyName } from "./InputKey";
import { describeFocus, elementMatchesTarget, stringProp } from "./FocusNavigateMatching";
import { changedOwnRange, createFocusIdentity, focusKey } from "./FocusIdentity";
import {
  createFocusProgress,
  rangeProbe,
  stuckMessage,
  type FocusProgress,
  type RangeProbe,
} from "./FocusProgress";
import type { FocusNavigateDirection } from "./FocusNavigateDirections";
import { isViewTextField, trapMessage } from "./FocusTrapMessage";
import {
  findRowAnchor,
  isInRow,
  notOnScreenMessage,
  createRowSearch,
  type FocusRowAnchor,
} from "./FocusRowSearch";

export { elementMatchesTarget } from "./FocusNavigateMatching";

export { FOCUS_NAVIGATE_DIRECTIONS, type FocusNavigateDirection } from "./FocusNavigateDirections";

export const FOCUS_NAVIGATE_DEFAULT_MAX_STEPS = 30;
export const FOCUS_NAVIGATE_MAX_STEPS_LIMIT = 100;
export const FOCUS_NAVIGATE_DEFAULT_SETTLE_MS = 200;
export const FOCUS_NAVIGATE_MAX_SETTLE_MS = 5000;
/** Consecutive explicit-direction presses that leave focus unchanged before the loop gives up. */
export const FOCUS_NAVIGATE_STUCK_PRESSES = 2;
export { FOCUS_NAVIGATE_STALL_PRESSES } from "./FocusProgress";

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
  /** Whether an input-method (on-screen keyboard) window was in the read; undefined when unknown. */
  imeVisible?: boolean;
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

/**
 * Hides the on-screen keyboard (Android: KEYCODE_BACK). Only called when the read that preceded it
 * showed an IME window, so the back press closes the keyboard rather than leaving the screen.
 */
export interface FocusKeyboardHider {
  hideKeyboard(signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
}

/** What holds focus when presses stop moving it: the on-screen keyboard, or an editable field. */
export const FOCUS_NAVIGATE_BLOCKERS = ["ime", "editable"] as const;
export type FocusNavigateBlocker = (typeof FOCUS_NAVIGATE_BLOCKERS)[number];

/** The keys pressed to leave a focus trap: back hides the keyboard, tab moves to the next focusable. */
export type FocusTrapEscape = "back" | "tab";

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
   * touch selector, preferring a focusable label match when the touch target cannot focus.
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
  /** On `stuck`: the keyboard or editable text field that held focus (#17356). */
  blockedBy?: FocusNavigateBlocker;
  /** On `stuck` with `blockedBy`: the escapes tried before giving up, in order. */
  escapes?: FocusTrapEscape[];
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

/**
 * The Leanback headers grid (`browse_headers`) holding a focused `row_header`, if focus is there.
 * While a header holds focus its row's card labels are hidden; another app's `row_header` id
 * outside that grid is not a Leanback header.
 */
function leanbackHeadersPane(
  focused: Element | null,
  elements: readonly Element[],
): Element | undefined {
  if (!focused || !stringProp(focused, "resource-id").endsWith(":id/row_header")) {
    return undefined;
  }
  return elements.find((element) => {
    if (!stringProp(element, "resource-id").endsWith(":id/browse_headers")) {
      return false;
    }
    const overlap = intersectBounds(element.bounds, focused.bounds);
    return overlap !== null && boundsEqual(overlap, focused.bounds);
  });
}

/**
 * Right, to enter a focused Leanback header's content pane when no match is on screen; at most
 * once per header. A scrollable headers grid can hide the target header below, so the headers
 * are scanned down first and right is pressed once down is refused at the last header. A refused
 * right falls through to the down scan.
 */
function leanbackEntry(
  focused: Element | null,
  elements: readonly Element[],
  progress: FocusProgress,
): FocusNavigateDirection | undefined {
  const pane = leanbackHeadersPane(focused, elements);
  if (!pane || progress.tried.has("right")) {
    return undefined;
  }
  return isTruthyFlag(pane.scrollable) && !progress.blocked.has("down") ? undefined : "right";
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

/** tapOn's `first` ranking for flat elements: smallest area, then hierarchy order. */
function rankFirst(elements: readonly Element[]): Element[] {
  return elements
    .map((element, order) => ({
      element,
      windowRank: 0,
      area: boundsArea(element.bounds),
      order,
      interactive: false,
    }))
    .sort((a, b) => compareSelectionRank(a, b))
    .map(({ element }) => element);
}

function isActionableElement(element: Element): boolean {
  return isTruthyFlag(element.focusable) || isTruthyFlag(element.clickable);
}

/**
 * The nearest element enclosing `element` that is clickable, focusable or scrollable (the flat
 * read's stand-in for its nearest actionable ancestor): the smallest such enclosure, the first one
 * a walk up from `element` would reach.
 */
function nearestActionableOwner(
  elements: readonly Element[],
  element: Element,
): Element | undefined {
  const [nearest] = elements
    .filter((owner) => {
      if (owner === element || !(isActionableElement(owner) || isTruthyFlag(owner.scrollable))) {
        return false;
      }
      const overlap = intersectBounds(owner.bounds, element.bounds);
      return overlap !== null && boundsEqual(overlap, element.bounds);
    })
    .sort((a, b) => boundsArea(a.bounds) - boundsArea(b.bounds));
  return nearest;
}

/**
 * Pin `target` to the first match as tapOn's `first` selection ranks it: exact labels first
 * ({@link exactFirstTarget}), then smallest area, then hierarchy order (the same
 * {@link compareSelectionRank} ordering tvOS tapOn uses). A focusable or clickable first match is
 * its own control and keeps the pin, so a focused row never stands in for a clickable child. A
 * pure label keeps the pin when its nearest actionable owner is focusable (focus on that owner
 * matches the label) or only clickable (that control owns it); a label with no actionable owner
 * moves the pin to the best focusable match, exact before contains.
 */
export function firstMatchTarget(
  screen: FocusScreen,
  target: FocusNavigateTarget,
): FocusNavigateTarget {
  const ranked = exactFirstTarget(screen, target);
  const matches = rankFirst(
    screen.elements.filter((element) => elementMatchesTarget(element, ranked)),
  );
  const [first] = matches;
  if (!first) {
    return target;
  }
  const owner = nearestActionableOwner(screen.elements, first);
  if (isActionableElement(first) || (owner && !isTruthyFlag(owner.scrollable))) {
    return { ...target, atBounds: first.bounds };
  }
  const exact = target.label ? { ...target, labelExact: true } : target;
  const focusable = matches.filter((element) => isTruthyFlag(element.focusable));
  const [fallback] = [
    ...focusable.filter((element) => elementMatchesTarget(element, exact)),
    ...focusable,
  ];
  return { ...target, atBounds: (fallback ?? first).bounds };
}

/** Whether the closed intervals [aStart, aEnd] and [bStart, bEnd] share any length. */
function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) > Math.max(aStart, bStart);
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
 * The axes to move along toward `target`, best first. A target on another row is reached by
 * changing rows first: focus then lands in that row near the target's column, where sliding along
 * the current row first would walk past it (#17379). Likewise a target in another column but the
 * same band moves sideways first. Only when the target overlaps the focused element on both axes
 * does the dominant offset decide. The press that undoes the one that just moved focus here is
 * never planned: around a dead end the planned and dominant routes would trade places forever, so
 * the dominant offset decides then.
 */
function rankAxes(
  from: ElementBounds,
  target: ElementBounds,
  { dx, dy }: { dx: number; dy: number },
  arrivedBy: FocusNavigateDirection | undefined,
): FocusNavigateDirection[] {
  const horizontal: FocusNavigateDirection[] = dx === 0 ? [] : [dx > 0 ? "right" : "left"];
  const vertical: FocusNavigateDirection[] = dy === 0 ? [] : [dy < 0 ? "up" : "down"];
  const rowsApart = !spansOverlap(from.top, from.bottom, target.top, target.bottom);
  const columnsApart = !spansOverlap(from.left, from.right, target.left, target.right);
  const dominantVertical = Math.abs(dx) <= Math.abs(dy);
  const dominant = dominantVertical ? [...vertical, ...horizontal] : [...horizontal, ...vertical];
  const verticalFirst = rowsApart || (!columnsApart && dominantVertical);
  const planned = verticalFirst ? [...vertical, ...horizontal] : [...horizontal, ...vertical];
  if (arrivedBy === undefined) {
    return planned;
  }
  const back = OPPOSITE[arrivedBy];
  const ranked = planned[0] === back ? dominant : planned;
  // Reversing stays available as the last resort when it is the only way that closes in.
  return [
    ...ranked.filter((direction) => direction !== back),
    ...ranked.filter((direction) => direction === back),
  ];
}

/** An element's identity across reads: its selectors plus where it sits. */
function matchKey(element: Element): string {
  const { left, top, right, bottom } = element.bounds;
  return [
    stringProp(element, "resource-id"),
    stringProp(element, "text"),
    stringProp(element, "content-desc"),
    `${left},${top},${right},${bottom}`,
  ].join("|");
}

/**
 * Chooses the match to plan toward each read: the one chosen last read while it is still on
 * screen, else the nearest. Recomputing the nearest every read lets a press that lands beside
 * another match flip the target and walk back and forth between the two.
 */
function createTargetPlanner() {
  let previousKey: string | undefined;
  return (from: Element | null, matches: readonly Element[]): Element[] => {
    if (!from || matches.length === 0) {
      previousKey = undefined;
      return [];
    }
    const origin = center(from.bounds);
    const distance = (m: Element) => {
      const point = center(m.bounds);
      return Math.hypot(point.x - origin.x, point.y - origin.y);
    };
    const nearest = matches.reduce((best, next) => (distance(next) < distance(best) ? next : best));
    const target = matches.find((m) => matchKey(m) === previousKey) ?? nearest;
    previousKey = matchKey(target);
    return [target];
  };
}

/**
 * Every D-pad direction that closes distance to the nearest match, best first: the dominant axis,
 * then the other axis when the match is offset on it. Without a focused element or a match the
 * only candidate is down.
 */
export function directionsToward(
  from: Element | null,
  matches: readonly Element[],
  arrivedBy?: FocusNavigateDirection,
): [FocusNavigateDirection, ...FocusNavigateDirection[]] {
  if (!from || matches.length === 0) {
    return ["down"];
  }
  const origin = center(from.bounds);
  const offsets = matches.map((match) => {
    const point = center(match.bounds);
    return { dx: point.x - origin.x, dy: point.y - origin.y };
  });
  const nearestIndex = offsets.reduce(
    (best, next, index) =>
      Math.hypot(next.dx, next.dy) < Math.hypot(offsets[best].dx, offsets[best].dy) ? index : best,
    0,
  );
  const ranked = rankAxes(
    from.bounds,
    matches[nearestIndex].bounds,
    offsets[nearestIndex],
    arrivedBy,
  );
  const [best, ...rest] = ranked;
  return best ? [best, ...rest] : ["down"];
}

const OPPOSITE = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
} as const satisfies Record<FocusNavigateDirection, FocusNavigateDirection>;

const PERPENDICULAR = {
  up: ["left", "right"],
  down: ["left", "right"],
  left: ["up", "down"],
  right: ["up", "down"],
} as const satisfies Record<FocusNavigateDirection, readonly FocusNavigateDirection[]>;

/**
 * Every D-pad direction in the order to try it: the directions toward the target, then the ones
 * that can leave the container focus is trapped in (perpendicular to the best direction, then
 * away from the target).
 */
export function directionsWithFallbacks(
  toward: readonly [FocusNavigateDirection, ...FocusNavigateDirection[]],
): FocusNavigateDirection[] {
  const [best] = toward;
  return [...new Set([...toward, ...PERPENDICULAR[best], OPPOSITE[best]])];
}

/** Distance from the focused element's centre to the nearest match, or undefined without both. */
function distanceToNearest(from: Element | null, matches: readonly Element[]): number | undefined {
  if (!from || matches.length === 0) {
    return undefined;
  }
  const origin = center(from.bounds);
  return Math.min(
    ...matches.map((match) => {
      const point = center(match.bounds);
      return Math.hypot(point.x - origin.x, point.y - origin.y);
    }),
  );
}

const STOPPED_SUFFIX = "; the target was not focused. Observe before retrying.";

/** A stopped result's message without its closing advice, to extend it. */
function stripRetryAdvice(message: string | undefined): string {
  const text = message ?? "";
  return text.endsWith(STOPPED_SUFFIX) ? text.slice(0, -STOPPED_SUFFIX.length) : text;
}

/** Per-call state of the search for a target no read has held yet (#18027). */
interface WalkSearch {
  /** Whether any read held the target; until one does, a stop says it was not on screen. */
  seen: boolean;
  sweep: ReturnType<typeof createRowSearch>;
  planTarget: ReturnType<typeof createTargetPlanner>;
}

/**
 * The row search for a target in no read yet (#18027): with focus in the row whose labels resemble
 * the target, the next untried direction along it (undefined once both ends refused). Undefined
 * when no such row holds focus, which leaves the walk to plan toward the row, or scan down.
 */
function rowStep(
  focused: Element | null,
  row: FocusRowAnchor | undefined,
  sweep: ReturnType<typeof createRowSearch>,
  progress: FocusProgress,
): { direction: FocusNavigateDirection | undefined } | undefined {
  if (!row || !focused || !isInRow(focused, row)) {
    return undefined;
  }
  return { direction: sweep(progress.blocked) };
}

/** Whether the walk has run out of presses that could still move focus. */
function isExhausted(
  options: FocusNavigateOptions,
  progress: FocusProgress,
  direction: FocusNavigateDirection | undefined,
): boolean {
  return options.direction ? progress.unchanged >= FOCUS_NAVIGATE_STUCK_PRESSES : !direction;
}

/** One read's state for deciding how a walk that cannot continue ends. */
interface ExitContext {
  screen: FocusScreen;
  focusedElement: FocusPathEntry | undefined;
  /** Whether the focused control consumed a direction by changing its own value (#17739). */
  adjusted: boolean;
  /**
   * Escapes already pressed, in order; each keyboard-trap key is pressed at most once per call.
   * `tabbedFrom` keys each range control tab already left (#18393), so a walk through two sliders
   * gets one tab per slider rather than one per call.
   */
  trap: { escapes?: FocusTrapEscape[]; tabbedFrom?: Set<string> };
  /** Arrows refused from the focused element since the walk last escaped a trap. */
  refused: ReadonlySet<FocusNavigateDirection>;
  select: boolean;
  signal: AbortSignal | undefined;
}

/** The keyboard or editable field holding focus on this read, if either does. */
function focusBlocker(screen: FocusScreen): FocusNavigateBlocker | undefined {
  if (screen.imeVisible) {
    return "ime";
  }
  return screen.focused && isEditableElementProperties(screen.focused) ? "editable" : undefined;
}

/** Whether tab is the escape from this focused element once no keyboard is shown over it. */
function tabEscapes(screen: FocusScreen, focused: Element): boolean {
  return !isEditableElementProperties(focused) || !isViewTextField(screen, focused);
}

export class FocusNavigate {
  constructor(
    private readonly observer: FocusObserver,
    private readonly keys: FocusKeyPresser,
    private readonly timer: Timer,
    /** Without it a keyboard trap is reported but not escaped with back (tvOS, older callers). */
    private readonly keyboard?: FocusKeyboardHider,
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
    let progress = createFocusProgress();
    const identify = createFocusIdentity();
    const planTarget = createTargetPlanner();
    const trap: ExitContext["trap"] = {};
    let lastDirection: FocusNavigateDirection | undefined;
    let probe: RangeProbe | undefined;
    const walk: WalkSearch = { seen: false, sweep: createRowSearch(), planTarget };

    for (;;) {
      throwIfAborted(signal);
      const { screen, focusedElement, matches, containsTarget, onScreen } = await this.readFocus(
        options,
        path,
        maxSteps > 0,
      );
      const undone = await this.undoAdjustment(probe, { screen, matches }, signal);
      probe = undefined;
      if (undone) {
        // The press changed the control's value: the read of the changed value is not a place
        // the walk went, and the next read (value restored) counts as the press refused.
        path.length = undone.pathLength;
        progress.restoredAdjustment(undone.direction);
        steps += 1;
        await awaitWhileRequestIsLive(this.timer.sleep(settleMs), signal);
        continue;
      }
      const { focused } = screen;
      progress.observe(
        identify(focusedElement, screen, lastDirection),
        distanceToNearest(focused, onScreen),
        containsTarget,
      );
      walk.seen = walk.seen || matches || containsTarget || onScreen.length > 0;
      const { direction, stuck } = this.plan(
        { screen, focusedElement, onScreen, containsTarget, lastDirection },
        { options, progress, walk },
      );
      const done = this.exitFor(focusedElement, matches, {
        steps,
        stuck,
        maxSteps,
        path,
        seen: walk.seen,
      });
      if (done) {
        const outcome = await this.exit(done, {
          screen,
          focusedElement,
          adjusted: progress.adjusted.size > 0,
          trap,
          refused: progress.blocked,
          select: options.select === true,
          signal,
        });
        if (outcome !== "escaped") {
          return outcome;
        }
        // Every direction gets a fresh try from the same element once the trap is left.
        progress = createFocusProgress();
        await awaitWhileRequestIsLive(this.timer.sleep(settleMs), signal);
        continue;
      }
      if (!direction) {
        throw new ActionableError("focusNavigate has no direction to press");
      }
      probe = rangeProbe(screen, direction, path.length);
      await this.press(direction, signal);
      progress.pressed(direction, containsTarget);
      lastDirection = direction;
      steps += 1;
      // The settle is the walk's longest wait (up to the tool's 5 s cap): a cancel ends it.
      await awaitWhileRequestIsLive(this.timer.sleep(settleMs), signal);
    }
  }

  /**
   * The next press for one read, and the stuck message when no press is left. Until a read holds
   * the target, a row labelled like it is searched first ({@link rowStep}).
   */
  private plan(
    read: {
      screen: FocusScreen;
      focusedElement: FocusPathEntry | undefined;
      onScreen: Element[];
      containsTarget: boolean;
      lastDirection: FocusNavigateDirection | undefined;
    },
    {
      options,
      progress,
      walk,
    }: { options: FocusNavigateOptions; progress: FocusProgress; walk: WalkSearch },
  ): { direction: FocusNavigateDirection | undefined; stuck: string | undefined } {
    const { screen, focusedElement, onScreen, containsTarget, lastDirection } = read;
    const { focused } = screen;
    const row = walk.seen ? undefined : findRowAnchor(screen.elements, options.until);
    const searching = rowStep(focused, row, walk.sweep, progress);
    const direction =
      options.direction ??
      (searching
        ? searching.direction
        : this.nextDirection(
            screen,
            row ? row.elements : walk.planTarget(focused, onScreen),
            progress,
            containsTarget ? lastDirection : undefined,
          ));
    if (containsTarget || !isExhausted(options, progress, direction)) {
      return { direction, stuck: undefined };
    }
    const stuck = walk.seen
      ? stuckMessage(progress, focusedElement)
      : notOnScreenMessage(options.until, row, searching !== undefined, focusedElement);
    return { direction, stuck };
  }

  /** Re-read transient list focus twice before continuing the last press; maxSteps still bounds it. */
  private async readFocus(
    options: FocusNavigateOptions,
    path: FocusPathEntry[],
    canSettle: boolean,
  ) {
    for (let retry = 0; ; retry += 1) {
      throwIfAborted(options.signal);
      const screen = await this.observer.read(options.signal);
      const until = resolveTarget(screen, options);
      const description = describeFocus(screen, until);
      const { focusedElement, containsTarget } = description;
      if (focusedElement && focusKey(focusedElement) !== focusKey(path.at(-1))) {
        path.push(focusedElement);
      }
      if (!containsTarget || !canSettle || retry >= 2) {
        const onScreen = screen.elements.filter((element) => elementMatchesTarget(element, until));
        return { screen, ...description, onScreen };
      }
      await awaitWhileRequestIsLive(
        this.timer.sleep(options.settleMs ?? FOCUS_NAVIGATE_DEFAULT_SETTLE_MS),
        options.signal,
      );
    }
  }

  private exitFor(
    focusedElement: FocusPathEntry | undefined,
    matches: boolean,
    progress: {
      steps: number;
      stuck: string | undefined;
      maxSteps: number;
      path: FocusPathEntry[];
      seen: boolean;
    },
  ): FocusNavigateResult | undefined {
    const { steps, stuck, maxSteps, path, seen } = progress;
    if (matches) {
      return { success: true, status: "focused", steps, path, focusedElement };
    }
    if (stuck) {
      return this.stopped("stuck", steps, path, { focusedElement, message: stuck });
    }
    if (steps >= maxSteps) {
      return this.stopped("max_steps", steps, path, {
        focusedElement,
        message: `Reached maxSteps (${maxSteps})${seen ? "" : " and the target was not on screen in any read"}`,
      });
    }
    return undefined;
  }

  /**
   * The best direction not yet pressed from the focused element. With the target on screen every
   * direction is a candidate, so focus can leave a container that traps it (#17209): directions
   * toward the target first, then the sideways escapes, then a direction that kept moving focus
   * without getting closer (resumed for the rest of the call), and backing away last. Without a
   * match, enter a Leanback header's content pane with right ({@link leanbackEntry}); otherwise
   * scan down.
   */
  private nextDirection(
    screen: Pick<FocusScreen, "focused" | "elements">,
    matches: readonly Element[],
    progress: FocusProgress,
    continuing?: FocusNavigateDirection,
  ): FocusNavigateDirection | undefined {
    // A transient list has no meaningful card centre to steer from; keep entering that row.
    if (continuing) {
      return continuing;
    }
    const { focused } = screen;
    const entry =
      matches.length === 0 ? leanbackEntry(focused, screen.elements, progress) : undefined;
    if (entry) {
      return entry;
    }
    const toward = directionsToward(focused, matches, progress.arrivedBy);
    const candidates =
      focused && matches.length > 0 ? directionsWithFallbacks(toward) : [...toward];
    const untried = candidates.filter((direction) => !progress.tried.has(direction));
    // Backing away from the target retraces the path, so a stalled direction comes before it.
    const away = OPPOSITE[toward[0]];
    const fresh = untried.find(
      (direction) => !progress.stalled.has(direction) && direction !== away,
    );
    if (fresh) {
      return fresh;
    }
    const stalled = untried.find((direction) => progress.stalled.has(direction));
    if (stalled) {
      // Every escape from here failed: keep going the stalled way (a list with no side exit).
      progress.resume(stalled);
      return stalled;
    }
    return untried[0];
  }

  /**
   * After an arrow pressed on a control that reports its own value (#17209): when the same control
   * still holds focus with a different value, press the opposite arrow to put the value back and
   * return the probe. A View SeekBar's up/down move focus, so they read as ordinary moves; a Compose
   * slider on the TV image takes all four arrows, and each is undone once.
   */
  private async undoAdjustment(
    probe: RangeProbe | undefined,
    { screen, matches }: { screen: FocusScreen; matches: boolean },
    signal: AbortSignal | undefined,
  ): Promise<RangeProbe | undefined> {
    // A read that reached the target is never undone, whatever its range reads (#18393).
    if (!probe || matches || !changedOwnRange(probe.before, screen)) {
      return undefined;
    }
    await this.press(OPPOSITE[probe.direction], signal);
    return probe;
  }

  /** How a walk that cannot continue ends: a trap escape to retry from, or the final result. */
  private async exit(
    done: FocusNavigateResult,
    context: ExitContext,
  ): Promise<FocusNavigateResult | "escaped"> {
    const trapped = await this.trapOutcome(done, context);
    return trapped ?? (await this.finish(done, context.select, context.signal));
  }

  /**
   * For a stuck exit with a keyboard or editable field holding focus: "escaped" after new escape
   * keys were pressed, else the stuck result naming the trap. Undefined without a trap.
   */
  private async trapOutcome(
    done: FocusNavigateResult,
    { screen, focusedElement, adjusted, trap, refused, signal }: ExitContext,
  ): Promise<FocusNavigateResult | "escaped" | undefined> {
    const blocker = done.status === "stuck" ? focusBlocker(screen) : undefined;
    if (!blocker) {
      return this.adjustableOutcome(done, { screen, focusedElement, adjusted, trap, signal });
    }
    const pressed = await this.escapeTrap(screen, trap.escapes ?? [], signal);
    trap.escapes = [...(trap.escapes ?? []), ...pressed];
    if (pressed.length > 0) {
      return "escaped";
    }
    return this.stopped("stuck", done.steps, done.path, {
      focusedElement,
      message: trapMessage(blocker, screen, focusedElement, {
        escapes: trap.escapes,
        refused,
      }),
      blockedBy: blocker,
      escapes: trap.escapes,
    });
  }

  /**
   * For a stuck exit on a control that took every arrow it did not refuse as a value change (a
   * slider, #17739): press tab once per control, which moves focus out of it, and retry from there.
   * When the same control is stuck again after its tab, the stuck result says it was tried.
   * Undefined when nothing applies.
   */
  private async adjustableOutcome(
    done: FocusNavigateResult,
    { screen, focusedElement, adjusted, trap, signal }: Omit<ExitContext, "select" | "refused">,
  ): Promise<FocusNavigateResult | "escaped" | undefined> {
    if (done.status !== "stuck" || !adjusted || !screen.focused) {
      return undefined;
    }
    const escapes = trap.escapes ?? [];
    const control = focusKey(focusedElement);
    const tabbedFrom = trap.tabbedFrom ?? new Set<string>();
    if (tabbedFrom.has(control)) {
      return this.stopped("stuck", done.steps, done.path, {
        focusedElement,
        message: `${stripRetryAdvice(done.message)}; pressing tab did not move focus out of it either`,
      });
    }
    throwIfAborted(signal);
    const pressed = await this.keys.press("tab", signal);
    if (!pressed.success) {
      throw new ActionableError(pressed.error ?? "Failed to press tab");
    }
    trap.escapes = [...escapes, "tab"];
    trap.tabbedFrom = tabbedFrom.add(control);
    return "escaped";
  }

  /**
   * Leave a keyboard or text-field focus trap (#17356), each key at most once per call: hide a
   * shown keyboard with back, and press tab when nothing is left over the focused element and tab
   * escapes it: a non-editable element (a slider, #17209) right after back, a Compose text field
   * once the directions retried with the keyboard hidden did not move focus (#17441). A View
   * `EditText` never gets tab. Returns the escapes pressed on this read; empty when none applies.
   */
  private async escapeTrap(
    screen: FocusScreen,
    tried: readonly FocusTrapEscape[],
    signal: AbortSignal | undefined,
  ): Promise<FocusTrapEscape[]> {
    const escapes: FocusTrapEscape[] = [];
    if (screen.imeVisible && this.keyboard && !tried.includes("back")) {
      throwIfAborted(signal);
      const hidden = await this.keyboard.hideKeyboard(signal);
      if (!hidden.success) {
        throw new ActionableError(hidden.error ?? "Failed to hide the on-screen keyboard");
      }
      escapes.push("back");
    }
    if (this.shouldPressTab(screen, tried, escapes)) {
      throwIfAborted(signal);
      const pressed = await this.keys.press("tab", signal);
      if (!pressed.success) {
        throw new ActionableError(pressed.error ?? "Failed to press tab");
      }
      escapes.push("tab");
    }
    return escapes;
  }

  /**
   * Tab after back on the same read only for a non-editable element; an editable field first
   * retries every direction with the keyboard hidden, and gets tab on a later read.
   */
  private shouldPressTab(
    screen: FocusScreen,
    tried: readonly FocusTrapEscape[],
    pressing: readonly FocusTrapEscape[],
  ): boolean {
    const { focused } = screen;
    if (!focused || tried.includes("tab") || !tabEscapes(screen, focused)) {
      return false;
    }
    if (!isEditableElementProperties(focused)) {
      return tried.length === 0;
    }
    return pressing.length === 0 && screen.imeVisible !== true;
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
    {
      focusedElement,
      message,
      blockedBy,
      escapes,
    }: {
      focusedElement: FocusPathEntry | undefined;
      message: string;
      blockedBy?: FocusNavigateBlocker;
      escapes?: FocusTrapEscape[];
    },
  ): FocusNavigateResult {
    return {
      success: false,
      status,
      steps,
      path,
      ...(focusedElement ? { focusedElement } : {}),
      ...(blockedBy ? { blockedBy, escapes: escapes ?? [] } : {}),
      message: `${message}${STOPPED_SUFFIX}`,
    };
  }
}
