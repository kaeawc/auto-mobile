import type { Element, ViewHierarchyResult } from "../../models";
import { LONG_PRESS_HARD_MAX_MS } from "./tapAtGesture";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { ActionableError } from "../../models/ActionableError";
import { AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbClient";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";

/** Helpers shared by TapOnElement and TapAnyElement (#11832). */

// Fallback for injected selectors that predate `hasContainer`; resolver semantics, no finder.
const defaultContainerSelector = new ResolverElementSelector();

/** Rethrow an interrupted Android long press as an error naming how long the press may stay held. */
export function throwIfLongPressInterrupted(
  error: unknown,
  durationMs: number,
  signal?: AbortSignal,
): void {
  if (
    signal?.aborted ||
    error instanceof AdbCommandTimeoutError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    // Killing host adb cannot cancel input's system_server injection.
    throw new ActionableError(
      `Android long press interrupted; press may still be held on the device for up to ${durationMs} ms. Wait ${durationMs} ms before retrying touch input.`,
      { cause: error },
    );
  }
}

/** Validate and normalize `searchUntil.duration` against the caller's bounds. */
export function resolveSearchUntilDuration(
  requested: number | undefined,
  bounds: { defaultMs: number; minMs: number; maxMs: number },
): number {
  const duration = requested ?? bounds.defaultMs;
  if (!Number.isFinite(duration)) {
    throw new ActionableError("searchUntil.duration must be a number");
  }
  if (duration < bounds.minMs) {
    throw new ActionableError(`searchUntil.duration must be at least ${bounds.minMs}ms`);
  }
  if (duration > bounds.maxMs) {
    throw new ActionableError(`searchUntil.duration must be at most ${bounds.maxMs}ms`);
  }
  return Math.round(duration);
}

/** True when no container is requested or the selector (or the default resolver) finds it. */
export function isContainerAvailable(
  elementSelector: ElementSelector,
  viewHierarchy: ViewHierarchyResult,
  container?: ElementContainerSelector,
): boolean {
  if (!container) {
    return true;
  }
  return (
    elementSelector.hasContainer?.(viewHierarchy, container) ??
    defaultContainerSelector.hasContainer(viewHierarchy, container)
  );
}

/** Error text when `container` does not name exactly one of elementId or text; null when valid. */
export function containerSelectorError(
  container: ElementContainerSelector | undefined,
  tool: string,
): string | null {
  if (!container) {
    return null;
  }
  const selectorCount = [container.elementId, container.text].filter(Boolean).length;
  return selectorCount === 1
    ? null
    : `${tool} container must specify exactly one of elementId or text`;
}

/** Reject a longPress duration beyond the hard ceiling before any device command runs. */
export function assertLongPressWithinHardMax(durationMs: number | undefined): void {
  if (durationMs !== undefined && durationMs > LONG_PRESS_HARD_MAX_MS) {
    throw new ActionableError(
      `longPress duration too large; maximum is ${LONG_PRESS_HARD_MAX_MS} ms; requested ${durationMs} ms`,
    );
  }
}

/** The failed-result base shared by both tap tools: an empty element at the origin. */
export function failedTapResult(action: string, error: string) {
  return {
    success: false as const,
    action,
    error,
    element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } } as Element,
  };
}
