import { classifyToolResult } from "../toolEnvelopePayload";
import { waitForTimeoutError } from "./waitForTimeout";
import { isInternalStepParam } from "../../constants/internalStepParams";
import { errorMessage } from "../describeUnknownError";
import type { PlanStep, PlanExecutionResult } from "../../models/Plan";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models";
import { logger, type Logger } from "../logger";
import type { z } from "zod/v4";
import type { PlanExecutionOptions } from "../../models/ExecutePlanResult";
import { throwIfAborted, getStructuredPayload } from "../toolUtils";
import { ZodError } from "zod/v4";
import { Timer, defaultTimer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { ScreenshotJobTracker } from "../ScreenshotJobTracker";
import { isDeviceLostError } from "../../models/DeviceLostError";
import {
  UNEVALUATED_EXPECTATIONS_WARNING,
  formatStepError,
  parseStepParams,
  stripUndeclaredDeviceLabel,
} from "./planStepParams";
import { formatStructuredToolError } from "../formatStructuredToolError";
import {
  summarizeObserveResultForFailure,
  trimObservationForStepCapture,
} from "./summarizeFailureObservation";

/** Only the registry operations and tool metadata required to execute a step. */
export interface PlanStepTool {
  schema: z.ZodType;
  requiresDevice?: boolean;
  acceptsPlanLockNamespace?: boolean;
}

export interface PlanStepTools<TTool extends PlanStepTool> {
  getTool(name: string): TTool | undefined;
  getToolForPlan(name: string): TTool | undefined;
  callInternal(
    tool: TTool,
    params: Record<string, unknown>,
    progress?: undefined,
    signal?: AbortSignal,
    options?: { forPlan?: boolean; sessionUuid?: string; targetDevice?: BootedDevice },
  ): Promise<unknown>;
}

function formatToolError(error: unknown): string {
  return formatStructuredToolError(error) ?? String(error);
}

type StepExecutionStatus = "completed" | "failed" | "skipped";

export interface StepExecutionContext {
  buildFailureObservationContext?: DefaultPlanStepExecutor["buildFailureObservationContext"];
  /** A critical section owns its device; sub-steps and observations must stay pinned to it. */
  targetDevice?: BootedDevice;
  platform?: string;
  deviceId?: string;
  sessionUuid?: string;
  signal?: AbortSignal;
  captureObserveSteps?: NonNullable<PlanExecutionOptions["captureObserveSteps"]>;
  logPrefix: string;
  debugLog?: boolean;
}

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

export interface StepExecutionResult {
  /** Original exception for callers retaining their legacy boundary message/abort reason. */
  sourceError?: unknown;
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
}

/** Retain the plan-shaped failure and diagnostics without changing the legacy message. */
export class PlanStepError extends ActionableError {
  readonly warnings: string[];
  readonly failureObservation;

  constructor(
    message: string,
    warnings: string[],
    readonly failedStep: NonNullable<PlanExecutionResult["failedStep"]>,
  ) {
    super(message);
    this.warnings = [...warnings];
    this.failureObservation = failedStep.failureObservation;
  }
}

/** Which derived session a failure observation targets and the plan signal that can cancel it. */
interface FailureObservationScope {
  targetDevice?: BootedDevice;
  deviceLabel?: string;
  signal?: AbortSignal;
}

/** Shared per-step policy; callers retain their sequencing, coordination and result aggregation. */
export interface PlanStepExecutor {
  executeStep(step: PlanStep, context: StepExecutionContext): Promise<StepExecutionResult>;
}

export class DefaultPlanStepExecutor<
  TTool extends PlanStepTool = PlanStepTool,
> implements PlanStepExecutor {
  private logger: Logger;

  constructor(
    private tools: PlanStepTools<TTool>,
    private isDaemonInitialized: () => boolean,
    private timer: Timer = defaultTimer,
    loggerInstance: Logger = logger,
  ) {
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
  private extractToolResult(
    response: unknown,
    toolName: string,
  ): Record<string, unknown> | undefined {
    const result = classifyToolResult(response, toolName);
    if ("failure" in result) {
      return result.failure;
    }
    return result.kind === "payload"
      ? result.payload
      : (response as Record<string, unknown> | undefined);
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
    if (!Array.isArray(content) || content.length === 0) {
      return null;
    }
    const first = content[0] as Record<string, unknown>;
    if (first?.type !== "text" || typeof first.text !== "string") {
      return null;
    }
    try {
      const parsed = JSON.parse(first.text) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch (error) {
      // Non-JSON text has no structured observation payload; null signals that expected case.
      logger.debug(`src/utils/plan/PlanExecutor.ts fallback failed: ${error}`, error);
      return null;
    }
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
  private static readonly FAILURE_OBSERVATION_TIMEOUT_MS = 3000;

  /**
   * Run the internal failure observe under its own deadline. The plan signal is forwarded so a
   * cancellation that lands mid-capture aborts the observe and releases this wait instead of
   * riding out the deadline (#9885).
   */
  private async callObserveWithDeadline(
    observeTool: TTool,
    parsedParams: Record<string, unknown>,
    signal: AbortSignal | undefined,
    targetDevice?: BootedDevice,
  ): Promise<unknown> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const deadline = new AbortController();
    const onPlanAbort = () => deadline.abort(signal?.reason);
    try {
      const operation = this.tools.callInternal(
        observeTool,
        parsedParams,
        undefined,
        signal,
        targetDevice ? { targetDevice } : undefined,
      );
      signal?.addEventListener("abort", onPlanAbort, { once: true });
      timeoutHandle = this.timer.setTimeout(
        () => deadline.abort(new Error("failure observation timed out")),
        DefaultPlanStepExecutor.FAILURE_OBSERVATION_TIMEOUT_MS,
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
    const shouldSuppressDeviceId = !!(sessionUuid && this.isDaemonInitialized());
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
    { deviceLabel, signal, targetDevice }: FailureObservationScope = {},
  ): Promise<FailureObservationSummary | undefined> {
    const observeTool = this.tools.getTool("observe");
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

      const response = await this.callObserveWithDeadline(
        observeTool,
        parsedParams,
        signal,
        targetDevice,
      );

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

  async buildFailureObservationContext(
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
    tool: TTool,
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

    this.injectDeviceRoutingParams(enhancedParams, step.tool, platform, deviceId, sessionUuid);

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

  private injectDeviceRoutingParams(
    enhancedParams: Record<string, unknown>,
    toolName: string,
    platform?: string,
    deviceId?: string,
    sessionUuid?: string,
  ): void {
    if (platform && !enhancedParams.platform) {
      enhancedParams.platform = platform;
    }

    // Inject deviceId if provided and not already set - BUT only if session-based routing won't work.
    // We suppress deviceId injection when BOTH conditions are met:
    // 1. sessionUuid is present (for session-based routing)
    // 2. daemon is initialized (so session routing will actually work in ToolRegistry)
    // If daemon is not initialized, we still inject deviceId to preserve device targeting,
    // preventing fallback to auto-selection which may target the wrong device.
    const shouldSuppressDeviceId = sessionUuid && this.isDaemonInitialized();
    if (deviceId && !shouldSuppressDeviceId && !enhancedParams.deviceId && !enhancedParams.device) {
      enhancedParams.deviceId = deviceId;
      logger.info(`[PlanExecutor] Injecting deviceId ${deviceId} into ${toolName}`);
    }

    if (sessionUuid) {
      enhancedParams.sessionUuid = sessionUuid;
      logger.info(`[PlanExecutor] Injecting sessionUuid ${sessionUuid} into ${toolName}`);
    }
  }

  async executeStep(step: PlanStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    const tool = this.tools.getToolForPlan(step.tool);
    if (!tool) {
      const error = `Unknown tool: ${step.tool}`;
      return {
        status: "failed",
        sourceError: new ActionableError(`Tool "${step.tool}" not found in registry`),
        error,
        details: { error },
      };
    }

    try {
      const response = await this.callStepTool(tool, step, context);
      // Sections preserve a failing handler's cancellation diagnostic, then check
      // the signal before every subsequent sub-step. Plans check immediately (#9885).
      if (!context.targetDevice) {
        throwIfAborted(context.signal);
      }
      const toolResult = this.extractToolResult(response, step.tool);
      logger.info(
        `${context.logPrefix} ${step.tool} completed. Response success: ${toolResult?.success !== false ? "true" : "FALSE"}`,
      );
      return await this.resultFromResponse(step, context, response, toolResult);
    } catch (error) {
      return this.resultFromThrownError(tool, step, context, error);
    }
  }

  private async callStepTool(
    tool: TTool,
    step: PlanStep,
    context: StepExecutionContext,
  ): Promise<unknown> {
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
    // Every critical-section sub-step must declare its owner label, even for
    // tools whose strict schema has no device field (#9927).
    const parsedParams = parseStepParams(
      tool.schema,
      context.targetDevice
        ? stripUndeclaredDeviceLabel(enhancedParams, tool.schema)
        : enhancedParams,
    );

    if (context.deviceId) {
      ScreenshotJobTracker.cancelJob(context.deviceId);
    }

    const paramsPreview = JSON.stringify(parsedParams).substring(0, 200);
    if (context.debugLog) {
      logger.debug(`${context.logPrefix} Executing ${step.tool} with params: ${paramsPreview}`);
    } else {
      logger.info(`${context.logPrefix} Calling ${step.tool} with params: ${paramsPreview}`);
    }

    return this.tools.callInternal(tool, parsedParams, undefined, context.signal, {
      forPlan: true,
      sessionUuid: context.sessionUuid,
      ...(context.targetDevice ? { targetDevice: context.targetDevice } : {}),
    });
  }

  private shouldSkipReturnedFailure(step: PlanStep, context: StepExecutionContext): boolean {
    return !!step.optional && !(context.targetDevice && context.signal?.aborted);
  }

  private async resultFromResponse(
    step: PlanStep,
    context: StepExecutionContext,
    response: unknown,
    toolResult: Record<string, unknown> | undefined,
  ): Promise<StepExecutionResult> {
    const checkResult = toolResult ?? response;
    if (
      checkResult &&
      typeof checkResult === "object" &&
      "success" in checkResult &&
      checkResult.success === false
    ) {
      const fallbackError = context.targetDevice
        ? String(Reflect.get(checkResult, "message") ?? "returned failure status")
        : "Tool execution failed";
      const error = "error" in checkResult ? formatToolError(checkResult.error) : fallbackError;
      return this.resultFromToolFailure(step, context, response, toolResult, error);
    }
    const error = waitForTimeoutError(getStructuredPayload(toolResult) ?? toolResult, step.tool);
    if (error) {
      if (this.shouldSkipReturnedFailure(step, context)) {
        return {
          status: "skipped",
          error,
          details: { params: step.params, error, optional: true },
        };
      }
      return { status: "failed", error, details: { params: step.params, error } };
    }
    return this.resultFromSuccess(step, context, response, toolResult);
  }

  private async resultFromToolFailure(
    step: PlanStep,
    context: StepExecutionContext,
    response: unknown,
    toolResult: Record<string, unknown> | undefined,
    error: string,
  ): Promise<StepExecutionResult> {
    const buildFailureObservationContext =
      context.buildFailureObservationContext ?? this.buildFailureObservationContext.bind(this);
    const deviceLabel = typeof step.params?.device === "string" ? step.params.device : undefined;
    if (this.shouldSkipReturnedFailure(step, context)) {
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

    const failureObservation = await buildFailureObservationContext(
      step.tool,
      response,
      context.platform,
      context.deviceId,
      context.sessionUuid,
      { deviceLabel, signal: context.signal, targetDevice: context.targetDevice },
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

  private resultFromSuccess(
    step: PlanStep,
    context: StepExecutionContext,
    response: unknown,
    toolResult: Record<string, unknown> | undefined,
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
      ...(warnings ? { warnings } : {}),
    };
  }

  private async observationForThrownStep(
    step: PlanStep,
    context: StepExecutionContext,
    error: unknown,
  ): Promise<FailureObservationSummary | undefined> {
    if (context.signal?.aborted) {
      return undefined;
    }
    // A nested section already captured its owner's failing screen. Reuse it
    // rather than observe again after the lock has been released.
    if (error instanceof PlanStepError && error.failureObservation) {
      return error.failureObservation;
    }
    const deviceLabel = typeof step.params?.device === "string" ? step.params.device : undefined;
    const buildFailureObservationContext =
      context.buildFailureObservationContext ?? this.buildFailureObservationContext.bind(this);
    return buildFailureObservationContext(
      step.tool,
      undefined,
      context.platform,
      context.deviceId,
      context.sessionUuid,
      { deviceLabel, signal: context.signal, targetDevice: context.targetDevice },
    );
  }

  private async resultFromThrownError(
    tool: TTool,
    step: PlanStep,
    context: StepExecutionContext,
    error: unknown,
  ): Promise<StepExecutionResult> {
    if (isDeviceLostError(error)) {
      throw error;
    }
    const errorMsg = formatStepError(step.tool, error, step.params, tool.schema);
    if (step.optional && !context.signal?.aborted && !(error instanceof ZodError)) {
      this.logger.warn(
        `${context.logPrefix} optional step ${step.tool} threw; returning skipped status`,
        error,
      );
      const warnings = toolResultWarnings(error);
      return {
        status: "skipped",
        sourceError: error,
        error: errorMsg,
        ...(warnings ? { warnings } : {}),
        details: {
          params: step.params,
          error: errorMsg,
          optional: true,
        },
      };
    }

    const failureObservation = await this.observationForThrownStep(step, context, error);
    this.logger.warn(
      `${context.logPrefix} step ${step.tool} threw; returning failed status`,
      error,
    );
    const warnings = toolResultWarnings(error);
    return {
      status: "failed",
      sourceError: error,
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
