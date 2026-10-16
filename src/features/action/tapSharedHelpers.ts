import type { ViewHierarchyResult } from "../../models";
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
