import { ActionableError, type BootedDevice, type SwipeDirection } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted } from "../../utils/toolUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { NavigationEdge, ScrollPosition } from "../../utils/interfaces/NavigationGraph";
import { SwipeOn } from "../action/swipeon";

/** The element a replayed `tapOn` targets, as `swipeOn lookFor` can describe it. */
export interface ReplayLookFor {
  elementId?: string;
  text?: string;
}

/** Scroll container, in `swipeOn`'s container-selector shape. */
export interface ReplayScrollContainer {
  elementId?: string;
  text?: string;
}

export interface ReplayScrollSearchRequest {
  lookFor: ReplayLookFor;
  direction: SwipeDirection;
  /** The container the edge was recorded in; absent means the screen's primary scrollable. */
  container?: ReplayScrollContainer;
  /** Hard cap on search swipes. */
  maxSwipes: number;
  /** Hard cap on the search's duration, from the remaining navigateTo budget. */
  maxTimeMs: number;
}

export interface ReplayScrollSearchOutcome {
  found: boolean;
  /** Why the search ended without the element (the scroll machinery's own message). */
  detail?: string;
}

/**
 * Scrolls the screen until an element is visible, the way an interactive
 * `swipeOn lookFor` does. A narrow seam so navigateTo's replay tests inject a fake
 * instead of driving the real scroll loop.
 *
 * Contract: resolves `{ found: true }` once the element is on screen, `{ found:
 * false }` when the bounded search ended without it, and rejects only for
 * cancellation or an unexpected failure.
 */
export interface ReplayScrollSearcher {
  search(
    request: ReplayScrollSearchRequest,
    signal?: AbortSignal,
  ): Promise<ReplayScrollSearchOutcome>;
}

/**
 * A replay step that failed because the screen is not positioned the way the edge
 * needs, not because the edge is broken. navigateTo ranks the edge last for the rest of
 * the call so a fallback runs first, and settles it when the call ends
 * (`settleTransientEdgeFailure`) instead of demoting it outright. `searched` is whether
 * a scroll search ran and came up empty: only those misses count towards a lasting
 * demotion, because a refused replay says nothing about whether the target exists.
 */
export class ReplayTransientError extends ActionableError {
  constructor(
    message: string,
    readonly searched: boolean,
  ) {
    super(message);
  }
}

/**
 * A replayed `tapOn` whose target is not on screen and was not found by the bounded
 * scroll search either. Unlike a tap that found its element and still missed, a single
 * one says nothing about whether the edge works when the list is positioned
 * differently; repeated ones do (see `settleTransientEdgeFailure`).
 */
export class ReplayTargetNotFoundError extends ReplayTransientError {
  constructor(message: string) {
    super(message, true);
  }
}

/**
 * A replay refused because an earlier failed search in the same call left the list
 * scrolled to an unknown position: an edge addressed by recorded coordinates would tap
 * whatever is there now.
 */
export class ReplayScrollDisturbedError extends ReplayTransientError {
  constructor(message: string) {
    super(message, false);
  }
}

/** One edge a navigateTo call remembered as failed only because its target was missing. */
export interface TransientEdgeFailure {
  edge: NavigationEdge;
  searched: boolean;
}

/**
 * What the replay scroll searches of ONE navigateTo call have done so far: the time
 * they spent (capped across steps), the direction the last failed search scrolled
 * (the list is left wherever that search ended), and the edges that call must settle.
 */
export class ReplayRunState {
  searchMs = 0;
  disturbedDirection: SwipeDirection | undefined;
  readonly transientFailures: TransientEdgeFailure[] = [];
}

/**
 * Whether the edge replays recorded screen coordinates rather than resolving a
 * selector on a fresh observation, so it is only valid on the screen position it was
 * recorded in.
 */
export function isCoordinateAddressed(toolName: string, args: Record<string, unknown>): boolean {
  return toolName === "tapAt" || (typeof args.x === "number" && typeof args.y === "number");
}

/** tapOn reports a missing target as `Element not found with provided …` (a missing container differs). */
const ELEMENT_NOT_FOUND = /\bElement not found\b/;

export function isElementNotFoundFailure(error: unknown): boolean {
  return error instanceof ActionableError && ELEMENT_NOT_FOUND.test(error.message);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The selector `lookFor` can search for, from a recorded `tapOn`'s arguments: either
 * the nested `selector: { … }` form or flat top-level `text` / `elementId`. Selectors
 * `lookFor` cannot express (test tags, `textAny`, …) return undefined.
 */
export function replayLookForFor(args: Record<string, unknown>): ReplayLookFor | undefined {
  const nested = args.selector;
  const selector =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : args;
  const elementId = nonEmptyString(selector.elementId);
  if (elementId) {
    return { elementId };
  }
  const text = nonEmptyString(selector.text);
  return text ? { text } : undefined;
}

/** The scroll the edge stored, when it stores one; explore does not record it today. */
export function replayScrollContainer(
  scrollPosition: ScrollPosition | undefined,
): ReplayScrollContainer | undefined {
  const container = scrollPosition?.container;
  const elementId = nonEmptyString(container?.resourceId);
  if (elementId) {
    return { elementId };
  }
  const text = nonEmptyString(container?.text);
  return text ? { text } : undefined;
}

/**
 * Default searcher: the same `SwipeOn` scroll-until-visible loop `swipeOn lookFor`
 * runs, bounded by its internal `maxTime` / `maxSwipes` lookFor limits. It is driven
 * directly (not through the tool registry) because the public tool schema does not
 * expose those limits, and so the search is not recorded as an interaction.
 */
export class SwipeOnReplayScrollSearcher implements ReplayScrollSearcher {
  private swipeOn: Pick<SwipeOn, "execute"> | undefined;

  constructor(
    private readonly device: BootedDevice,
    private readonly timer: Timer,
    swipeOn?: Pick<SwipeOn, "execute">,
  ) {
    this.swipeOn = swipeOn;
  }

  /** Built on first use: constructing SwipeOn wires up display and accessibility readers. */
  private getSwipeOn(): Pick<SwipeOn, "execute"> {
    this.swipeOn ??= new SwipeOn(this.device, null, { timer: this.timer });
    return this.swipeOn;
  }

  async search(
    request: ReplayScrollSearchRequest,
    signal?: AbortSignal,
  ): Promise<ReplayScrollSearchOutcome> {
    throwIfAborted(signal);
    try {
      const result = await this.getSwipeOn().execute(
        {
          direction: request.direction,
          autoTarget: true,
          includeSystemInsets: false,
          ...(request.container ? { container: request.container } : {}),
          lookFor: {
            ...request.lookFor,
            maxTime: request.maxTimeMs,
            maxSwipes: request.maxSwipes,
          },
        },
        undefined,
        signal,
      );
      throwIfAborted(signal);
      return result.success && result.found === true
        ? { found: true }
        : { found: false, detail: result.error ?? "the element did not come into view" };
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof ActionableError)) {
        throw error;
      }
      // The scroll machinery reports "not found" and "could not swipe" as an ActionableError.
      logger.warn(`[NAVIGATE_TO] Replay scroll search failed: ${errorMessage(error)}`, error);
      return { found: false, detail: error.message };
    }
  }
}
