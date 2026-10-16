import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { ProgressCallback } from "./BaseVisualChange";

/**
 * Request-scoped context passed to an action's `execute` instead of a positional
 * `progress, signal, ...` tail. Fields are added as action families migrate (#11835);
 * tool-specific policy belongs in an extension of this type, never another positional.
 */
export interface ActionCall {
  signal?: AbortSignal;
  progress?: ProgressCallback;
  /** Performance tracker for actions that thread one explicitly (scroll search). */
  perf?: PerformanceTracker;
}

/** Normalizes the `ActionCall` form and the deprecated positional `(progress, perf, signal)` form. */
export function resolveActionCallWithPerf(
  progressOrCall?: ProgressCallback | ActionCall,
  perf?: PerformanceTracker,
  signal?: AbortSignal,
): ActionCall {
  if (typeof progressOrCall === "object" && progressOrCall !== null) {
    return progressOrCall;
  }
  return { progress: progressOrCall, perf, signal };
}

/** `ActionCall` for rotation, which also carries the orientation lock and target display. */
export interface RotateCall extends ActionCall {
  lockOrientation?: boolean;
  display?: number;
}

/**
 * Normalizes the `ActionCall` form and the deprecated positional `(progress, signal)` form.
 * A progress callback is a function and a call context is an object, which tells them apart.
 */
export function resolveActionCall(
  progressOrCall?: ProgressCallback | ActionCall,
  signal?: AbortSignal,
): ActionCall {
  if (typeof progressOrCall === "object" && progressOrCall !== null) {
    return progressOrCall;
  }
  return { progress: progressOrCall, signal };
}

/** Normalizes the `RotateCall` form and the deprecated positional rotate tail. */
export function resolveRotateCall(
  progressOrCall?: ProgressCallback | RotateCall,
  lockOrientation?: boolean,
  signal?: AbortSignal,
  display?: number,
): RotateCall {
  if (typeof progressOrCall === "object" && progressOrCall !== null) {
    return progressOrCall;
  }
  return { progress: progressOrCall, lockOrientation, signal, display };
}
