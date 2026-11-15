/**
 * What one FocusNavigate call has learned about the focused element's presses: refused, tried,
 * stalled and value-changing directions (#17315, #17739, #17209), and the stuck message they give.
 */

import type { FocusPathEntry, FocusScreen } from "./FocusNavigate";
import { ownRangeOf, type FocusIdentity, type FocusRangeRead } from "./FocusIdentity";
import { FOCUS_NAVIGATE_DIRECTIONS, type FocusNavigateDirection } from "./FocusNavigateDirections";
import { describeEntry } from "./FocusTrapMessage";

/**
 * Consecutive presses in one direction that move focus without bringing it closer to the target
 * (a long list scrolling under a fixed focus slot, a slider changing its value) before that
 * direction is tried last, until focus moves another way or closes distance.
 */
export const FOCUS_NAVIGATE_STALL_PRESSES = 3;

/** Tracks whether presses move focus, and toward the target, across one navigation call. */
export interface FocusProgress {
  readonly unchanged: number;
  /** Directions that did not move focus off this element during this navigation call. */
  readonly blocked: ReadonlySet<FocusNavigateDirection>;
  /** Directions already pressed from this element; pressing one again leads where it led before. */
  readonly tried: ReadonlySet<FocusNavigateDirection>;
  /** Directions that kept moving focus without closing distance; tried after every other one. */
  readonly stalled: ReadonlySet<FocusNavigateDirection>;
  /** The direction of the press that moved focus onto the current element, if known. */
  readonly arrivedBy: FocusNavigateDirection | undefined;
  /** Directions the focused control consumed by changing its own value instead of moving focus. */
  readonly adjusted: ReadonlySet<FocusNavigateDirection>;
  /** Adjusting directions whose value change the walk undid with the opposite arrow (#17209). */
  readonly restored: ReadonlySet<FocusNavigateDirection>;
  /** Records that the last press changed the focused control's value and was undone (#17209). */
  restoredAdjustment(direction: FocusNavigateDirection): void;
  /** Presses a stalled direction again because every escape from it failed; it stays undemoted. */
  resume(direction: FocusNavigateDirection): void;
  /**
   * Records an observation and the focused element's distance to the target (undefined when
   * either is missing). Container-only focus leaves the last control's progress intact.
   */
  observe(identity: FocusIdentity, distance: number | undefined, containsTarget: boolean): void;
  pressed(direction: FocusNavigateDirection, containsTarget: boolean): void;
}

interface ElementMemory {
  blocked: Set<FocusNavigateDirection>;
  tried: Set<FocusNavigateDirection>;
  adjusted: Set<FocusNavigateDirection>;
  restored: Set<FocusNavigateDirection>;
}

function emptyMemory(): ElementMemory {
  return { blocked: new Set(), tried: new Set(), adjusted: new Set(), restored: new Set() };
}

/** An arrow pressed on a control that reports its own value, to read back after it (#17209). */
export interface RangeProbe {
  direction: FocusNavigateDirection;
  before: FocusRangeRead;
  /** The path's length before the press, to drop the read of a changed value from it. */
  pathLength: number;
}

export function rangeProbe(
  screen: FocusScreen,
  direction: FocusNavigateDirection,
  pathLength: number,
): RangeProbe | undefined {
  const before = ownRangeOf(screen);
  return before ? { direction, before, pathLength } : undefined;
}

/** Tracks presses in one direction that move focus without bringing it closer to the target. */
function createStallTracker() {
  const stalled = new Set<FocusNavigateDirection>();
  /** Directions resumed after their escapes failed; demoting them again would only repeat that. */
  const resumed = new Set<FocusNavigateDirection>();
  let previous: number | undefined;
  let run: { direction: FocusNavigateDirection; presses: number } | undefined;
  return {
    stalled,
    resume(direction: FocusNavigateDirection) {
      resumed.add(direction);
      stalled.delete(direction);
    },
    /** `moved` is the direction of the press that moved focus, if the last press did. */
    observe(distance: number | undefined, moved: FocusNavigateDirection | undefined) {
      const before = previous;
      previous = distance;
      if (!moved || distance === undefined || before === undefined) {
        run = undefined;
        return;
      }
      if (!stalled.has(moved) || distance < before) {
        // Focus left the stall another way, or the stalled direction got closer after all.
        stalled.clear();
      }
      if (distance < before) {
        run = undefined;
        return;
      }
      const presses = run?.direction === moved ? run.presses + 1 : 1;
      run = { direction: moved, presses };
      if (presses >= FOCUS_NAVIGATE_STALL_PRESSES) {
        if (!resumed.has(moved)) {
          stalled.add(moved);
        }
      }
    },
  };
}

export function createFocusProgress(): FocusProgress {
  const memoryByElement = new Map<string, ElementMemory>();
  const stall = createStallTracker();
  let memory = emptyMemory();
  let unchanged = 0;
  let previousKey: string | undefined;
  let lastDirection: FocusNavigateDirection | undefined;
  let arrivedBy: FocusNavigateDirection | undefined;
  return {
    get arrivedBy() {
      return arrivedBy;
    },
    get unchanged() {
      return unchanged;
    },
    get blocked() {
      return memory.blocked;
    },
    get tried() {
      return memory.tried;
    },
    get adjusted() {
      return memory.adjusted;
    },
    get restored() {
      return memory.restored;
    },
    restoredAdjustment(direction) {
      memory.adjusted.add(direction);
      memory.restored.add(direction);
    },
    stalled: stall.stalled,
    resume: (direction) => stall.resume(direction),
    observe({ key, replaces, changedInPlace }, distance, containsTarget) {
      // A container read cannot prove a refused arrow or movement away from the target.
      if (containsTarget) {
        return;
      }
      if (replaces !== undefined && replaces === previousKey) {
        // The control changed its own value: carry what was learned there to its label-free key.
        memoryByElement.set(key, memory);
        previousKey = key;
      }
      const didNotMove = previousKey !== undefined && key === previousKey;
      unchanged = didNotMove ? unchanged + 1 : 0;
      if (!didNotMove) {
        memory = memoryByElement.get(key) ?? emptyMemory();
        memoryByElement.set(key, memory);
      } else if (lastDirection) {
        memory.blocked.add(lastDirection);
        if (changedInPlace) {
          memory.adjusted.add(lastDirection);
        }
      }
      if (!didNotMove) {
        // A refused press in between (down off a slider) does not end a run of presses that keep
        // changing the control without getting closer (#17209).
        stall.observe(distance, lastDirection);
      }
      arrivedBy = didNotMove ? arrivedBy : lastDirection;
      previousKey = key;
      lastDirection = undefined;
    },
    pressed(direction, containsTarget) {
      if (containsTarget) {
        return;
      }
      memory.tried.add(direction);
      lastDirection = direction;
    },
  };
}

export function stuckMessage(progress: FocusProgress, focusedElement?: FocusPathEntry): string {
  const { unchanged, blocked, tried, adjusted, restored } = progress;
  const unmoved = Math.max(1, unchanged, blocked.size);
  const presses = `${unmoved} ${unmoved === 1 ? "press" : "presses"}`;
  const base =
    blocked.size < tried.size
      ? `Every D-pad direction from the focused element was tried; focus did not move after ${presses}`
      : `Focus did not move after ${presses}`;
  if (adjusted.size === 0) {
    return base;
  }
  // Say why: the control took the arrows as value changes (a slider), and it was left changed.
  const directions = FOCUS_NAVIGATE_DIRECTIONS.filter((direction) => adjusted.has(direction));
  const value = directions.every((direction) => restored.has(direction))
    ? "and each change was undone with the opposite arrow"
    : "so its value may have changed";
  return `${base}; the focused control${describeEntry(focusedElement)} consumed ${directions.join(" and ")} by changing its own value instead of moving focus, ${value}`;
}
