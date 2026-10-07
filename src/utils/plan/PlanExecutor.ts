import { errorMessage } from "../describeUnknownError";
import {
  Plan,
  PlanStep,
  PlanExecutionResult,
  DeviceExecutionResult,
  DeviceSkippedStepResult,
  AbortStrategy,
  DEFAULT_ABORT_STRATEGY,
} from "../../models/Plan";
import { logger, type Logger } from "../logger";
import { ToolRegistry, type RegisteredTool } from "../../server/toolRegistry";
import { ActionableError } from "../../models";
import { isDebugModeEnabled } from "../debug";
import {
  ExecutePlanStepDebugInfo,
  type PlanExecutionOptions,
  type PlanStepToolResult,
  type PlanStepWarnings,
  type PlanSkippedStep,
  type PlanDeviceFailure,
} from "../../models/ExecutePlanResult";
import { throwIfAborted } from "../toolUtils";
import { PlanPartitioner, TrackedStep } from "./PlanPartitioner";
import { getPlanDevicePlatform } from "./PlanDevices";
import { computeSafeBarrierResumeStep, isCoordinationTool } from "./BarrierResumeGuard";
import {
  ParticipantFailureTracker,
  type ParticipantFailedError,
} from "./ParticipantFailureTracker";
import { DaemonState } from "../../daemon/daemonState";
import { Timer, defaultTimer } from "../SystemTimer";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import {
  type DeviceLostError,
  isDeviceLostError,
  rememberDeviceLossAbort,
} from "../../models/DeviceLostError";
import {
  DefaultPlanStepExecutor,
  type StepExecutionContext,
  type StepExecutionResult,
} from "./PlanStepExecutor";

import { PlanToolResultsBudget, StepToolResultCollector } from "./stepToolResults";

export { UNEVALUATED_EXPECTATIONS_WARNING } from "./planStepParams";

/** Every device track's `toolResults`, ordered by plan step index, or nothing when none ran. */
function mergedToolResultsField(
  tracks: { toolResults: PlanStepToolResult[] }[],
  budget: PlanToolResultsBudget,
): ReturnType<StepToolResultCollector["asField"]> {
  const toolResults = tracks
    .flatMap((track) => track.toolResults)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  return { ...(toolResults.length > 0 ? { toolResults } : {}), ...budget.asField() };
}

interface ParallelTrackFailure {
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
function parallelDeviceFailuresField(
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

/**
 * Interface for plan execution
 * Handles execution of plan steps sequentially or in parallel (multi-device)
 */
export interface PlanExecutor {
  /**
   * Execute a plan step by step
   * @param plan Plan to execute
   * @param startStep Starting step index (default 0)
   * @param platform Optional platform parameter to inject into tool calls
   * @param deviceId Optional device ID to inject into tool calls for device targeting
   * @param sessionUuid Optional session UUID to inject into tool calls for parallel execution
   * @param signal Optional abort signal for cancellation
   * @param abortStrategy Strategy for aborting when a device fails (default: "immediate")
   * @param executionOptions Optional capture flags and hooks (e.g. `captureObserveSteps`, `onBeforePlanStep`;
   *   hooks are ignored for multi-device parallel plans)
   * @returns Promise with execution result including success status, executed steps, and any errors
   */
  executePlan(
    plan: Plan,
    startStep: number,
    platform?: string,
    deviceId?: string,
    sessionUuid?: string,
    signal?: AbortSignal,
    abortStrategy?: AbortStrategy,
    executionOptions?: PlanExecutionOptions,
  ): Promise<PlanExecutionResult>;
}

interface SequentialPlanExecutionOptions {
  plan: Plan;
  startStep: number;
  platform?: string;
  deviceId?: string;
  sessionUuid?: string;
  signal?: AbortSignal;
  executionOptions?: PlanExecutionOptions;
}

interface ParallelPlanExecutionOptions {
  plan: Plan;
  partitionedPlan: ReturnType<typeof PlanPartitioner.partition> & { devices: string[] };
  startStep: number;
  platform?: string;
  deviceId?: string;
  sessionUuid?: string;
  signal?: AbortSignal;
  abortStrategy?: AbortStrategy;
  executionOptions?: PlanExecutionOptions;
}

/**
 * Default plan execution implementation
 * Executes plan steps sequentially or in parallel (multi-device)
 */
export class DefaultPlanExecutor implements PlanExecutor {
  private timer: Timer;
  private stepExecutor: DefaultPlanStepExecutor<RegisteredTool>;

  constructor(timer: Timer = defaultTimer, loggerInstance: Logger = logger) {
    this.timer = timer;
    this.stepExecutor = new DefaultPlanStepExecutor<RegisteredTool>(
      ToolRegistry,
      () => DaemonState.getInstance().isInitialized(),
      timer,
      loggerInstance,
    );
  }

  // Retain the existing injection seams while the shared helper owns step policy.
  private executeStep(step: PlanStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    return this.stepExecutor.executeStep(step, {
      ...context,
      buildFailureObservationContext: this.buildFailureObservationContext.bind(this),
    });
  }

  private buildFailureObservationContext(
    ...args: Parameters<DefaultPlanStepExecutor["buildFailureObservationContext"]>
  ): Promise<FailureObservationSummary | undefined> {
    return this.stepExecutor.buildFailureObservationContext(...args);
  }

  /**
   * Record a failed `optional: true` step as skipped so the sequential executor can continue
   * without aborting the plan. The caller continues its loop.
   */
  private recordSkippedOptionalStep(
    records: { debugSteps: ExecutePlanStepDebugInfo[]; skippedSteps: PlanSkippedStep[] },
    stepNumber: number,
    step: PlanStep,
    durationMs: number,
    error: string,
  ): void {
    logger.warn(
      `[PLAN_STEP_${stepNumber}] optional step ${step.tool} failed; skipping and continuing: ${error}`,
    );
    records.skippedSteps.push({ stepIndex: stepNumber - 1, tool: step.tool, error });
    records.debugSteps.push({
      step: `Execute step ${stepNumber}: ${step.tool}`,
      status: "skipped",
      durationMs,
      details: {
        params: step.params,
        error,
        optional: true,
      },
    });
  }

  /**
   * Execute a plan step by step
   * @param plan Plan to execute
   * @param startStep Starting step index (default 0)
   * @param platform Optional platform parameter to inject into tool calls
   * @param deviceId Optional device ID to inject into tool calls for device targeting
   * @param sessionUuid Optional session UUID to inject into tool calls for parallel execution
   * @param signal Optional abort signal for cancellation
   * @param abortStrategy Strategy for aborting when a device fails (default: "immediate")
   * @returns Promise with execution result including success status, executed steps, and any errors
   */
  async executePlan(
    plan: Plan,
    startStep: number,
    platform?: string,
    deviceId?: string,
    sessionUuid?: string,
    signal?: AbortSignal,
    abortStrategy: AbortStrategy = DEFAULT_ABORT_STRATEGY,
    executionOptions?: PlanExecutionOptions,
  ): Promise<PlanExecutionResult> {
    // Check if this is a multi-device plan
    const partitionedPlan = PlanPartitioner.partition(plan);

    if (partitionedPlan) {
      if (executionOptions?.captureObserveSteps) {
        logger.warn(
          "[PlanExecutor] captureObserveSteps is ignored for multi-device plans (parallel tracks do not emit unified debug steps)",
        );
      }
      // Multi-device parallel execution
      return this.executeParallel({
        plan,
        partitionedPlan,
        startStep,
        platform,
        deviceId,
        sessionUuid,
        signal,
        abortStrategy,
        executionOptions,
      });
    } else {
      // Single-device sequential execution
      return this.executeSequential({
        plan,
        startStep,
        platform,
        deviceId,
        sessionUuid,
        signal,
        executionOptions,
      });
    }
  }

  /**
   * Execute a single-device plan sequentially (original implementation).
   */
  private async executeSequential(
    options: SequentialPlanExecutionOptions,
  ): Promise<PlanExecutionResult> {
    const { plan } = options;
    let { startStep } = options;
    const { platform, deviceId, sessionUuid, signal, executionOptions } = options;
    let executedSteps = 0;
    const startTime = this.timer.now();
    // Always capture step data for test recording, not just in debug mode
    const debugSteps: ExecutePlanStepDebugInfo[] = [];
    // Promoted out of the debug trace so an ordinary plan's caller sees them
    // (#6887 review).
    const warnings: PlanStepWarnings[] = [];
    const skippedSteps: PlanSkippedStep[] = [];
    const toolResults = new StepToolResultCollector();

    try {
      // Validate and normalize startStep
      if (startStep < 0) {
        startStep = 0;
      } else if (plan.steps.length > 0 && startStep >= plan.steps.length) {
        throw new ActionableError(
          `Start step index ${startStep} is out of bounds. Plan has ${plan.steps.length} steps (valid range: 0-${plan.steps.length - 1})`,
        );
      }

      // Handle empty plans
      if (plan.steps.length === 0) {
        logger.info("Plan has no steps to execute");
        return {
          success: true,
          executedSteps: 0,
          totalSteps: 0,
        };
      }

      logger.info(`Starting plan execution from step ${startStep}`);

      for (let i = startStep; i < plan.steps.length; i++) {
        throwIfAborted(signal);
        if (executionOptions?.onBeforePlanStep) {
          const beforeStep = executionOptions.onBeforePlanStep({
            stepIndex: i,
            totalSteps: plan.steps.length,
            ...(signal ? { signal } : {}),
          });
          await beforeStep.finally(() => throwIfAborted(signal));
        }
        const step = plan.steps[i];
        const stepStartTime = this.timer.now();
        const stepLabel =
          step.label || step.params?.label || JSON.stringify(step.params).substring(0, 50);
        logger.info(
          `[PLAN_STEP_${i + 1}/${plan.steps.length}] Tool: ${step.tool}, Label: ${stepLabel}`,
        );

        const stepResult = await this.executeStep(step, {
          platform,
          deviceId,
          sessionUuid,
          signal,
          captureObserveSteps: executionOptions?.captureObserveSteps,
          logPrefix: `[PLAN_STEP_${i + 1}]`,
        });

        if (stepResult.warnings) {
          warnings.push({ stepIndex: i, tool: step.tool, warnings: stepResult.warnings });
        }
        if (stepResult.status === "completed") {
          toolResults.add(i, step.tool, stepResult.toolPayload);
        }

        if (stepResult.status === "skipped") {
          this.recordSkippedOptionalStep(
            { debugSteps, skippedSteps },
            i + 1,
            step,
            this.timer.now() - stepStartTime,
            stepResult.error ?? "Unknown error",
          );
          continue;
        }

        if (stepResult.status === "failed") {
          logger.error(`[PLAN_STEP_${i + 1}] FAILED: ${step.tool} - ${stepResult.error}`);
          debugSteps.push({
            step: `Execute step ${i + 1}: ${step.tool}`,
            status: "failed",
            durationMs: this.timer.now() - stepStartTime,
            details: stepResult.details,
          });

          return {
            success: false,
            executedSteps,
            totalSteps: plan.steps.length,
            failedStep: {
              stepIndex: i,
              tool: step.tool,
              error: stepResult.error ?? "Unknown error",
              ...(stepResult.failureObservation
                ? { failureObservation: stepResult.failureObservation }
                : {}),
            },
            debug: {
              executionTimeMs: this.timer.now() - startTime,
              steps: debugSteps,
            },
            // Include diagnostics from earlier steps and from sub-steps that
            // ran inside the failing step.
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(skippedSteps.length > 0 ? { skippedSteps } : {}),
            ...toolResults.asField(),
          };
        }

        debugSteps.push({
          step: `Execute step ${i + 1}: ${step.tool}`,
          status: "completed",
          durationMs: this.timer.now() - stepStartTime,
          details: stepResult.details,
        });
        executedSteps++;
        logger.info(
          `[PLAN_STEP_${i + 1}] Successfully completed. Total executed: ${executedSteps}/${plan.steps.length}`,
        );
      }

      logger.info(
        `Plan execution completed successfully: ${executedSteps}/${plan.steps.length} steps`,
      );
      return {
        success: true,
        executedSteps,
        totalSteps: plan.steps.length,
        debug: {
          executionTimeMs: this.timer.now() - startTime,
          steps: debugSteps,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(skippedSteps.length > 0 ? { skippedSteps } : {}),
        ...toolResults.asField(),
      };
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      logger.warn(`Plan execution failed: ${errorMessage(error)}`, error);

      debugSteps.push({
        step: "Plan execution error",
        status: "failed",
        durationMs: this.timer.now() - startTime,
        details: {
          error: `${error}`,
        },
      });

      return {
        success: false,
        executedSteps,
        totalSteps: plan.steps.length,
        failedStep: {
          stepIndex: -1,
          tool: "unknown",
          error: `${error}`,
        },
        debug: {
          executionTimeMs: this.timer.now() - startTime,
          steps: debugSteps,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(skippedSteps.length > 0 ? { skippedSteps } : {}),
        ...toolResults.asField(),
      };
    }
  }

  private validateParallelStartStep(
    plan: Plan,
    startStep: number,
  ): PlanExecutionResult | undefined {
    // Resume indices refer to plan.steps, not an individual device track.
    // Negative indices already include every step; preserve that behavior.
    if (plan.steps.length > 0 && startStep >= plan.steps.length) {
      const error = new ActionableError(
        `Start step index ${startStep} is out of bounds. Parallel plan has ${plan.steps.length} steps (plan-wide step index, valid range: 0-${plan.steps.length - 1})`,
      );
      logger.error(`Plan execution failed: ${error}`);
      // Match executeSequential's caught validation error at the public boundary.
      return {
        success: false,
        executedSteps: 0,
        totalSteps: plan.steps.length,
        failedStep: { stepIndex: -1, tool: "unknown", error: `${error}` },
        debug: {
          executionTimeMs: 0,
          steps: [
            {
              step: "Plan execution error",
              status: "failed",
              durationMs: 0,
              details: { error: `${error}` },
            },
          ],
        },
      };
    }

    return undefined;
  }

  private computeParallelResumeStep(plan: Plan, startStep: number): number {
    // AI recovery resumes a failed plan at its failed global step index, and each
    // device track skips lower-indexed steps independently. If that resume index
    // falls in the middle of a barrier/criticalSection generation, some devices'
    // arrivals would be skipped while their partners' re-run, splitting the
    // generation so it never reaches deviceCount and the survivors deadlock at
    // waitAtBarrier (issue #6234). Rewind the resume point to the start of any
    // generation it would split so every participant re-arrives together; a
    // resume point that splits nothing is returned unchanged.
    const effectiveStartStep = computeSafeBarrierResumeStep(plan, startStep);
    if (effectiveStartStep !== startStep) {
      logger.info(
        `[PARALLEL_EXEC] Rewinding resume step ${startStep} -> ${effectiveStartStep} to avoid ` +
          "resuming inside a barrier generation (issue #6234)",
      );
    }
    return effectiveStartStep;
  }

  /**
   * Execute a multi-device plan with parallel device tracks.
   */
  private async executeParallel(
    options: ParallelPlanExecutionOptions,
  ): Promise<PlanExecutionResult> {
    const { plan, partitionedPlan } = options;
    let { startStep } = options;
    const {
      platform,
      deviceId,
      sessionUuid,
      signal,
      abortStrategy = DEFAULT_ABORT_STRATEGY,
      executionOptions,
    } = options;
    const outOfBounds = this.validateParallelStartStep(plan, startStep);
    if (outOfBounds) {
      return outOfBounds;
    }

    const debugMode = isDebugModeEnabled();

    startStep = this.computeParallelResumeStep(plan, startStep);

    logger.info(
      `[PARALLEL_EXEC] Starting parallel execution for ${partitionedPlan.devices.length} devices`,
    );

    // Create an abort controller for internal cancellation
    const internalAbortController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, internalAbortController.signal])
      : internalAbortController.signal;
    let firstDeviceLoss: DeviceLostError | undefined;

    // Track per-device results
    const perDeviceResults = new Map<string, DeviceExecutionResult>();
    const failures: ParallelTrackFailure[] = [];
    // Tells survivors that a barrier/criticalSection can no longer be satisfied (#10025).
    const participants = new ParticipantFailureTracker(plan);
    // One toolResults budget for the whole plan, not one per device track.
    const toolResultsBudget = new PlanToolResultsBudget();

    // Execute each device track in parallel
    const devicePromises = partitionedPlan.devices.map(async (device, deviceOrder) => {
      const deviceStartTime = debugMode ? this.timer.now() : 0;
      const track = partitionedPlan.deviceTracks.get(device)!;

      logger.info(`[PARALLEL_EXEC][${device}] Starting device track with ${track.length} steps`);

      try {
        const result = await this.executeDeviceTrack(
          device,
          track,
          startStep,
          // A mixed-platform plan runs each label's steps with that label's declared
          // platform; the request platform only covers labels that declare none (#10023).
          getPlanDevicePlatform(plan.devices, device) ?? platform,
          deviceId,
          sessionUuid,
          combinedSignal,
          executionOptions,
          participants,
          toolResultsBudget,
        );
        // An ordinary failing callback aborts synchronously below. Failures
        // observed after that abort may be cancelled siblings, even at a lower
        // real plan index. Keep them in perDeviceResults but prefer the cause.
        // A coordination step that failed only because a participant track had
        // already failed is the same kind of symptom (#10025).
        const abortConsequence =
          internalAbortController.signal.aborted || result.failedStep?.participantFailed === true;

        const deviceResult: DeviceExecutionResult = {
          device,
          success: result.success,
          executedSteps: result.executedSteps,
          totalSteps: track.length,
          skippedSteps: result.skippedSteps.length > 0 ? result.skippedSteps : undefined,
          executionTimeMs: debugMode ? this.timer.now() - deviceStartTime : undefined,
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
            logger.info(
              `[PARALLEL_EXEC] Aborting all devices immediately due to failure on ${device}`,
            );
            internalAbortController.abort();
          }
          // For "finish-current-step", other devices finish naturally, except that a
          // barrier/criticalSection the failed track will never reach fails promptly.
          if (abortStrategy === "finish-current-step" && result.failedStep) {
            participants.trackFailed(device, result.failedStep);
          }
        }

        return result;
      } catch (error) {
        if (isDeviceLostError(error)) {
          // Device loss overrides ordinary-failure abort strategies. Remember the
          // originating error before abort listeners can reject sibling tracks.
          firstDeviceLoss ??= error;
          rememberDeviceLossAbort(internalAbortController.signal, firstDeviceLoss);
          rememberDeviceLossAbort(combinedSignal, firstDeviceLoss);
          internalAbortController.abort(firstDeviceLoss);
          throw error;
        }
        const abortConsequence = internalAbortController.signal.aborted;
        const errorMsg = errorMessage(error);
        logger.warn(`[PARALLEL_EXEC][${device}] Unexpected error: ${errorMsg}`, error);

        const deviceResult: DeviceExecutionResult = {
          device,
          success: false,
          executedSteps: 0,
          totalSteps: track.length,
          executionTimeMs: debugMode ? this.timer.now() - deviceStartTime : undefined,
          failedStep: {
            stepIndex: -1,
            trackIndex: -1,
            tool: "unknown",
            error: errorMsg,
          },
        };

        perDeviceResults.set(device, deviceResult);

        failures.push({
          failedStep: {
            device,
            stepIndex: -1,
            tool: "unknown",
            error: errorMsg,
          },
          deviceOrder,
          abortConsequence,
        });

        if (abortStrategy === "immediate") {
          internalAbortController.abort();
        }

        return {
          success: false,
          executedSteps: 0,
          totalSteps: track.length,
          failedStep: {
            stepIndex: -1,
            trackIndex: -1,
            tool: "unknown",
            error: errorMsg,
          },
          skippedSteps: [],
          warnings: [],
          toolResults: [],
        };
      }
    });

    // Keep plan ownership until every track, including in-flight tools, settles.
    const results = await this.settleDeviceTracks(devicePromises, () => firstDeviceLoss);

    // Calculate total executed steps across all devices
    const totalExecutedSteps = results.reduce((sum, r) => sum + r.executedSteps, 0);
    const totalSteps = results.reduce((sum, r) => sum + r.totalSteps, 0);
    const allSucceeded = results.every((r) => r.success);

    logger.info(
      `[PARALLEL_EXEC] Parallel execution completed. Success: ${allSucceeded}, Total steps: ${totalExecutedSteps}/${totalSteps}`,
    );

    // Device tracks run in parallel, so order the aggregate by plan step index
    // to give the caller a stable, plan-shaped reading of what was warned about.
    const warnings = results
      .flatMap((result) => result.warnings)
      .sort((a, b) => a.stepIndex - b.stepIndex);

    const skippedSteps = [...perDeviceResults.values()]
      .flatMap((result) =>
        (result.skippedSteps ?? []).map(({ stepIndex, tool, error }) => ({
          stepIndex,
          tool,
          error,
          device: result.device,
        })),
      )
      .sort((a, b) => a.stepIndex - b.stepIndex);

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

    return {
      success: allSucceeded,
      executedSteps: totalExecutedSteps,
      totalSteps,
      failedStep: selectParallelFailure(failures),
      ...parallelDeviceFailuresField(failures, partitionedPlan.devices),
      perDeviceResults,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(skippedSteps.length > 0 ? { skippedSteps } : {}),
      ...mergedToolResultsField(results, toolResultsBudget),
    };
  }

  private resolveTrackDeviceId(deviceLabel: string, sessionUuid?: string): string | undefined {
    const daemonState = DaemonState.getInstance();
    if (!sessionUuid || !daemonState.isInitialized()) {
      return undefined;
    }
    const sessionManager = daemonState.getSessionManager();
    const trackSessionUuid = sessionManager.getDeviceLabels(sessionUuid)?.[deviceLabel];
    // A plan label is not a device ID. Unallocated tracks must never cancel
    // another track's jobs by falling back to the orchestrator's base device.
    return trackSessionUuid
      ? (sessionManager.getDeviceForSession(trackSessionUuid) ?? undefined)
      : undefined;
  }

  private async settleDeviceTracks<T>(
    devicePromises: Promise<T>[],
    getDeviceLoss: () => DeviceLostError | undefined,
  ): Promise<T[]> {
    const settled = await Promise.allSettled(devicePromises);
    const deviceLoss = getDeviceLoss();
    if (deviceLoss) {
      throw deviceLoss;
    }
    return settled.map((result) => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    });
  }

  /**
   * Run one step of a device track. A coordination step that a failed participant track can no
   * longer satisfy (#10025) is not run at all: it resolves immediately with that participant's
   * failure, as does a barrier wait that becomes unsatisfiable while the step is parked in it.
   */
  private async executeTrackStep(
    device: string,
    step: PlanStep,
    planIndex: number,
    context: StepExecutionContext,
    allParticipants: ParticipantFailureTracker | undefined,
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
          details: { params: step.params, error, ...(step.optional ? { optional: true } : {}) },
        },
      };
    }
    const result = await this.executeStep(step, {
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
  private async executeDeviceTrack(
    device: string,
    track: TrackedStep[],
    startStep: number,
    platform?: string,
    deviceId?: string,
    sessionUuid?: string,
    signal?: AbortSignal,
    executionOptions?: PlanExecutionOptions,
    participants?: ParticipantFailureTracker,
    toolResultsBudget?: PlanToolResultsBudget,
  ): Promise<{
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
    warnings: PlanStepWarnings[];
    toolResults: PlanStepToolResult[];
  }> {
    let executedSteps = 0;
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

        const stepLabel =
          step.label || step.params?.label || JSON.stringify(step.params).substring(0, 50);
        logger.info(
          `[PARALLEL_EXEC][${device}] Step ${trackIndex + 1}/${track.length} (plan step ${planIndex}): ${step.tool}, Label: ${stepLabel}`,
        );

        const stepStartTime = this.timer.now();
        const { result: stepResult, participantFailure } = await this.executeTrackStep(
          device,
          step,
          planIndex,
          {
            platform,
            deviceId: this.resolveTrackDeviceId(device, sessionUuid),
            sessionUuid,
            signal,
            logPrefix: `[PARALLEL_EXEC][${device}]`,
            debugLog: true,
          },
          participants,
        );

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

        if (stepResult.status === "skipped") {
          logger.warn(
            `[PARALLEL_EXEC][${device}] optional step ${step.tool} failed; skipping and continuing: ${stepResult.error}`,
          );
          skippedSteps.push({
            stepIndex: planIndex,
            trackIndex,
            tool: step.tool,
            error: stepResult.error ?? "Unknown error",
            durationMs: this.timer.now() - stepStartTime,
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
            failedStep: {
              stepIndex: planIndex,
              trackIndex,
              tool: step.tool,
              error: participantFailure?.message ?? stepResult.error ?? "Unknown error",
              ...(stepResult.failureObservation
                ? { failureObservation: stepResult.failureObservation }
                : {}),
              ...(participantFailure ? { participantFailed: true } : {}),
            },
            skippedSteps,
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
        warnings,
        toolResults: toolResults.toArray() ?? [],
      };
    }
  }
}
