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
} from "../../models/ExecutePlanResult";
import { throwIfAborted, getStructuredPayload } from "../toolUtils";
import { ZodError } from "zod/v4";
import { PlanPartitioner, TrackedStep } from "./PlanPartitioner";
import { DaemonState } from "../../daemon/daemonState";
import { Timer, defaultTimer } from "../SystemTimer";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { ScreenshotJobTracker } from "../ScreenshotJobTracker";
import { isDeviceLostError } from "../../server/deviceLossOutcome";
import { formatStructuredToolError } from "../formatStructuredToolError";
import {
  summarizeObserveResultForFailure,
  trimObservationForStepCapture,
} from "./summarizeFailureObservation";

function formatToolError(error: unknown): string {
  return formatStructuredToolError(error) ?? String(error);
}

type StepExecutionStatus = "completed" | "failed" | "skipped";

interface StepExecutionContext {
  platform?: string;
  deviceId?: string;
  sessionUuid?: string;
  signal?: AbortSignal;
  captureObserveSteps?: NonNullable<PlanExecutionOptions["captureObserveSteps"]>;
  logPrefix: string;
  debugLog?: boolean;
}

interface StepExecutionResult {
  status: StepExecutionStatus;
  error?: string;
  details: Record<string, unknown>;
  failureObservation?: FailureObservationSummary;
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

/**
 * Default plan execution implementation
 * Executes plan steps sequentially or in parallel (multi-device)
 */
export class DefaultPlanExecutor implements PlanExecutor {
  private timer: Timer;
  private logger: Logger;

  constructor(timer: Timer = defaultTimer, loggerInstance: Logger = logger) {
    this.timer = timer;
    this.logger = loggerInstance;
  }

  /**
   * Extract the actual tool result from an MCP-formatted response.
   *
   * Tool handlers return responses wrapped by createJSONToolResponse():
   *   { content: [{ type: "text", text: '{"success": false, "error": "..."}' }] }
   *
   * This method unwraps the MCP content envelope to get the actual result object
   * (e.g., { success: false, error: "Element not found" }).
   *
   * If the response already has "success" at the top level (not wrapped), it is
   * returned as-is for backward compatibility.
   */
  private extractToolResult(response: any): any {
    if (!response || typeof response !== "object") {
      return response;
    }

    // If "success" exists at the top level, the response is already unwrapped
    if ("success" in response) {
      return response;
    }

    // Unwrap MCP content format: { content: [{ type: "text", text: "JSON string" }] }
    if (Array.isArray(response.content) && response.content.length > 0) {
      const firstContent = response.content[0];
      if (firstContent?.type === "text" && typeof firstContent.text === "string") {
        try {
          const parsed = JSON.parse(firstContent.text);
          if (parsed && typeof parsed === "object" && "success" in parsed) {
            return parsed;
          }
          return response;
        } catch {
          return response;
        }
      }
    }

    return response;
  }

  private parseStructuredToolPayload(response: unknown): Record<string, unknown> | null {
    if (!response || typeof response !== "object") {
      return null;
    }
    const r = response as Record<string, unknown>;
    const structuredPayload = getStructuredPayload<Record<string, unknown>>(r);
    if (structuredPayload) {
      return structuredPayload;
    }
    const content = r.content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>;
      if (first?.type === "text" && typeof first.text === "string") {
        try {
          const parsed = JSON.parse(first.text) as unknown;
          if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
          }
        } catch (error) {
          // Tool response text that isn't valid JSON has no structured payload to extract; null signals "no payload".
          logger.debug(`src/utils/plan/PlanExecutor.ts fallback failed: ${error}`, error);
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Observe with waitFor returns awaitTimeout: true when the condition is not met within the timeout.
   * The handler does not set success: false, so the executor must treat that as a failed step.
   */
  private observeWaitForTimedOut(response: unknown): { awaitDuration?: number } | null {
    const payload = this.parseStructuredToolPayload(response);
    if (!payload || payload.awaitTimeout !== true) {
      return null;
    }
    return {
      awaitDuration: typeof payload.awaitDuration === "number" ? payload.awaitDuration : undefined,
    };
  }

  /**
   * Copies tool-specific diagnostics into executePlan `debug.steps[n].details`
   * (e.g. Android `tapOn` -> `tapDebug`).
   */
  private mergeToolDiagnosticsIntoStepDetails(
    toolName: string,
    toolResult: unknown,
    details: Record<string, unknown>,
  ): void {
    if (toolName !== "tapOn" || toolResult === null || typeof toolResult !== "object") {
      return;
    }
    const tr = toolResult as Record<string, unknown>;
    const payload = getStructuredPayload<Record<string, unknown>>(tr) ?? tr;
    if (payload.tapDebug !== undefined && payload.tapDebug !== null) {
      details.tapDebug = payload.tapDebug;
    }
  }

  /**
   * Record a failed `optional: true` step as skipped so the sequential executor can continue
   * without aborting the plan. Returns nothing; the caller continues its loop.
   */
  private recordSkippedOptionalStep(
    debugSteps: ExecutePlanStepDebugInfo[],
    stepNumber: number,
    step: PlanStep,
    durationMs: number,
    error: string,
  ): void {
    logger.warn(
      `[PLAN_STEP_${stepNumber}] optional step ${step.tool} failed; skipping and continuing: ${error}`,
    );
    debugSteps.push({
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

  private static readonly FAILURE_OBSERVATION_TIMEOUT_MS = 3000;

  private async captureFailureObservation(
    platform: string,
    deviceId: string | undefined,
    sessionUuid: string | undefined,
  ): Promise<FailureObservationSummary | undefined> {
    const observeTool = ToolRegistry.getTool("observe");
    if (!observeTool) {
      return undefined;
    }
    try {
      const enhancedParams: Record<string, unknown> = { platform };
      const shouldSuppressDeviceId = !!(sessionUuid && DaemonState.getInstance().isInitialized());
      if (deviceId && !shouldSuppressDeviceId) {
        enhancedParams.deviceId = deviceId;
      }
      if (sessionUuid) {
        enhancedParams.sessionUuid = sessionUuid;
      }
      // Internal failure-recovery observe (#3053): the callInternal seam (#3108)
      // marks it internal so it does not overwrite the agent-facing diff baseline
      // (`observe` always resets it). This capture is for the plan's failure
      // summary, not shown to the agent. Parse against the tool schema first, then
      // pass the resolved tool to the seam so the timeout race stays local.
      const parsedParams = observeTool.schema.parse(enhancedParams) as Record<string, unknown>;

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const response = await Promise.race([
        ToolRegistry.callInternal(observeTool, parsedParams),
        new Promise<never>((_, reject) => {
          timeoutHandle = this.timer.setTimeout(() => {
            reject(new Error("failure observation timed out"));
          }, DefaultPlanExecutor.FAILURE_OBSERVATION_TIMEOUT_MS);
        }),
      ]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const raw = this.parseStructuredToolPayload(response);
      if (!raw) {
        return { capturedAtMs: Date.now(), observeError: "observe returned empty payload" };
      }
      return summarizeObserveResultForFailure(raw);
    } catch (error) {
      return {
        capturedAtMs: Date.now(),
        observeError: errorMessage(error),
      };
    }
  }

  private buildObserveStepCaptureFromResponse(
    toolResponse: unknown,
    mode: NonNullable<PlanExecutionOptions["captureObserveSteps"]>,
  ): FailureObservationSummary | undefined {
    const raw = this.parseStructuredToolPayload(toolResponse);
    if (!raw) {
      return {
        capturedAtMs: Date.now(),
        observeError: "observe returned empty or unparseable payload",
      };
    }
    const summary = summarizeObserveResultForFailure(raw);
    return trimObservationForStepCapture(summary, mode);
  }

  private async buildFailureObservationContext(
    failedTool: string,
    failureToolResponse: unknown | undefined,
    platform: string | undefined,
    deviceId: string | undefined,
    sessionUuid: string | undefined,
  ): Promise<FailureObservationSummary | undefined> {
    try {
      if (failedTool === "observe" && failureToolResponse !== undefined) {
        const raw = this.parseStructuredToolPayload(failureToolResponse);
        if (raw) {
          return summarizeObserveResultForFailure(raw);
        }
        return {
          capturedAtMs: Date.now(),
          observeError: "Could not parse observe tool response",
        };
      }
      if (!platform) {
        return undefined;
      }
      return await this.captureFailureObservation(platform, deviceId, sessionUuid);
    } catch (error) {
      return {
        capturedAtMs: Date.now(),
        observeError: errorMessage(error),
      };
    }
  }

  private buildEnhancedStepParams(
    tool: RegisteredTool,
    step: PlanStep,
    platform: string | undefined,
    deviceId: string | undefined,
    sessionUuid: string | undefined,
  ): Record<string, unknown> {
    const enhancedParams: Record<string, unknown> = { ...step.params };

    if (!tool.requiresDevice) {
      return enhancedParams;
    }

    if (platform && !enhancedParams.platform) {
      enhancedParams.platform = platform;
    }

    // Inject deviceId if provided and not already set - BUT only if session-based routing won't work.
    // We suppress deviceId injection when BOTH conditions are met:
    // 1. sessionUuid is present (for session-based routing)
    // 2. daemon is initialized (so session routing will actually work in ToolRegistry)
    // If daemon is not initialized, we still inject deviceId to preserve device targeting,
    // preventing fallback to auto-selection which may target the wrong device.
    const shouldSuppressDeviceId = sessionUuid && DaemonState.getInstance().isInitialized();
    if (deviceId && !shouldSuppressDeviceId && !enhancedParams.deviceId && !enhancedParams.device) {
      enhancedParams.deviceId = deviceId;
      logger.info(`[PlanExecutor] Injecting deviceId ${deviceId} into ${step.tool}`);
    }

    if (sessionUuid) {
      enhancedParams.sessionUuid = sessionUuid;
      logger.info(`[PlanExecutor] Injecting sessionUuid ${sessionUuid} into ${step.tool}`);
    }

    // Scope the shared CriticalSectionCoordinator by the plan's base session UUID
    // (identical across every device track of one plan, distinct across plans),
    // so two concurrent plans reusing a lock name get isolated barriers. Strict
    // schemas reject unknown keys, so only explicitly opted-in coordination tools
    // may receive the internal namespace.
    if (tool.acceptsPlanLockNamespace && sessionUuid && !enhancedParams.__lockNamespace) {
      enhancedParams.__lockNamespace = sessionUuid;
    }

    return enhancedParams;
  }

  private async executeStep(
    step: PlanStep,
    context: StepExecutionContext,
  ): Promise<StepExecutionResult> {
    const tool = ToolRegistry.getToolForPlan(step.tool);
    if (!tool) {
      const error = `Unknown tool: ${step.tool}`;
      return {
        status: "failed",
        error,
        details: { error },
      };
    }

    try {
      const enhancedParams = this.buildEnhancedStepParams(
        tool,
        step,
        context.platform,
        context.deviceId,
        context.sessionUuid,
      );

      // Parse and validate the parameters (schema.parse strips unknown keys).
      // The internal marker (#3053) is applied by the callInternal seam (#3108)
      // below so finalize emits the full observation on the step envelope - never
      // a diff or a stripped payload - regardless of
      // `--actions-diff-observe`/`--actions-no-observe`.
      const parsedParams = tool.schema.parse(enhancedParams) as Record<string, unknown>;

      if (context.deviceId) {
        ScreenshotJobTracker.cancelJob(context.deviceId);
      }

      const paramsPreview = JSON.stringify(parsedParams).substring(0, 200);
      if (context.debugLog) {
        logger.debug(`${context.logPrefix} Executing ${step.tool} with params: ${paramsPreview}`);
      } else {
        logger.info(`${context.logPrefix} Calling ${step.tool} with params: ${paramsPreview}`);
      }

      const response = await ToolRegistry.callInternal(
        tool,
        parsedParams,
        undefined,
        context.signal,
        {
          forPlan: true,
          sessionUuid: context.sessionUuid,
        },
      );
      throwIfAborted(context.signal);

      const toolResult = this.extractToolResult(response);
      logger.info(
        `${context.logPrefix} ${step.tool} completed. Response success: ${toolResult?.success !== false ? "true" : "FALSE"}`,
      );

      const checkResult = toolResult ?? response;
      if (
        checkResult &&
        typeof checkResult === "object" &&
        "success" in checkResult &&
        checkResult.success === false
      ) {
        const error =
          "error" in checkResult ? formatToolError(checkResult.error) : "Tool execution failed";
        if (step.optional) {
          return {
            status: "skipped",
            error,
            details: {
              params: step.params,
              error,
              optional: true,
            },
          };
        }

        const failureObservation = await this.buildFailureObservationContext(
          step.tool,
          response,
          context.platform,
          context.deviceId,
          context.sessionUuid,
        );
        const details: Record<string, unknown> = {
          params: step.params,
          error,
          ...(toolResult && typeof toolResult === "object" && "debug" in toolResult
            ? { toolDebug: toolResult.debug }
            : {}),
          ...(failureObservation ? { failureObservation } : {}),
        };
        this.mergeToolDiagnosticsIntoStepDetails(step.tool, toolResult, details);
        return {
          status: "failed",
          error,
          details,
          failureObservation,
        };
      }

      const observeTimedOut =
        step.tool === "observe" ? this.observeWaitForTimedOut(response) : null;
      if (observeTimedOut) {
        const error = `observe waitFor timed out after ${observeTimedOut.awaitDuration ?? "unknown"}ms`;
        if (step.optional) {
          return {
            status: "skipped",
            error,
            details: {
              params: step.params,
              error,
              optional: true,
            },
          };
        }
        return {
          status: "failed",
          error,
          details: {
            params: step.params,
            error,
          },
        };
      }

      const details: Record<string, unknown> = {
        params: step.params,
      };
      if (step.tool === "observe" && context.captureObserveSteps) {
        const stepObservation = this.buildObserveStepCaptureFromResponse(
          response,
          context.captureObserveSteps,
        );
        if (stepObservation) {
          details.stepObservation = stepObservation;
        }
      }
      this.mergeToolDiagnosticsIntoStepDetails(step.tool, toolResult, details);

      return {
        status: "completed",
        details,
      };
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      const errorMsg = `${error}`;
      if (step.optional && !context.signal?.aborted && !(error instanceof ZodError)) {
        this.logger.warn(
          `${context.logPrefix} optional step ${step.tool} threw; returning skipped status`,
          error,
        );
        return {
          status: "skipped",
          error: errorMsg,
          details: {
            params: step.params,
            error: errorMsg,
            optional: true,
          },
        };
      }

      const failureObservation = context.signal?.aborted
        ? undefined
        : await this.buildFailureObservationContext(
            step.tool,
            undefined,
            context.platform,
            context.deviceId,
            context.sessionUuid,
          );
      this.logger.warn(
        `${context.logPrefix} step ${step.tool} threw; returning failed status`,
        error,
      );
      return {
        status: "failed",
        error: errorMsg,
        details: {
          params: step.params,
          error: errorMsg,
          ...(failureObservation ? { failureObservation } : {}),
        },
        failureObservation,
      };
    }
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
      return this.executeParallel(
        plan,
        partitionedPlan,
        startStep,
        platform,
        deviceId,
        sessionUuid,
        signal,
        abortStrategy,
        executionOptions,
      );
    } else {
      // Single-device sequential execution
      return this.executeSequential(
        plan,
        startStep,
        platform,
        deviceId,
        sessionUuid,
        signal,
        executionOptions,
      );
    }
  }

  /**
   * Execute a single-device plan sequentially (original implementation).
   */
  private async executeSequential(
    plan: Plan,
    startStep: number,
    platform?: string,
    deviceId?: string,
    sessionUuid?: string,
    signal?: AbortSignal,
    executionOptions?: PlanExecutionOptions,
  ): Promise<PlanExecutionResult> {
    let executedSteps = 0;
    const debugMode = isDebugModeEnabled();
    const startTime = this.timer.now();
    // Always capture step data for test recording, not just in debug mode
    const debugSteps: ExecutePlanStepDebugInfo[] = [];

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
          await executionOptions.onBeforePlanStep({
            stepIndex: i,
            totalSteps: plan.steps.length,
          });
        }
        const step = plan.steps[i];
        const stepStartTime = debugMode ? this.timer.now() : 0;
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

        if (stepResult.status === "skipped") {
          this.recordSkippedOptionalStep(
            debugSteps,
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
      };
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      logger.error(`Plan execution failed: ${error}`);

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
      };
    }
  }

  /**
   * Execute a multi-device plan with parallel device tracks.
   */
  private async executeParallel(
    plan: Plan,
    partitionedPlan: ReturnType<typeof PlanPartitioner.partition> & { devices: string[] },
    startStep: number,
    platform?: string,
    deviceId?: string,
    sessionUuid?: string,
    signal?: AbortSignal,
    abortStrategy: AbortStrategy = DEFAULT_ABORT_STRATEGY,
    executionOptions?: PlanExecutionOptions,
  ): Promise<PlanExecutionResult> {
    const debugMode = isDebugModeEnabled();

    logger.info(
      `[PARALLEL_EXEC] Starting parallel execution for ${partitionedPlan.devices.length} devices`,
    );

    // Create an abort controller for internal cancellation
    const internalAbortController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, internalAbortController.signal])
      : internalAbortController.signal;

    // Track per-device results
    const perDeviceResults = new Map<string, DeviceExecutionResult>();
    let firstFailure:
      | {
          device: string;
          stepIndex: number;
          tool: string;
          error: string;
          failureObservation?: FailureObservationSummary;
        }
      | undefined;

    // Execute each device track in parallel
    const devicePromises = partitionedPlan.devices.map(async (device) => {
      const deviceStartTime = debugMode ? this.timer.now() : 0;
      const track = partitionedPlan.deviceTracks.get(device)!;

      logger.info(`[PARALLEL_EXEC][${device}] Starting device track with ${track.length} steps`);

      try {
        const result = await this.executeDeviceTrack(
          device,
          track,
          startStep,
          platform,
          deviceId,
          sessionUuid,
          combinedSignal,
          executionOptions,
        );

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

          // Record first failure
          if (!firstFailure && result.failedStep) {
            firstFailure = {
              device,
              stepIndex: result.failedStep.stepIndex,
              tool: result.failedStep.tool,
              error: result.failedStep.error,
              failureObservation: result.failedStep.failureObservation,
            };
          }

          // Trigger abort based on strategy
          if (abortStrategy === "immediate") {
            logger.info(
              `[PARALLEL_EXEC] Aborting all devices immediately due to failure on ${device}`,
            );
            internalAbortController.abort();
          }
          // For "finish-current-step", we just let other devices finish naturally
        }

        return result;
      } catch (error) {
        if (isDeviceLostError(error)) {
          throw error;
        }
        const errorMsg = errorMessage(error);
        logger.error(`[PARALLEL_EXEC][${device}] Unexpected error: ${errorMsg}`);

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

        if (!firstFailure) {
          firstFailure = {
            device,
            stepIndex: -1,
            tool: "unknown",
            error: errorMsg,
          };
        }

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
        };
      }
    });

    // Wait for all devices to complete
    const results = await Promise.all(devicePromises);

    // Calculate total executed steps across all devices
    const totalExecutedSteps = results.reduce((sum, r) => sum + r.executedSteps, 0);
    const totalSteps = results.reduce((sum, r) => sum + r.totalSteps, 0);
    const allSucceeded = results.every((r) => r.success);

    logger.info(
      `[PARALLEL_EXEC] Parallel execution completed. Success: ${allSucceeded}, Total steps: ${totalExecutedSteps}/${totalSteps}`,
    );

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
      failedStep: firstFailure
        ? {
            stepIndex: firstFailure.stepIndex,
            tool: firstFailure.tool,
            error: firstFailure.error,
            device: firstFailure.device,
            failureObservation: firstFailure.failureObservation,
          }
        : undefined,
      perDeviceResults,
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
    };
    skippedSteps: DeviceSkippedStepResult[];
  }> {
    let executedSteps = 0;
    const skippedSteps: DeviceSkippedStepResult[] = [];

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
        const stepResult = await this.executeStep(step, {
          platform,
          deviceId,
          sessionUuid,
          signal,
          logPrefix: `[PARALLEL_EXEC][${device}]`,
          debugLog: true,
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
              error: stepResult.error ?? "Unknown error",
              ...(stepResult.failureObservation
                ? { failureObservation: stepResult.failureObservation }
                : {}),
            },
            skippedSteps,
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
      };
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      const errorMsg = errorMessage(error);
      logger.error(`[PARALLEL_EXEC][${device}] Track execution error: ${errorMsg}`);

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
      };
    }
  }
}
