import { planStepLabel } from "./sequentialPlanResults";

import { errorMessage } from "../describeUnknownError";
import { PlanStep, DeviceSkippedStepResult } from "../../models/Plan";
import { logger } from "../logger";

import {
  ExecutePlanStepDebugInfo,
  type PlanExecutionOptions,
  type PlanStepToolResult,
  type PlanStepWarnings,
} from "../../models/ExecutePlanResult";
import { throwIfAborted } from "../toolUtils";
import { TrackedStep } from "./PlanPartitioner";

import { isCoordinationTool } from "./BarrierResumeGuard";
import {
  ParticipantFailureTracker,
  type ParticipantFailedError,
} from "./ParticipantFailureTracker";

import { Timer } from "../SystemTimer";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { isDeviceLostError } from "../../models/DeviceLostError";
import { type StepExecutionContext, type StepExecutionResult } from "./PlanStepExecutor";
import { PlanToolResultsBudget, StepToolResultCollector } from "./stepToolResults";
import { redactToolSecrets } from "../redactToolSecrets";

export interface PlanDeviceTrackExecutorContext {
  timer: Timer;
  resolveTrackDeviceId(deviceLabel: string, sessionUuid?: string): string | undefined;
  executeStep(step: PlanStep, context: StepExecutionContext): Promise<StepExecutionResult>;
}
export class PlanDeviceTrackExecutor {
  constructor(private readonly context: PlanDeviceTrackExecutorContext) {}

  async executeDeviceTrack(options: DeviceTrackOptions): Promise<{
    success: boolean;
    executedSteps: number;
    totalSteps: number;
    failedStep?: {
      stepIndex: number;
      trackIndex: number;
      tool: string;
      error: string;
      failureObservation?: FailureObservationSummary;
      /** The step failed only because a participant track had already failed (#10025). */
      participantFailed?: boolean;
    };
    skippedSteps: DeviceSkippedStepResult[];
    steps: ExecutePlanStepDebugInfo[];
    warnings: PlanStepWarnings[];
    toolResults: PlanStepToolResult[];
  }> {
    const {
      device,
      track,
      startStep,
      platform,
      sessionUuid,
      signal,
      participants,
      toolResultsBudget,
    } = options;

    let executedSteps = 0;
    const steps: ExecutePlanStepDebugInfo[] = [];
    const skippedSteps: DeviceSkippedStepResult[] = [];
    const warnings: PlanStepWarnings[] = [];
    const toolResults = new StepToolResultCollector(toolResultsBudget);

    try {
      for (let trackIndex = 0; trackIndex < track.length; trackIndex++) {
        const trackedStep = track[trackIndex];
        const step = trackedStep.step;
        const planIndex = trackedStep.planIndex;

        // Skip steps before startStep
        if (planIndex < startStep) {
          continue;
        }

        // Check for abort
        throwIfAborted(signal);

        const stepLabel = planStepLabel(step);
        logger.info(
          `[PARALLEL_EXEC][${device}] Step ${trackIndex + 1}/${track.length} (plan step ${planIndex}): ${step.tool}, Label: ${stepLabel}`,
        );

        const stepStartTime = this.context.timer.now();
        const { result: stepResult, participantFailure } = await this.executeTrackStep(
          device,
          step,
          planIndex,
          {
            context: {
              platform,
              deviceId: this.context.resolveTrackDeviceId(device, sessionUuid),
              sessionUuid,
              signal,
              logPrefix: `[PARALLEL_EXEC][${device}]`,
              debugLog: true,
            },
            allParticipants: participants,
          },
        );

        this.recordTrackDiagnostics({
          warnings,
          toolResults,
          steps,
          planIndex,
          step,
          device,
          stepResult,
          stepStartTime,
        });

        if (stepResult.status === "skipped") {
          logger.warn(
            `[PARALLEL_EXEC][${device}] optional step ${step.tool} failed; skipping and continuing: ${stepResult.error}`,
          );
          skippedSteps.push({
            stepIndex: planIndex,
            trackIndex,
            tool: step.tool,
            error: stepResult.error ?? "Unknown error",
            durationMs: this.context.timer.now() - stepStartTime,
            details: stepResult.details,
          });
          continue;
        }

        if (stepResult.status === "failed") {
          logger.error(`[PARALLEL_EXEC][${device}] Tool failed: ${stepResult.error}`);
          return {
            success: false,
            executedSteps,
            totalSteps: track.length,
            failedStep: trackStepFailure({
              planIndex,
              trackIndex,
              step,
              stepResult,
              participantFailure,
            }),
            skippedSteps,
            steps,
            warnings,
            toolResults: toolResults.toArray() ?? [],
          };
        }

        executedSteps++;
        logger.debug(
          `[PARALLEL_EXEC][${device}] Step completed successfully. Executed: ${executedSteps}/${track.length}`,
        );
      }

      logger.info(
        `[PARALLEL_EXEC][${device}] Device track completed successfully: ${executedSteps}/${track.length} steps`,
      );

      return {
        success: true,
        executedSteps,
        totalSteps: track.length,
        skippedSteps,
        steps,
        warnings,
        toolResults: toolResults.toArray() ?? [],
      };
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      const errorMsg = errorMessage(error);
      logger.warn(`[PARALLEL_EXEC][${device}] Track execution error: ${errorMsg}`, error);

      return {
        success: false,
        executedSteps,
        totalSteps: track.length,
        failedStep: {
          stepIndex: -1,
          trackIndex: -1,
          tool: "unknown",
          error: errorMsg,
        },
        skippedSteps,
        steps,
        warnings,
        toolResults: toolResults.toArray() ?? [],
      };
    }
  }

  /**
   * Run one step of a device track. A coordination step that a failed participant track can no
   * longer satisfy (#10025) is not run at all: it resolves immediately with that participant's
   * failure, as does a barrier wait that becomes unsatisfiable while the step is parked in it.
   */
  async executeTrackStep(
    device: string,
    step: PlanStep,
    planIndex: number,
    {
      context,
      allParticipants,
    }: { context: StepExecutionContext; allParticipants?: ParticipantFailureTracker },
  ): Promise<{ result: StepExecutionResult; participantFailure?: ParticipantFailedError }> {
    // Only coordination steps can wait on another track, so every other step keeps the plan's
    // own signal untouched.
    const participants = isCoordinationTool(step.tool) ? allParticipants : undefined;
    const begun = participants?.beginStep(device, planIndex, context.signal);
    if (begun && "failure" in begun) {
      const error = begun.failure.message;
      return {
        participantFailure: begun.failure,
        result: {
          status: step.optional ? "skipped" : "failed",
          error,
          details: {
            params: redactToolSecrets(step.tool, step.params),
            error,
            ...(step.optional ? { optional: true } : {}),
          },
        },
      };
    }
    const result = await this.context.executeStep(step, {
      ...context,
      signal: begun ? begun.signal : context.signal,
    });
    participants?.endStep(device);
    return {
      result,
      participantFailure: participants?.interruptionAt(device, planIndex),
    };
  }

  /**
   * Execute a single device track.
   */
  /** Appends a track step to the `debug.steps`-shaped trace the plan health summary reads. */
  recordTrackStep(
    steps: ExecutePlanStepDebugInfo[],
    planIndex: number,
    tool: string,
    {
      stepStatus,
      startedAt,
    }: { stepStatus: ExecutePlanStepDebugInfo["status"]; startedAt: number },
  ): void {
    steps.push({
      step: `Execute step ${planIndex + 1}: ${tool}`,
      status: stepStatus,
      durationMs: this.context.timer.now() - startedAt,
    });
  }
  private recordTrackDiagnostics(options: {
    warnings: PlanStepWarnings[];
    toolResults: StepToolResultCollector;
    steps: ExecutePlanStepDebugInfo[];
    planIndex: number;
    step: PlanStep;
    device: string;
    stepResult: StepExecutionResult;
    stepStartTime: number;
  }): void {
    const { warnings, toolResults, steps, planIndex, step, device, stepResult, stepStartTime } =
      options;
    if (stepResult.warnings) {
      warnings.push({
        stepIndex: planIndex,
        tool: step.tool,
        device,
        warnings: stepResult.warnings,
      });
    }
    if (stepResult.status === "completed") {
      toolResults.add(planIndex, step.tool, stepResult.toolPayload, device);
    }

    this.recordTrackStep(steps, planIndex, step.tool, {
      stepStatus: stepResult.status,
      startedAt: stepStartTime,
    });
  }
}

export interface DeviceTrackOptions {
  device: string;
  track: TrackedStep[];
  startStep: number;
  platform?: string;
  deviceId?: string;
  sessionUuid?: string;
  signal?: AbortSignal;
  executionOptions?: PlanExecutionOptions;
  participants?: ParticipantFailureTracker;
  toolResultsBudget?: PlanToolResultsBudget;
}

function trackStepFailure(options: {
  planIndex: number;
  trackIndex: number;
  step: PlanStep;
  stepResult: StepExecutionResult;
  participantFailure?: ParticipantFailedError;
}): NonNullable<Awaited<ReturnType<PlanDeviceTrackExecutor["executeDeviceTrack"]>>["failedStep"]> {
  const { planIndex, trackIndex, step, stepResult, participantFailure } = options;
  return {
    stepIndex: planIndex,
    trackIndex,
    tool: step.tool,
    error: participantFailure?.message ?? stepResult.error ?? "Unknown error",
    ...(stepResult.failureObservation ? { failureObservation: stepResult.failureObservation } : {}),
    ...(participantFailure ? { participantFailed: true } : {}),
  };
}
