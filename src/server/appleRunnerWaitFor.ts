import { ActionableError } from "../models/ActionableError";
import type { Element, ObserveResult, ViewHierarchyResult } from "../models";
import { NON_IOS_APPLE_PLATFORM_LABELS } from "../models/Platform";
import type { AppleScreenshotOnlyPlatform } from "../models/WatchObservation";
import { ElementResolver, type MatchMode } from "../features/utility/ElementResolver";
import { findFocusedElement } from "../features/observe/HierarchyFocus";
import { evaluateWaitForObservation } from "../features/observe/wait/WaitPredicates";
import type { WaitForObservationOutcome } from "../features/observe/wait/WaitEvaluation";
import type { ObserveWaitForOptions } from "../features/observe/wait/WaitForSchemas";
import { DEFAULT_WAIT_FOR_TIMEOUT_MS } from "../features/observe/waitForTimeout";
import { awaitWhileRequestIsLive, throwIfAborted } from "../utils/toolUtils";
import type { Timer } from "../utils/SystemTimer";

/** Matches the Android/iOS `observe.waitFor` poll cadence. */
export const APPLE_RUNNER_WAIT_FOR_POLL_INTERVAL_MS = 100;

/**
 * waitFor fields that read device state (posture, panels, the foreground window) rather than the
 * runner's element tree; the Apple runners report none of it, so these can never be matched.
 */
const DEVICE_STATE_FIELDS = ["for", "posture", "activeDisplay", "activeWindow"] as const;

export type AppleRunnerWaitOutcome = Omit<WaitForObservationOutcome, "observation">;

/** The tvOS focus wait (#18017): `for: "focused"`, optionally narrowed by elementId and text. */
interface FocusedWaitFor {
  for: "focused";
  elementId?: string;
  text?: string;
}

function isFocusedWaitFor(waitFor: ObserveWaitForOptions): waitFor is FocusedWaitFor {
  return (waitFor as { for?: unknown }).for === "focused";
}

/** Throws when this waitFor needs more than the runner's element tree to be evaluated. */
export function assertAppleRunnerWaitFor(
  waitFor: ObserveWaitForOptions,
  platform: AppleScreenshotOnlyPlatform,
): void {
  const focusWaitAllowed = platform === "tvos" && isFocusedWaitFor(waitFor);
  const refused = DEVICE_STATE_FIELDS.filter(
    (field) =>
      (waitFor as Record<string, unknown>)[field] !== undefined &&
      !(field === "for" && focusWaitAllowed),
  ).map((field) => `waitFor.${field}`);
  if (refused.length > 0) {
    const focusHint =
      platform === "tvos"
        ? ' To wait for focus to settle, use waitFor {for: "focused"} with an optional elementId or text.'
        : "";
    throw new ActionableError(
      `observe with the ${NON_IOS_APPLE_PLATFORM_LABELS[platform]} runner waits only for elements ` +
        `(elementId, testTag, text, textAny, className, contentDescription, absent) and does not ` +
        `support: ${refused.join(", ")}. Remove these options and observe again.${focusHint}`,
    );
  }
}

function focusedElementMatches(focused: Element, waitFor: FocusedWaitFor): boolean {
  if (waitFor.elementId !== undefined && focused["resource-id"] !== waitFor.elementId) {
    return false;
  }
  if (waitFor.text === undefined) {
    return true;
  }
  const wanted = waitFor.text;
  return [focused.text, focused["content-desc"]].some(
    (value) => typeof value === "string" && value.includes(wanted),
  );
}

/** The focused element when it satisfies the focus wait; undefined while focus has not settled. */
function evaluateFocusedWait(
  hierarchy: ViewHierarchyResult,
  waitFor: FocusedWaitFor,
): { matched: boolean; awaitedElement?: Element } {
  const focused = findFocusedElement(hierarchy);
  return focused && focusedElementMatches(focused, waitFor)
    ? { matched: true, awaitedElement: focused }
    : { matched: false };
}

function waitTimeout(waitFor: ObserveWaitForOptions): number {
  const { timeout, timeoutMs } = waitFor as { timeout?: number; timeoutMs?: number };
  return timeout ?? timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
}

/**
 * Poll the runner hierarchy until the element waitFor matches or its timeout elapses (#17309).
 * Each poll is evaluated by the same predicates the Android/iOS `observe.waitFor` uses; a poll
 * that returns no hierarchy (an app not in the foreground) is an unmatched poll.
 */
export async function pollAppleRunnerWaitFor(
  waitFor: ObserveWaitForOptions,
  readHierarchy: () => Promise<ViewHierarchyResult | undefined>,
  { timer, signal }: { timer: Timer; signal?: AbortSignal },
): Promise<{ hierarchy: ViewHierarchyResult | undefined; outcome: AppleRunnerWaitOutcome }> {
  const timeoutMs = waitTimeout(waitFor);
  const startTime = timer.now();
  const finder = new ElementResolver();
  const modes = new Map<string, MatchMode>();
  let polls = 0;
  for (;;) {
    throwIfAborted(signal);
    const hierarchy = await readHierarchy();
    throwIfAborted(signal);
    polls++;
    const evaluation = !hierarchy
      ? { matched: false }
      : isFocusedWaitFor(waitFor)
        ? evaluateFocusedWait(hierarchy, waitFor)
        : evaluateWaitForObservation(
            finder,
            waitFor,
            { viewHierarchy: hierarchy } as ObserveResult,
            {
              // Runner hierarchies are iOS-shaped: accessibility labels arrive as `text`, so keep
              // the iOS contentDescription-to-text fallback.
              devicePlatform: "ios",
              displayInventory: "unavailable",
              modes,
              iosMultiPanel: false,
            },
          );
    const waitMs = timer.now() - startTime;
    const timedOut = !evaluation.matched && waitMs >= timeoutMs;
    if (evaluation.matched || timedOut) {
      const awaitedElement = "awaitedElement" in evaluation ? evaluation.awaitedElement : undefined;
      return {
        hierarchy,
        outcome: {
          awaitedElement,
          matchedElement: awaitedElement,
          awaitDuration: waitMs,
          awaitTimeout: timedOut,
          matched: evaluation.matched,
          timedOut,
          ...(timedOut ? { timeoutReason: `waitFor not satisfied after ${waitMs}ms` } : {}),
          polls,
          waitMs,
        },
      };
    }
    await awaitWhileRequestIsLive(timer.sleep(APPLE_RUNNER_WAIT_FOR_POLL_INTERVAL_MS), signal);
  }
}
