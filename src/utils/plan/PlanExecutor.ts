import { logParallelDeviceResults } from "./parallelPlanResults";
import { planStepLabel, normalizeSequentialStartStep } from "./sequentialPlanResults";
import {
  mergedToolResultsField,
  parallelDeviceFailuresField,
  selectParallelFailure,
  recordParallelTrackResult,
  type ParallelTrackFailure,
} from "./parallelPlanResults";
export { selectParallelFailure } from "./parallelPlanResults";
import type { DeviceTrackOptions } from "./PlanDeviceTrackExecutor";
import { PlanDeviceTrackExecutor } from "./PlanDeviceTrackExecutor";
import {
  beforeSequentialStep,
  recordSequentialStep,
  sequentialResult,
  sequentialFailedStep,
  type SequentialExecutionRecords,
} from "./sequentialPlanResults";
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
import { ActionableError } from "../../models";
import { isDebugModeEnabled } from "../debug";
import {
  ExecutePlanStepDebugInfo,
  type PlanExecutionOptions,
  type PlanStepToolResult,
  type PlanStepWarnings,
} from "../../models/ExecutePlanResult";
import { throwIfAborted } from "../toolUtils";
import { PlanPartitioner } from "./PlanPartitioner";
import { getPlanDevicePlatform } from "./PlanDevices";
import { computeSafeBarrierResumeStep } from "./BarrierResumeGuard";
import { ParticipantFailureTracker } from "./ParticipantFailureTracker";
import { Timer, defaultTimer } from "../SystemTimer";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { type DeviceLostError, isDeviceLostError } from "../../models/DeviceLostError";
import { rememberDeviceLossAbort } from "../deviceLossAbortRegistry";
import {
  DefaultPlanStepExecutor,
  type PlanStepTool,
  type PlanStepTools,
  type StepExecutionContext,
  type StepExecutionResult,
} from "./PlanStepExecutor";
import { PlanToolResultsBudget, StepToolResultCollector } from "./stepToolResults";

export { UNEVALUATED_EXPECTATIONS_WARNING } from "./planStepParams";

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

/** The slice of the daemon session manager the executor reads to resolve a parallel track's device. */
export interface PlanExecutorSessionManager {
  getDeviceLabels(sessionId: string): Record<string, string> | undefined;
  getDeviceForSession(sessionId: string): string | null;
}

/** The slice of daemon state the executor needs; the server layer wires the real singleton. */
export interface PlanExecutorDaemon {
  /** The session manager, or undefined when the daemon is not initialized (stdio, tests). */
  sessionManager(): PlanExecutorSessionManager | undefined;
}

/** Collaborators injected so `src/utils` never imports the server or daemon tiers. */
export interface PlanExecutorCollaborators<TTool extends PlanStepTool = PlanStepTool> {
  toolRegistry: PlanStepTools<TTool>;
  daemon: PlanExecutorDaemon;
}

/**
 * Default plan execution implementation
 * Executes plan steps sequentially or in parallel (multi-device)
 */
export class DefaultPlanExecutor<
  TTool extends PlanStepTool = PlanStepTool,
> implements PlanExecutor {
  readonly planDeviceTrackExecutor: PlanDeviceTrackExecutor;
  private createPlanDeviceTrackExecutor(): PlanDeviceTrackExecutor {
    const client = this;
    return new PlanDeviceTrackExecutor({
      get timer() {
        return client.timer;
      },
      resolveTrackDeviceId: (...args) => client.resolveTrackDeviceId(...args),
      executeStep: (...args) => client.executeStep(...args),
    });
  }

  private timer: Timer;
  private stepExecutor: DefaultPlanStepExecutor<TTool>;

  constructor(
    private readonly collaborators: PlanExecutorCollaborators<TTool>,
    timer: Timer = defaultTimer,
    loggerInstance: Logger = logger,
  ) {
    this.timer = timer;
    this.stepExecutor = new DefaultPlanStepExecutor<TTool>(
      collaborators.toolRegistry,
      () => collaborators.daemon.sessionManager() !== undefined,
      timer,
      loggerInstance,
    );

    this.planDeviceTrackExecutor = this.createPlanDeviceTrackExecutor();
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
    ...[
      plan,
      startStep,
      platform,
      deviceId,
      sessionUuid,
      signal,
      abortStrategy = DEFAULT_ABORT_STRATEGY,
      executionOptions,
    ]: Parameters<PlanExecutor["executePlan"]>
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
  private async executeSequential(
    options: SequentialPlanExecutionOptions,
  ): Promise<PlanExecutionResult> {
    const { plan, platform, deviceId, sessionUuid, signal, executionOptions } = options;
    let { startStep } = options;
    const records: SequentialExecutionRecords = {
      executedSteps: 0,
      startTime: this.timer.now(),
      debugSteps: [],
      warnings: [],
      skippedSteps: [],
      toolResults: new StepToolResultCollector(),
    };
    try {
      startStep = normalizeSequentialStartStep(plan, startStep);
      if (plan.steps.length === 0) {
        logger.info("Plan has no steps to execute");
        return { success: true, executedSteps: 0, totalSteps: 0 };
      }
      logger.info(`Starting plan execution from step ${startStep}`);
      for (let i = startStep; i < plan.steps.length; i++) {
        throwIfAborted(signal);
        if (executionOptions?.onBeforePlanStep) {
          await beforeSequentialStep({
            executionOptions,
            stepIndex: i,
            totalSteps: plan.steps.length,
            signal,
          });
        }
        const step = plan.steps[i];
        const stepStartTime = this.timer.now();
        const stepLabel = planStepLabel(step);
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
        recordSequentialStep({
          records,
          step,
          stepIndex: i,
          result: stepResult,
          durationMs: this.timer.now() - stepStartTime,
        });
        if (stepResult.status === "skipped") {
          continue;
        }
        if (stepResult.status === "failed") {
          return sequentialResult({
            records,
            totalSteps: plan.steps.length,
            now: this.timer.now(),
            failedStep: sequentialFailedStep(step, i, stepResult),
          });
        }
        records.executedSteps++;
        logger.info(
          `[PLAN_STEP_${i + 1}] Successfully completed. Total executed: ${records.executedSteps}/${plan.steps.length}`,
        );
      }
      logger.info(
        `Plan execution completed successfully: ${records.executedSteps}/${plan.steps.length} steps`,
      );
      return sequentialResult({ records, totalSteps: plan.steps.length, now: this.timer.now() });
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      logger.warn(`Plan execution failed: ${errorMessage(error)}`, error);
      records.debugSteps.push({
        step: "Plan execution error",
        status: "failed",
        durationMs: this.timer.now() - records.startTime,
        details: { error: `${error}` },
      });
      return sequentialResult({
        records,
        totalSteps: plan.steps.length,
        now: this.timer.now(),
        failedStep: { stepIndex: -1, tool: "unknown", error: `${error}` },
      });
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
        const result = await this.executeDeviceTrack({
          device: device,
          track: track,
          startStep: startStep,
          platform: getPlanDevicePlatform(plan.devices, device) ?? platform,
          deviceId: deviceId,
          sessionUuid: sessionUuid,
          signal: combinedSignal,
          executionOptions: executionOptions,
          participants: participants,
          toolResultsBudget: toolResultsBudget,
        });
        recordParallelTrackResult({
          result,
          internalAbortController,
          debugMode,
          deviceStartTime,
          totalSteps: track.length,
          device,
          perDeviceResults,
          failures,
          deviceOrder,
          abortStrategy,
          participants,
          timer: this.timer,
        });

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

    logParallelDeviceResults({ debugMode, allSucceeded, perDeviceResults });

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
    const sessionManager = this.collaborators.daemon.sessionManager();
    if (!sessionUuid || !sessionManager) {
      return undefined;
    }
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

  private executeDeviceTrack(options: DeviceTrackOptions): Promise<{
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
    return this.planDeviceTrackExecutor.executeDeviceTrack(options);
  }
}
