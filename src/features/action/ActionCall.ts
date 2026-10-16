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
  /** Absolute wall-clock deadline (ms) the whole request must finish by. */
  deadlineMs?: number;
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

/** `ActionCall` for tapOn: also carries the keyboard-occlusion recovery policy. */
export interface TapOnCall extends ActionCall {
  recovery?: { throwOnKeyboardOcclusion?: boolean };
}

/** `ActionCall` for tapAt: also carries the plan context. */
export interface TapAtCall<PlanContext> extends ActionCall {
  planContext?: PlanContext;
}

/** Normalizes the `TapOnCall` form and the deprecated positional `(progress, signal, recovery, request)`. */
export function resolveTapOnCall(
  progressOrCall?: ProgressCallback | TapOnCall,
  signal?: AbortSignal,
  recovery?: { throwOnKeyboardOcclusion?: boolean },
  request?: { requestDeadlineMs?: number },
): TapOnCall {
  if (typeof progressOrCall === "object" && progressOrCall !== null) {
    return progressOrCall;
  }
  return { progress: progressOrCall, signal, recovery, deadlineMs: request?.requestDeadlineMs };
}

/** Normalizes the `ActionCall` form and the deprecated positional `(progress, signal, request)`. */
export function resolveDeadlineActionCall(
  progressOrCall?: ProgressCallback | ActionCall,
  signal?: AbortSignal,
  request?: { requestDeadlineMs?: number },
): ActionCall {
  if (typeof progressOrCall === "object" && progressOrCall !== null) {
    return progressOrCall;
  }
  return { progress: progressOrCall, signal, deadlineMs: request?.requestDeadlineMs };
}

/** Normalizes the `TapAtCall` form and the deprecated positional `(progress, signal, planContext)`. */
export function resolveTapAtCall<PlanContext>(
  progressOrCall?: ProgressCallback | TapAtCall<PlanContext>,
  signal?: AbortSignal,
  planContext?: PlanContext,
): TapAtCall<PlanContext> {
  if (typeof progressOrCall === "object" && progressOrCall !== null) {
    return progressOrCall;
  }
  return { progress: progressOrCall, signal, planContext };
}

/** The legacy `{ requestDeadlineMs }` carrier the internal read-scope helpers still take. */
export function deadlineRequest(deadlineMs?: number): { requestDeadlineMs?: number } | undefined {
  return deadlineMs === undefined ? undefined : { requestDeadlineMs: deadlineMs };
}

/** An `AbortSignal` has a boolean `aborted`; an `ActionCall` never does. */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

/** Normalizes `(signal)` and `(call)` for actions whose only positional tail was a signal. */
export function resolveSignalCall(signalOrCall?: AbortSignal | ActionCall): ActionCall {
  if (signalOrCall === undefined || isAbortSignal(signalOrCall)) {
    return { signal: signalOrCall };
  }
  return signalOrCall;
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
