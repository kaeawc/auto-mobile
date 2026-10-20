import type { PlanExecutionResult, DeviceExecutionResult, AbortStrategy } from "../../models/Plan";
import type { PlanStepToolResult, PlanDeviceFailure } from "../../models/ExecutePlanResult";
import { PlanToolResultsBudget, StepToolResultCollector } from "./stepToolResults";
import type { PlanDeviceTrackExecutor } from "./PlanDeviceTrackExecutor";
import type { ParticipantFailureTracker } from "./ParticipantFailureTracker";
import type { Timer } from "../SystemTimer";
import { logger } from "../logger";

/** Every device track's `toolResults`, ordered by plan step index, or nothing when none ran. */
export function mergedToolResultsField(
  tracks: { toolResults: PlanStepToolResult[] }[],
  budget: PlanToolResultsBudget,
): ReturnType<StepToolResultCollector["asField"]> {
  const toolResults = tracks
    .flatMap((track) => track.toolResults)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  return { ...(toolResults.length > 0 ? { toolResults } : {}), ...budget.asField() };
}

export interface ParallelTrackFailure {
  failedStep: NonNullable<PlanExecutionResult["failedStep"]>;
  deviceOrder: number;
  abortConsequence: boolean;
}

/** Real causes first, then plan index (-1 last), then declared device order. */
function compareParallelFailures(a: ParallelTrackFailure, b: ParallelTrackFailure): number {
  if (a.abortConsequence !== b.abortConsequence) {
    return a.abortConsequence ? 1 : -1;
  }
  const aIndex = a.failedStep.stepIndex === -1 ? Infinity : a.failedStep.stepIndex;
  const bIndex = b.failedStep.stepIndex === -1 ? Infinity : b.failedStep.stepIndex;
  if (aIndex !== bIndex) {
    return aIndex < bIndex ? -1 : 1;
  }
  return a.deviceOrder - b.deviceOrder;
}

/** Omit the summary for successful plans and one-device partitions. */
export function parallelDeviceFailuresField(
  failures: readonly ParallelTrackFailure[],
  devices: readonly string[],
): { deviceFailures?: PlanDeviceFailure[] } {
  if (devices.length < 2 || failures.length === 0) {
    return {};
  }
  return {
    deviceFailures: [...failures]
      .sort(compareParallelFailures)
      .map(({ failedStep, deviceOrder, abortConsequence }, index) => {
        const { failureObservation, ...failure } = failedStep;
        return {
          ...failure,
          device: devices[deviceOrder],
          ...(index > 0 && !abortConsequence && failureObservation ? { failureObservation } : {}),
        };
      }),
  };
}

/** Choose a stable failure after all tracks settle, preserving the abort's cause. */
export function selectParallelFailure(
  failures: readonly ParallelTrackFailure[],
): PlanExecutionResult["failedStep"] {
  let selected: ParallelTrackFailure | undefined;
  for (const candidate of failures) {
    if (!selected || compareParallelFailures(candidate, selected) < 0) {
      selected = candidate;
    }
  }
  return selected?.failedStep;
}
interface ParallelTrackResultOptions {
  result: Awaited<ReturnType<PlanDeviceTrackExecutor["executeDeviceTrack"]>>;
  internalAbortController: AbortController;
  debugMode: boolean;
  deviceStartTime: number;
  totalSteps: number;
  device: string;
  perDeviceResults: Map<string, DeviceExecutionResult>;
  failures: ParallelTrackFailure[];
  deviceOrder: number;
  abortStrategy: AbortStrategy;
  participants: ParticipantFailureTracker;
  timer: Timer;
}
function parallelDeviceResult(options: ParallelTrackResultOptions): DeviceExecutionResult {
  const { result, device, totalSteps, debugMode, timer, deviceStartTime } = options;
  const deviceResult: DeviceExecutionResult = {
    device,
    success: result.success,
    executedSteps: result.executedSteps,
    totalSteps: totalSteps,
    skippedSteps: result.skippedSteps.length > 0 ? result.skippedSteps : undefined,
    steps: result.steps,
    executionTimeMs: debugMode ? timer.now() - deviceStartTime : undefined,
    failedStep: result.failedStep
      ? {
          stepIndex: result.failedStep.stepIndex,
          trackIndex: result.failedStep.trackIndex,
          tool: result.failedStep.tool,
          error: result.failedStep.error,
          failureObservation: result.failedStep.failureObservation,
        }
      : undefined,
  };

  return deviceResult;
}
export function recordParallelTrackResult(options: ParallelTrackResultOptions): void {
  const {
    result,
    internalAbortController,
    device,
    perDeviceResults,
    failures,
    deviceOrder,
    abortStrategy,
    participants,
  } = options;
  // An ordinary failing callback aborts synchronously below. Failures
  // observed after that abort may be cancelled siblings, even at a lower
  // real plan index. Keep them in perDeviceResults but prefer the cause.
  // A coordination step that failed only because a participant track had
  // already failed is the same kind of symptom (#10025).
  const abortConsequence =
    internalAbortController.signal.aborted || result.failedStep?.participantFailed === true;

  const deviceResult = parallelDeviceResult(options);

  perDeviceResults.set(device, deviceResult);

  if (!result.success) {
    logger.error(
      `[PARALLEL_EXEC][${device}] Device track failed at step ${result.failedStep?.stepIndex}`,
    );

    if (result.failedStep) {
      failures.push({
        failedStep: {
          device,
          stepIndex: result.failedStep.stepIndex,
          tool: result.failedStep.tool,
          error: result.failedStep.error,
          failureObservation: result.failedStep.failureObservation,
        },
        deviceOrder,
        abortConsequence,
      });
    }

    // Trigger abort based on strategy
    if (abortStrategy === "immediate") {
      logger.info(`[PARALLEL_EXEC] Aborting all devices immediately due to failure on ${device}`);
      internalAbortController.abort();
    }
    // For "finish-current-step", other devices finish naturally, except that a
    // barrier/criticalSection the failed track will never reach fails promptly.
    if (abortStrategy === "finish-current-step" && result.failedStep) {
      participants.trackFailed(device, result.failedStep);
    }
  }
}

export function logParallelDeviceResults(options: {
  debugMode: boolean;
  allSucceeded: boolean;
  perDeviceResults: Map<string, DeviceExecutionResult>;
}): void {
  const { debugMode, allSucceeded, perDeviceResults } = options;
  // Log per-device timing in debug mode or on failure
  if (debugMode || !allSucceeded) {
    logger.info(`[PARALLEL_EXEC] Per-device results:`);
    for (const [device, result] of perDeviceResults.entries()) {
      const timing = result.executionTimeMs ? ` (${result.executionTimeMs}ms)` : "";
      const status = result.success ? "SUCCESS" : "FAILED";
      logger.info(
        `[PARALLEL_EXEC]   ${device}: ${status} - ${result.executedSteps}/${result.totalSteps} steps${timing}`,
      );
      if (result.failedStep) {
        logger.error(
          `[PARALLEL_EXEC]   ${device}: Failed at plan step ${result.failedStep.stepIndex} (track step ${result.failedStep.trackIndex}): ${result.failedStep.error}`,
        );
      }
    }
  }
}
