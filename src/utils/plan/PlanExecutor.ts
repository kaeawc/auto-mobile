import { classifyToolResult } from "../toolEnvelopePayload";
import { waitForTimeoutDiagnostics, waitForTimeoutError } from "./waitForTimeout";
import { isInternalStepParam } from "../../constants/internalStepParams";
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
import { throwIfAborted, getStructuredPayload } from "../toolUtils";
import { ZodError } from "zod/v4";
import { PlanPartitioner, TrackedStep } from "./PlanPartitioner";
import { getPlanDevicePlatform } from "./PlanDevices";
import { computeSafeBarrierResumeStep, isCoordinationTool } from "./BarrierResumeGuard";
import {
  isParticipantFailureAbort,
  ParticipantFailureTracker,
  type ParticipantFailedError,
} from "./ParticipantFailureTracker";
import { DaemonState } from "../../daemon/daemonState";
import { Timer, defaultTimer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { ScreenshotJobTracker } from "../ScreenshotJobTracker";
import {
  type DeviceLostError,
  isDeviceLostError,
  rememberDeviceLossAbort,
} from "../../models/DeviceLostError";
import {
  UNEVALUATED_EXPECTATIONS_WARNING,
  formatStepError,
  parseStepParams,
} from "./planStepParams";
import { formatStructuredToolError } from "../formatStructuredToolError";
import { PlanToolResultsBudget, StepToolResultCollector } from "./stepToolResults";
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

export { UNEVALUATED_EXPECTATIONS_WARNING };

function withUnevaluatedExpectationsWarning(
  step: PlanStep,
  toolWarnings: string[] | undefined,
  details: Record<string, unknown>,
): string[] | undefined {
  if (!step.expectations || step.expectations.length === 0) {
    return toolWarnings;
  }
  const warnings = [...(toolWarnings ?? []), UNEVALUATED_EXPECTATIONS_WARNING];
  details.warnings = warnings;
  return warnings;
}

/**
 * The string warnings a tool payload or thrown error reported, or undefined when it reported
 * none (issue #6868).
 */
function toolResultWarnings(payload: unknown): string[] | undefined {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("warnings" in payload) ||
    !Array.isArray(payload.warnings)
  ) {
    return undefined;
  }
  const warnings = payload.warnings.filter((entry): entry is string => typeof entry === "string");
  return warnings.length > 0 ? warnings : undefined;
}

interface StepExecutionResult {
  status: StepExecutionStatus;
  error?: string;
  details: Record<string, unknown>;
  failureObservation?: FailureObservationSummary;
  /**
   * Best-effort warnings from the tool, including sub-steps preceding a failure.
   * Carried separately from `details` so the plan result can promote
   * them out of the debug-only step trace (#6887 review).
   */
  warnings?: string[];
  /**
   * A completed step's unwrapped tool payload, bounded and promoted to the plan result's
   * `toolResults` by the caller (#10090). Absent when the tool returned no object payload.
   */
  toolPayload?: unknown;
}

/**
 * The structured payload of a completed step's tool response, or undefined when it carried none
 * (an image-only success), so the raw envelope and its image data never reach `toolResults`.
 */
function completedStepPayload(
  response: unknown,
  toolName: string,
): Record<string, unknown> | undefined {
  // An envelope with a hoisted top-level `success` classifies as its own payload, so read the
  // structured payload off it first; only a bare (unwrapped) object is used as-is.
  const structured = getStructuredPayload<Record<string, unknown>>(
    response as { structuredContent?: unknown; content?: unknown } | null | undefined,
  );
  if (structured) {
    return structured;
  }
  const interpretation = classifyToolResult(response, toolName, null);
  if ("failure" in interpretation || interpretation.kind !== "payload") {
    return undefined;
  }
  const { payload } = interpretation;
  return "content" in payload || "structuredContent" in payload ? undefined : payload;
}

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

/** The optional-step skip record shared by every "tool answered but the step failed" branch. */
function skippedOptionalResult(step: PlanStep, error: string): StepExecutionResult {
  return {
    status: "skipped",
    error,
    details: { params: step.params, error, optional: true },
  };
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

/** Which derived session a failure observation targets and the plan signal that can cancel it. */
interface FailureObservationScope {
  deviceLabel?: string;
  signal?: AbortSignal;
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
  private extractToolResult(response: unknown, toolName: string): any {
    const result = classifyToolResult(response, toolName);
    if ("failure" in result) {
      return result.failure;
    }
    return result.kind === "payload" ? result.payload : response;
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
   * Copies tool-specific diagnostics into executePlan `debug.steps[n].details`
   * (e.g. Android `tapOn` -> `tapDebug`).
   */
  private mergeToolDiagnosticsIntoStepDetails(
    toolName: string,
    toolResult: unknown,
    details: Record<string, unknown>,
  ): string[] | undefined {
    if (toolResult === null || typeof toolResult !== "object") {
      return undefined;
    }
    const tr = toolResult as Record<string, unknown>;
    const payload = getStructuredPayload<Record<string, unknown>>(tr) ?? tr;
    // `warnings` is the generic best-effort-epilogue channel (issue #6868): the
    // step stays successful, but the outcome it reports — a keyboard that would
    // not dismiss, say — used to be the step's `success:false` and is the only
    // thing telling a plan author why a later step saw the screen it saw. Copy it
    // for EVERY tool rather than dropping it into the void, and return it so the
    // caller can promote it onto the plan result (#6887 review).
    const warnings = toolResultWarnings(payload);
    if (warnings) {
      details.warnings = warnings;
    }
    if (toolName === "tapOn" && payload.tapDebug !== undefined && payload.tapDebug !== null) {
      details.tapDebug = payload.tapDebug;
    }
    return warnings;
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

  private static readonly FAILURE_OBSERVATION_TIMEOUT_MS = 3000;

  /**
   * Run the internal failure observe under its own deadline. The plan signal is forwarded so a
   * cancellation that lands mid-capture aborts the observe and releases this wait instead of
   * riding out the deadline (#9885).
   */
  private async callObserveWithDeadline(
    observeTool: RegisteredTool,
    parsedParams: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const deadline = new AbortController();
    const onPlanAbort = () => deadline.abort(signal?.reason);
    try {
      const operation = ToolRegistry.callInternal(observeTool, parsedParams, undefined, signal);
      signal?.addEventListener("abort", onPlanAbort, { once: true });
      timeoutHandle = this.timer.setTimeout(
        () => deadline.abort(new Error("failure observation timed out")),
        DefaultPlanExecutor.FAILURE_OBSERVATION_TIMEOUT_MS,
      );
      return await raceWithDeadline(operation, {
        timer: this.timer,
        signal: deadline.signal,
        label: "failure observation",
      });
    } finally {
      signal?.removeEventListener("abort", onPlanAbort);
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private buildFailureObservationParams(
    platform: string,
    deviceId: string | undefined,
    sessionUuid: string | undefined,
    deviceLabel: string | undefined,
  ): Record<string, unknown> {
    const enhancedParams: Record<string, unknown> = { platform };
    const shouldSuppressDeviceId = !!(sessionUuid && DaemonState.getInstance().isInitialized());
    if (deviceId && !shouldSuppressDeviceId) {
      enhancedParams.deviceId = deviceId;
    }
    if (sessionUuid) {
      enhancedParams.sessionUuid = sessionUuid;
    }
    // Use the failed step's label so ToolRegistry selects the same derived
    // session, rather than observing the plan's base-session device (#9828).
    if (deviceLabel) {
      enhancedParams.device = deviceLabel;
    }
    return enhancedParams;
  }

  private async captureFailureObservation(
    platform: string,
    deviceId: string | undefined,
    sessionUuid: string | undefined,
    { deviceLabel, signal }: FailureObservationScope = {},
  ): Promise<FailureObservationSummary | undefined> {
    const observeTool = ToolRegistry.getTool("observe");
    // A plan cancelled by a session release no longer owns the device, so a
    // failure observation must not be issued against it (#9885).
    if (!observeTool || signal?.aborted) {
      return undefined;
    }
    try {
      const enhancedParams = this.buildFailureObservationParams(
        platform,
        deviceId,
        sessionUuid,
        deviceLabel,
      );
      // Internal failure-recovery observe (#3053): the callInternal seam (#3108)
      // marks it internal so it does not overwrite the agent-facing diff baseline
      // (`observe` always resets it). This capture is for the plan's failure
      // summary, not shown to the agent. Parse against the tool schema first, then
      // pass the resolved tool to the seam so the timeout race stays local.
      const parsedParams = parseStepParams(observeTool.schema, enhancedParams);

      const response = await this.callObserveWithDeadline(observeTool, parsedParams, signal);

      const raw = this.parseStructuredToolPayload(response);
      if (!raw) {
        return { capturedAtMs: Date.now(), observeError: "observe returned empty payload" };
      }
      return summarizeObserveResultForFailure(raw);
    } catch (error) {
      if (signal?.aborted) {
        // Cancelled mid-capture: there is no observation to report (#9885).
        return undefined;
      }
      // The observe schema parse above can throw a ZodError; render it the same
      // way the MCP boundary does rather than leaking the raw issue dump (#5854).
      return {
        capturedAtMs: Date.now(),
        observeError:
          error instanceof ZodError
            ? formatStepError("observe", error, undefined, observeTool.schema)
            : errorMessage(error),
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
    scope: FailureObservationScope = {},
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
      return await this.captureFailureObservation(platform, deviceId, sessionUuid, scope);
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
    for (const key of Object.keys(enhancedParams)) {
      if (isInternalStepParam(key)) {
        delete enhancedParams[key];
      }
    }

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

  /**
   * A tool answered but the step failed (`success: false` or a `waitFor` timeout):
   * capture the failure observation, copy the tool's diagnostics into the step
   * details, and return the tool's warnings so the plan result can promote them.
   */
  private async buildToolAnsweredFailure(
    step: PlanStep,
    context: StepExecutionContext,
    deviceLabel: string | undefined,
    failure: {
      response: unknown;
      toolResult: unknown;
      error: string;
      waitForTimeout?: Record<string, unknown>;
    },
  ): Promise<StepExecutionResult> {
    const { response, toolResult, error, waitForTimeout } = failure;
    const failureObservation = await this.buildFailureObservationContext(
      step.tool,
      response,
      context.platform,
      context.deviceId,
      context.sessionUuid,
      { deviceLabel, signal: context.signal },
    );
    const details: Record<string, unknown> = {
      params: step.params,
      error,
      ...(toolResult && typeof toolResult === "object" && "debug" in toolResult
        ? { toolDebug: toolResult.debug }
        : {}),
      ...(waitForTimeout ? { waitForTimeout } : {}),
      ...(failureObservation ? { failureObservation } : {}),
    };
    const warnings = this.mergeToolDiagnosticsIntoStepDetails(step.tool, toolResult, details);
    return {
      status: "failed",
      error,
      details,
      failureObservation,
      ...(warnings ? { warnings } : {}),
    };
  }

  /**
   * A tool answered and the step passed: build its debug details, promote its warnings, and keep
   * its structured payload for the plan result's `toolResults` (#10090).
   */
  private buildCompletedStepResult(
    step: PlanStep,
    context: StepExecutionContext,
    response: unknown,
    toolResult: unknown,
  ): StepExecutionResult {
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
    const toolWarnings = this.mergeToolDiagnosticsIntoStepDetails(step.tool, toolResult, details);
    const warnings = withUnevaluatedExpectationsWarning(step, toolWarnings, details);

    return {
      status: "completed",
      details,
      toolPayload: completedStepPayload(response, step.tool),
      ...(warnings ? { warnings } : {}),
    };
  }

  private async executeStep(
    step: PlanStep,
    context: StepExecutionContext,
  ): Promise<StepExecutionResult> {
    const deviceLabel = typeof step.params?.device === "string" ? step.params.device : undefined;
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

      // Parse and validate parameters; strict schemas throw on unknown keys, which
      // are caught here and reported as a failed or skipped step.
      // The internal marker (#3053) is applied by the callInternal seam (#3108)
      // below so finalize emits the full observation on the step envelope - never
      // a diff or a stripped payload - regardless of
      // `--actions-diff-observe`/`--actions-no-observe`.
      const parsedParams = parseStepParams(tool.schema, enhancedParams);

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

      const toolResult = this.extractToolResult(response, step.tool);
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
          return skippedOptionalResult(step, error);
        }
        return await this.buildToolAnsweredFailure(step, context, deviceLabel, {
          response,
          toolResult,
          error,
        });
      }

      const timeoutPayload = getStructuredPayload(toolResult) ?? toolResult;
      const error = waitForTimeoutError(timeoutPayload, step.tool);
      if (error) {
        if (step.optional) {
          return skippedOptionalResult(step, error);
        }
        // A waitFor timeout is a failed step like any other: it gets the same
        // failure observation and diagnostics as a `success: false` result, plus
        // what the timeout itself reported (#10024).
        return await this.buildToolAnsweredFailure(step, context, deviceLabel, {
          response,
          toolResult,
          error,
          waitForTimeout: waitForTimeoutDiagnostics(timeoutPayload),
        });
      }

      return this.buildCompletedStepResult(step, context, response, toolResult);
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      const errorMsg = formatStepError(step.tool, error, step.params, tool.schema);
      // A wait cut short because a participant track failed (#10025) skips an optional step
      // exactly like the barrier timeout it replaces; any other abort still fails it.
      const abortedForOtherReason =
        context.signal?.aborted && !isParticipantFailureAbort(context.signal);
      if (step.optional && !abortedForOtherReason && !(error instanceof ZodError)) {
        this.logger.warn(
          `${context.logPrefix} optional step ${step.tool} threw; returning skipped status`,
          error,
        );
        const warnings = toolResultWarnings(error);
        return {
          status: "skipped",
          error: errorMsg,
          ...(warnings ? { warnings } : {}),
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
            { deviceLabel, signal: context.signal },
          );
      this.logger.warn(
        `${context.logPrefix} step ${step.tool} threw; returning failed status`,
        error,
      );
      const warnings = toolResultWarnings(error);
      return {
        status: "failed",
        error: errorMsg,
        details: {
          params: step.params,
          error: errorMsg,
          ...(failureObservation ? { failureObservation } : {}),
          ...(warnings ? { warnings } : {}),
        },
        failureObservation,
        ...(warnings ? { warnings } : {}),
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
