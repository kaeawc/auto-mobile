import { ActionableError, type BootedDevice, type SwipeDirection } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted } from "../../utils/toolUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { ScrollPosition } from "../../utils/interfaces/NavigationGraph";
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
 * A replayed `tapOn` whose target is not on screen and was not found by the bounded
 * scroll search either. Unlike a tap that found its element and still missed, this
 * says nothing about whether the edge works when the list is positioned differently,
 * so navigateTo does not remember it as a failed edge.
 */
export class ReplayTargetNotFoundError extends ActionableError {}

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
