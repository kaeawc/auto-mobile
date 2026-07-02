import {
  Plan,
  PlanStep,
  PlanExecutionResult,
  DeviceExecutionResult,
  AbortStrategy,
  DEFAULT_ABORT_STRATEGY,
} from "../../models/Plan";
import { logger } from "../logger";
import { ToolRegistry } from "../../server/toolRegistry";
import { ActionableError } from "../../models";
import { isDebugModeEnabled } from "../debug";
import {
  ExecutePlanStepDebugInfo,
  type PlanExecutionOptions,
} from "../../models/ExecutePlanResult";
import { throwIfAborted } from "../toolUtils";
import { PlanPartitioner, TrackedStep } from "./PlanPartitioner";
import { DaemonState } from "../../daemon/daemonState";
import { Timer, defaultTimer } from "../SystemTimer";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { ScreenshotJobTracker } from "../ScreenshotJobTracker";
import {
  summarizeObserveResultForFailure,
  trimObservationForStepCapture,
} from "./summarizeFailureObservation";

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

  constructor(timer: Timer = defaultTimer) {
    this.timer = timer;
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
    if (r.structuredContent && typeof r.structuredContent === "object") {
      return r.structuredContent as Record<string, unknown>;
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
        } catch {
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
      awaitDuration: typeof payload.awaitDuration === "number" ? payload.awaitDuration : undefined
    };
  }

  /**
   * Copies tool-specific diagnostics into executePlan `debug.steps[n].details`
   * (e.g. Android `tapOn` -> `tapDebug`).
   */
  private mergeToolDiagnosticsIntoStepDetails(
    toolName: string,
    toolResult: unknown,
    details: Record<string, unknown>
  ): void {
    if (toolName !== "tapOn" || toolResult === null || typeof toolResult !== "object") {
      return;
    }
    const tr = toolResult as Record<string, unknown>;
    const payload = (tr.structuredContent && typeof tr.structuredContent === "object")
      ? tr.structuredContent as Record<string, unknown>
      : tr;
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
      `[PLAN_STEP_${stepNumber}] optional step ${step.tool} failed; skipping and continuing: ${error}`
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
      const parsedParams = observeTool.schema.parse(enhancedParams);

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const response = await Promise.race([
        observeTool.handler(parsedParams, undefined, undefined),
        new Promise<never>((_, reject) => {
          timeoutHandle = this.timer.setTimeout(() => {
            reject(new Error("failure observation timed out"));
          }, DefaultPlanExecutor.FAILURE_OBSERVATION_TIMEOUT_MS);
        }),
      ]);
      if (timeoutHandle) {clearTimeout(timeoutHandle);}

      const raw = this.parseStructuredToolPayload(response);
      if (!raw) {
        return { capturedAtMs: Date.now(), observeError: "observe returned empty payload" };
      }
      return summarizeObserveResultForFailure(raw);
    } catch (error) {
      return {
        capturedAtMs: Date.now(),
        observeError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private buildObserveStepCaptureFromResponse(
    toolResponse: unknown,
    mode: NonNullable<PlanExecutionOptions["captureObserveSteps"]>
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
          observeError: "Could not parse observe tool response"
        };
      }
      if (!platform) {
        return undefined;
      }
      return await this.captureFailureObservation(platform, deviceId, sessionUuid);
    } catch (error) {
      return {
        capturedAtMs: Date.now(),
        observeError: error instanceof Error ? error.message : String(error)
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
    executionOptions?: PlanExecutionOptions
  ): Promise<PlanExecutionResult> {
    // Check if this is a multi-device plan
    const partitionedPlan = PlanPartitioner.partition(plan);

    if (partitionedPlan) {
      if (executionOptions?.captureObserveSteps) {
        logger.warn(
          "[PlanExecutor] captureObserveSteps is ignored for multi-device plans (parallel tracks do not emit unified debug steps)"
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
        abortStrategy
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
        executionOptions
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
    executionOptions?: PlanExecutionOptions
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
        throw new ActionableError(`Start step index ${startStep} is out of bounds. Plan has ${plan.steps.length} steps (valid range: 0-${plan.steps.length - 1})`);
      }

      // Handle empty plans
      if (plan.steps.length === 0) {
        logger.info("Plan has no steps to execute");
        return {
          success: true,
          executedSteps: 0,
          totalSteps: 0
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
        const stepLabel = step.label || step.params?.label || JSON.stringify(step.params).substring(0, 50);
        logger.info(`[PLAN_STEP_${i + 1}/${plan.steps.length}] Tool: ${step.tool}, Label: ${stepLabel}`);

        // Get the registered tool
        const tool = ToolRegistry.getToolForPlan(step.tool);
        if (!tool) {
          logger.info(`Could not find tool: ${step.tool}`);

          debugSteps.push({
            step: `Execute step ${i + 1}: ${step.tool}`,
            status: "failed",
            durationMs: this.timer.now() - stepStartTime,
            details: {
              error: `Unknown tool: ${step.tool}`
            }
          });

          return {
            success: false,
            executedSteps,
            totalSteps: plan.steps.length,
            failedStep: {
              stepIndex: i,
              tool: step.tool,
              error: `Unknown tool: ${step.tool}`
            },
            debug: {
              executionTimeMs: this.timer.now() - startTime,
              steps: debugSteps
            }
          };
        }

        try {
          // Inject platform, deviceId, and sessionUuid into tool call params for device-aware tools
          const enhancedParams = { ...step.params };

          if (tool.requiresDevice) {
            // Inject platform if provided and not already set
            if (platform && !enhancedParams.platform) {
              enhancedParams.platform = platform;
            }

            // Inject deviceId if provided and not already set - BUT only if session-based routing won't work
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

            // Inject sessionUuid if provided and not already set - this enables session-based device routing
            if (sessionUuid && !enhancedParams.sessionUuid) {
              enhancedParams.sessionUuid = sessionUuid;
              logger.info(`[PlanExecutor] Injecting sessionUuid ${sessionUuid} into ${step.tool}`);
            }
          }

          // Parse and validate the parameters
          const parsedParams = tool.schema.parse(enhancedParams);

          if (deviceId) {
            ScreenshotJobTracker.cancelJob(deviceId);
          }

          // Execute the tool
          logger.info(`[PLAN_STEP_${i + 1}] Calling ${step.tool} with params: ${JSON.stringify(parsedParams).substring(0, 200)}`);
          const response = await tool.handler(parsedParams, undefined, signal);
          throwIfAborted(signal);

          // Extract the actual tool result from the response.
          // Tool handlers return MCP-formatted responses via createJSONToolResponse():
          //   { content: [{ type: "text", text: '{"success": false, "error": "..."}' }] }
          // We need to unwrap this to check the actual success/failure status.
          const toolResult = this.extractToolResult(response);
          logger.info(`[PLAN_STEP_${i + 1}] ${step.tool} completed. Response success: ${toolResult?.success !== false ? "true" : "FALSE"}`);

          const observeTimedOut = step.tool === "observe" ? this.observeWaitForTimedOut(response) : null;

          // Check if the response indicates failure
          if (toolResult && typeof toolResult === "object" && "success" in toolResult && toolResult.success === false) {
            const errorMsg = toolResult.error || "Unknown error";
            if (step.optional) {
              this.recordSkippedOptionalStep(debugSteps, i + 1, step, this.timer.now() - stepStartTime, String(errorMsg));
              continue;
            }
            logger.error(`[PLAN_STEP_${i + 1}] FAILED: ${step.tool} - ${errorMsg}`);
            const failureObservation = await this.buildFailureObservationContext(
              step.tool,
              response,
              platform,
              deviceId,
              sessionUuid,
            );
            const failedToolDetails: Record<string, unknown> = {
              params: step.params,
              error: String(errorMsg),
              ...(toolResult.debug ? { toolDebug: toolResult.debug } : {}),
              ...(failureObservation ? { failureObservation } : {})
            };
            this.mergeToolDiagnosticsIntoStepDetails(step.tool, toolResult, failedToolDetails);
            debugSteps.push({
              step: `Execute step ${i + 1}: ${step.tool}`,
              status: "failed",
              durationMs: this.timer.now() - stepStartTime,
              details: failedToolDetails,
            });

            return {
              success: false,
              executedSteps,
              totalSteps: plan.steps.length,
              failedStep: {
                stepIndex: i,
                tool: step.tool,
                error: String(errorMsg),
                ...(failureObservation ? { failureObservation } : {})
              },
              debug: {
                executionTimeMs: this.timer.now() - startTime,
                steps: debugSteps
              }
            };
          }

          if (observeTimedOut) {
            const errorMsg = `observe waitFor timed out after ${observeTimedOut.awaitDuration ?? "unknown"}ms`;
            if (step.optional) {
              this.recordSkippedOptionalStep(debugSteps, i + 1, step, this.timer.now() - stepStartTime, errorMsg);
              continue;
            }
            logger.error(`[PLAN_STEP_${i + 1}] FAILED: ${step.tool} - ${errorMsg}`);
            debugSteps.push({
              step: `Execute step ${i + 1}: ${step.tool}`,
              status: "failed",
              durationMs: this.timer.now() - stepStartTime,
              details: {
                params: step.params,
                error: errorMsg,
              }
            });

            return {
              success: false,
              executedSteps,
              totalSteps: plan.steps.length,
              failedStep: {
                stepIndex: i,
                tool: step.tool,
                error: errorMsg,
              },
              debug: {
                executionTimeMs: this.timer.now() - startTime,
                steps: debugSteps
              }
            };
          }

          const completedDetails: Record<string, unknown> = {
            params: step.params,
          };
          if (
            step.tool === "observe" &&
            executionOptions?.captureObserveSteps
          ) {
            const stepObservation = this.buildObserveStepCaptureFromResponse(
              response,
              executionOptions.captureObserveSteps
            );
            if (stepObservation) {
              completedDetails.stepObservation = stepObservation;
            }
          }
          this.mergeToolDiagnosticsIntoStepDetails(step.tool, toolResult, completedDetails);

          debugSteps.push({
            step: `Execute step ${i + 1}: ${step.tool}`,
            status: "completed",
            durationMs: this.timer.now() - stepStartTime,
            details: completedDetails,
          });

          executedSteps++;
          logger.info(`[PLAN_STEP_${i + 1}] Successfully completed. Total executed: ${executedSteps}/${plan.steps.length}`);
        } catch (error) {
          // An abort must never be swallowed as an optional skip; let it fall through to the normal
          // failure path (and, for non-optional steps, preserve existing behavior).
          if (step.optional && !signal?.aborted) {
            this.recordSkippedOptionalStep(debugSteps, i + 1, step, this.timer.now() - stepStartTime, `${error}`);
            continue;
          }
          logger.error(`[PLAN_STEP_${i + 1}] EXCEPTION in ${step.tool}: ${error}`);
          const failureObservation = await this.buildFailureObservationContext(
            step.tool,
            undefined,
            platform,
            deviceId,
            sessionUuid,
          );
          debugSteps.push({
            step: `Execute step ${i + 1}: ${step.tool}`,
            status: "failed",
            durationMs: this.timer.now() - stepStartTime,
            details: {
              params: step.params,
              error: `${error}`,
              ...(failureObservation ? { failureObservation } : {})
            }
          });

          return {
            success: false,
            executedSteps,
            totalSteps: plan.steps.length,
            failedStep: {
              stepIndex: i,
              tool: step.tool,
              error: `${error}`,
              ...(failureObservation ? { failureObservation } : {})
            },
            debug: {
              executionTimeMs: this.timer.now() - startTime,
              steps: debugSteps
            }
          };
        }
      }

      logger.info(`Plan execution completed successfully: ${executedSteps}/${plan.steps.length} steps`);
      return {
        success: true,
        executedSteps,
        totalSteps: plan.steps.length,
        debug: {
          executionTimeMs: this.timer.now() - startTime,
          steps: debugSteps
        }
      };

    } catch (error) {
      logger.error(`Plan execution failed: ${error}`);

      debugSteps.push({
        step: "Plan execution error",
        status: "failed",
        durationMs: this.timer.now() - startTime,
        details: {
          error: `${error}`
        }
      });

      return {
        success: false,
        executedSteps,
        totalSteps: plan.steps.length,
        failedStep: {
          stepIndex: -1,
          tool: "unknown",
          error: `${error}`
        },
        debug: {
          executionTimeMs: this.timer.now() - startTime,
          steps: debugSteps
        }
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
    abortStrategy: AbortStrategy = DEFAULT_ABORT_STRATEGY
  ): Promise<PlanExecutionResult> {
    const debugMode = isDebugModeEnabled();

    logger.info(
      `[PARALLEL_EXEC] Starting parallel execution for ${partitionedPlan.devices.length} devices`
    );

    // Create an abort controller for internal cancellation
    const internalAbortController = new AbortController();
    const combinedSignal = signal
      ? this.createCombinedSignal(signal, internalAbortController.signal)
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
    const devicePromises = partitionedPlan.devices.map(async device => {
      const deviceStartTime = debugMode ? this.timer.now() : 0;
      const track = partitionedPlan.deviceTracks.get(device)!;

      logger.info(
        `[PARALLEL_EXEC][${device}] Starting device track with ${track.length} steps`
      );

      try {
        const result = await this.executeDeviceTrack(
          device,
          track,
          startStep,
          platform,
          deviceId,
          sessionUuid,
          combinedSignal
        );

        const deviceResult: DeviceExecutionResult = {
          device,
          success: result.success,
          executedSteps: result.executedSteps,
          totalSteps: track.length,
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
            `[PARALLEL_EXEC][${device}] Device track failed at step ${result.failedStep?.stepIndex}`
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
              `[PARALLEL_EXEC] Aborting all devices immediately due to failure on ${device}`
            );
            internalAbortController.abort();
          }
          // For "finish-current-step", we just let other devices finish naturally
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[PARALLEL_EXEC][${device}] Unexpected error: ${errorMessage}`);

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
            error: errorMessage,
          },
        };

        perDeviceResults.set(device, deviceResult);

        if (!firstFailure) {
          firstFailure = {
            device,
            stepIndex: -1,
            tool: "unknown",
            error: errorMessage,
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
            error: errorMessage,
          },
        };
      }
    });

    // Wait for all devices to complete
    const results = await Promise.all(devicePromises);

    // Calculate total executed steps across all devices
    const totalExecutedSteps = results.reduce((sum, r) => sum + r.executedSteps, 0);
    const totalSteps = results.reduce((sum, r) => sum + r.totalSteps, 0);
    const allSucceeded = results.every(r => r.success);

    logger.info(
      `[PARALLEL_EXEC] Parallel execution completed. Success: ${allSucceeded}, Total steps: ${totalExecutedSteps}/${totalSteps}`
    );

    // Log per-device timing in debug mode or on failure
    if (debugMode || !allSucceeded) {
      logger.info(`[PARALLEL_EXEC] Per-device results:`);
      for (const [device, result] of perDeviceResults.entries()) {
        const timing = result.executionTimeMs ? ` (${result.executionTimeMs}ms)` : "";
        const status = result.success ? "SUCCESS" : "FAILED";
        logger.info(
          `[PARALLEL_EXEC]   ${device}: ${status} - ${result.executedSteps}/${result.totalSteps} steps${timing}`
        );
        if (result.failedStep) {
          logger.error(
            `[PARALLEL_EXEC]   ${device}: Failed at plan step ${result.failedStep.stepIndex} (track step ${result.failedStep.trackIndex}): ${result.failedStep.error}`
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
    signal?: AbortSignal
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
  }> {
    let executedSteps = 0;

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
          `[PARALLEL_EXEC][${device}] Step ${trackIndex + 1}/${track.length} (plan step ${planIndex}): ${step.tool}, Label: ${stepLabel}`
        );

        // Get the registered tool
        const tool = ToolRegistry.getToolForPlan(step.tool);
        if (!tool) {
          logger.error(`[PARALLEL_EXEC][${device}] Unknown tool: ${step.tool}`);
          return {
            success: false,
            executedSteps,
            totalSteps: track.length,
            failedStep: {
              stepIndex: planIndex,
              trackIndex,
              tool: step.tool,
              error: `Unknown tool: ${step.tool}`,
            },
          };
        }

        try {
          // Inject device context
          const enhancedParams = { ...step.params };

          if (tool.requiresDevice) {
            if (platform && !enhancedParams.platform) {
              enhancedParams.platform = platform;
            }
            // Only inject deviceId if session-based routing won't work (see detailed comment in executeSequential)
            const shouldSuppressDeviceId = sessionUuid && DaemonState.getInstance().isInitialized();
            if (deviceId && !shouldSuppressDeviceId && !enhancedParams.deviceId && !enhancedParams.device) {
              enhancedParams.deviceId = deviceId;
            }
            if (sessionUuid && !enhancedParams.sessionUuid) {
              enhancedParams.sessionUuid = sessionUuid;
            }
          }

          // Parse and validate parameters
          const parsedParams = tool.schema.parse(enhancedParams);

          if (deviceId) {
            ScreenshotJobTracker.cancelJob(deviceId);
          }

          // Execute the tool
          logger.debug(
            `[PARALLEL_EXEC][${device}] Executing ${step.tool} with params: ${JSON.stringify(parsedParams).substring(0, 200)}`
          );
          const response = await tool.handler(parsedParams, undefined, signal);
          throwIfAborted(signal);

          // Unwrap MCP-formatted responses (same as sequential path) so that
          // failures inside { content: [{ text: '{"success":false,...}' }] }
          // are detected instead of silently treated as success.
          const toolResult = this.extractToolResult(response);
          const checkResult = toolResult ?? response;

          if (
            checkResult &&
            typeof checkResult === "object" &&
            "success" in checkResult &&
            checkResult.success === false
          ) {
            const errorMsg = "error" in checkResult ? String(checkResult.error) : "Tool execution failed";
            if (step.optional) {
              // Parallel tracks do not emit the unified debug-step array (see the captureObserveSteps
              // warning in executeParallel), so — consistently with that design — a skipped optional
              // step is logged rather than recorded as a debug step.
              logger.warn(
                `[PARALLEL_EXEC][${device}] optional step ${step.tool} failed; skipping and continuing: ${errorMsg}`
              );
              continue;
            }
            logger.error(`[PARALLEL_EXEC][${device}] Tool failed: ${errorMsg}`);

            const failureObservation = await this.buildFailureObservationContext(
              step.tool,
              response,
              platform,
              deviceId,
              sessionUuid,
            );

            return {
              success: false,
              executedSteps,
              totalSteps: track.length,
              failedStep: {
                stepIndex: planIndex,
                trackIndex,
                tool: step.tool,
                error: errorMsg,
                ...(failureObservation ? { failureObservation } : {}),
              },
            };
          }

          const observeTimedOutParallel =
            step.tool === "observe" ? this.observeWaitForTimedOut(response) : null;
          if (observeTimedOutParallel) {
            const errorMsg = `observe waitFor timed out after ${observeTimedOutParallel.awaitDuration ?? "unknown"}ms`;
            if (step.optional) {
              logger.warn(
                `[PARALLEL_EXEC][${device}] optional step ${step.tool} timed out; skipping and continuing: ${errorMsg}`
              );
              continue;
            }
            logger.error(`[PARALLEL_EXEC][${device}] Tool failed: ${errorMsg}`);
            return {
              success: false,
              executedSteps,
              totalSteps: track.length,
              failedStep: {
                stepIndex: planIndex,
                trackIndex,
                tool: step.tool,
                error: errorMsg,
              },
            };
          }

          executedSteps++;
          logger.debug(
            `[PARALLEL_EXEC][${device}] Step completed successfully. Executed: ${executedSteps}/${track.length}`
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          // An abort must never be swallowed as an optional skip.
          if (step.optional && !signal?.aborted) {
            logger.warn(
              `[PARALLEL_EXEC][${device}] optional step ${step.tool} threw; skipping and continuing: ${errorMessage}`
            );
            continue;
          }
          logger.error(`[PARALLEL_EXEC][${device}] Step execution error: ${errorMessage}`);

          const failureObservation = await this.buildFailureObservationContext(
            step.tool,
            undefined,
            platform,
            deviceId,
            sessionUuid,
          );

          return {
            success: false,
            executedSteps,
            totalSteps: track.length,
            failedStep: {
              stepIndex: planIndex,
              trackIndex,
              tool: step.tool,
              error: errorMessage,
              ...(failureObservation ? { failureObservation } : {}),
            },
          };
        }
      }

      logger.info(
        `[PARALLEL_EXEC][${device}] Device track completed successfully: ${executedSteps}/${track.length} steps`
      );

      return {
        success: true,
        executedSteps,
        totalSteps: track.length,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[PARALLEL_EXEC][${device}] Track execution error: ${errorMessage}`);

      return {
        success: false,
        executedSteps,
        totalSteps: track.length,
        failedStep: {
          stepIndex: -1,
          trackIndex: -1,
          tool: "unknown",
          error: errorMessage,
        },
      };
    }
  }

  /**
   * Creates a combined abort signal from two signals.
   */
  private createCombinedSignal(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    const controller = new AbortController();

    const abort = () => controller.abort();

    if (signal1.aborted || signal2.aborted) {
      controller.abort();
    } else {
      signal1.addEventListener("abort", abort);
      signal2.addEventListener("abort", abort);
    }

    return controller.signal;
  }
}
