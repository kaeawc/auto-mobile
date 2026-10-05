import { classifyToolResult } from "../utils/toolEnvelopePayload";
import { waitForTimeoutError } from "../utils/plan/waitForTimeout";
import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice, toActionableError } from "../models/index";
import { logger } from "../utils/logger";
import { createJSONToolResponse, getStructuredPayload, throwIfAborted } from "../utils/toolUtils";
import { CriticalSectionCoordinator } from "./CriticalSectionCoordinator";
import { PlanNormalizer } from "../utils/plan/PlanNormalizer";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { formatStructuredToolError } from "../utils/formatStructuredToolError";
import { isDeviceLostError } from "./deviceLossOutcome";
import type { PlanStep } from "../models/Plan";

// Schema for steps inside critical section.
// Every sub-step MUST declare a `device` matching the section owner label.
// Sub-steps execute on that owner device; they never route to another label.
const criticalSectionStepSchema = z
  .object({
    tool: z.string().describe("Tool name"),
    params: z.record(z.string(), z.any()).describe("Tool params; must include device"),
    label: z.string().optional().describe("Step label"),
  })
  .passthrough()
  .superRefine((step, ctx) => {
    const device = step.params?.device;
    if (device === undefined || device === null || device === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "device"],
        message: "Every step inside a criticalSection must declare a non-empty 'device' parameter",
      });
    }
  });

type CriticalSectionStepInput = z.infer<typeof criticalSectionStepSchema>;

// Critical section tool schema
const criticalSectionSchema = addDeviceTargetingToSchema(
  z
    .object({
      lock: z.string().describe("Shared barrier lock name"),
      steps: z
        .array(criticalSectionStepSchema)
        .min(1)
        .describe("Serial steps; each needs params.device"),
      deviceCount: z.number().int().positive().describe("Devices required at barrier"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Barrier timeout ms (default 30000)"),
      // Internal: the plan's base session UUID, injected by PlanExecutor
      // (buildEnhancedStepParams). Scopes the shared coordinator so two independent
      // plans that reuse the same lock name get isolated barriers instead of
      // colliding. Not authored by users; stripped from recordings via INTERNAL_PARAMS.
      __lockNamespace: z
        .string()
        .optional()
        .describe("Internal plan-scoped lock namespace (injected)"),
    })
    .strict(),
);

type CriticalSectionParams = z.infer<typeof criticalSectionSchema>;

function unwrapCriticalSectionResult(
  response: unknown,
  toolName: string,
): Record<string, unknown> | undefined {
  const result = classifyToolResult(response, toolName);
  if ("failure" in result) {
    return result.failure;
  }
  return result.kind === "payload" ? result.payload : undefined;
}

/**
 * Best-effort epilogue warnings a step reported while still succeeding (issue
 * #6868) — a keyboard that would not dismiss, for example. The step stays
 * successful, but this used to be its `success:false`, so dropping it would let
 * the section report an entirely clean success while later steps run against a
 * screen the caller does not expect.
 */
function collectStepWarnings(
  stepNumber: number,
  tool: string,
  result: Record<string, unknown> | undefined,
): string[] {
  // Structured action responses hoist success/error, but keep warnings in the
  // payload. Read the same payload as PlanExecutor's diagnostic collector.
  const warnings = (getStructuredPayload(result) ?? result)?.warnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings
    .filter((warning): warning is string => typeof warning === "string")
    .map((warning) => `step ${stepNumber} (${tool}): ${warning}`);
}

function criticalSectionSuccess(
  lock: string,
  deviceId: string,
  executedSteps: number,
  totalSteps: number,
  warnings: string[],
): ReturnType<typeof createJSONToolResponse> {
  return createJSONToolResponse({
    success: true,
    lock,
    deviceId,
    executedSteps,
    totalSteps,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

function formatCriticalSectionError(result: Record<string, unknown>, tool: string): string {
  return (
    formatStructuredToolError(result.error) ??
    (typeof result.message === "string" ? result.message : `Tool "${tool}" returned failure status`)
  );
}

// PlanExecutor treats failed tool lookup as fatal even for optional steps.
class CriticalSectionToolNotFoundError extends ActionableError {}

/** Retain diagnostics from sub-steps that ran before a required failure. */
class CriticalSectionStepError extends ActionableError {
  readonly warnings: string[];

  constructor(message: string, warnings: string[]) {
    super(message);
    this.warnings = [...warnings];
  }
}

function handleCriticalSectionStepFailure(
  error: unknown,
  step: { tool: string; optional?: boolean },
  context: {
    deviceId: string;
    lock: string;
    stepNumber: number;
    totalSteps: number;
    signal?: AbortSignal;
    warnings: string[];
  },
): void {
  const { deviceId, lock, stepNumber, totalSteps, signal, warnings } = context;
  if (
    isDeviceLostError(error) ||
    (step.optional && (signal?.aborted || error instanceof z.ZodError))
  ) {
    throw error;
  }

  const errorMsg = errorMessage(error);
  if (step.optional && !(error instanceof CriticalSectionToolNotFoundError)) {
    warnings.push(`step ${stepNumber} (${step.tool}): optional step failed; skipped: ${errorMsg}`);
    logger.warn(
      `Device ${deviceId} optional step ${step.tool} failed; skipping and continuing: ${errorMsg}`,
    );
    return;
  }

  logger.error(
    `Device ${deviceId} failed at step ${stepNumber}/${totalSteps} in critical section "${lock}": ${errorMsg}`,
  );
  throw new CriticalSectionStepError(
    `Failed at step ${stepNumber}/${totalSteps} (${step.tool}): ${errorMsg}`,
    warnings,
  );
}

async function executeCriticalSectionSteps(
  device: BootedDevice,
  normalizedSteps: PlanStep[],
  lock: string,
  totalSteps: number,
  signal?: AbortSignal,
): Promise<{ executedSteps: Array<{ tool: string; success: boolean }>; warnings: string[] }> {
  const executedSteps: Array<{ tool: string; success: boolean }> = [];
  const warnings: string[] = [];

  for (let i = 0; i < normalizedSteps.length; i++) {
    const step = normalizedSteps[i];
    throwIfAborted(signal);

    logger.debug(
      `Device ${device.deviceId} executing step ${i + 1}/${normalizedSteps.length}: ${step.tool}`,
    );

    try {
      // Critical-section steps are plan steps, so use the same lookup rules
      // as executePlan for tools hidden from MCP discovery.
      const tool = ToolRegistry.getToolForPlan(step.tool);
      if (!tool) {
        throw new CriticalSectionToolNotFoundError(`Tool "${step.tool}" not found in registry`);
      }

      const result = await ToolRegistry.callInternal(tool, step.params, undefined, signal, {
        forPlan: true,
        targetDevice: device,
      });

      // Internal tool calls can return an MCP envelope whose JSON payload
      // contains the actual success/error fields.
      const toolResult = unwrapCriticalSectionResult(result, step.tool);
      if (toolResult?.success === false) {
        const errorMsg = formatCriticalSectionError(toolResult, step.tool);
        throw new ActionableError(errorMsg);
      }
      const timeoutError = waitForTimeoutError(
        getStructuredPayload(toolResult) ?? toolResult,
        step.tool,
      );
      if (timeoutError) {
        throw new ActionableError(timeoutError);
      }

      warnings.push(...collectStepWarnings(i + 1, step.tool, toolResult));
      executedSteps.push({ tool: step.tool, success: true });
    } catch (error) {
      executedSteps.push({ tool: step.tool, success: false });

      handleCriticalSectionStepFailure(error, step, {
        deviceId: device.deviceId,
        lock,
        stepNumber: i + 1,
        totalSteps,
        signal,
        warnings,
      });
    }
  }

  return { executedSteps, warnings };
}

function validateCriticalSectionSteps(
  normalizedSteps: PlanStep[],
  lock: string,
  ownerLabel?: string,
): void {
  // Validate steps to prevent nesting. A nested criticalSection or barrier
  // would deadlock: the device holding this section's mutex would wait for
  // peers that cannot enter until it releases.
  for (const [index, step] of normalizedSteps.entries()) {
    // Plan routing retains the owner label in params.device. A direct call
    // without that label keeps its existing pinned-device behavior.
    if (
      ownerLabel &&
      step.params?.device !== undefined &&
      step.params.device !== null &&
      step.params.device !== "" &&
      step.params.device !== ownerLabel
    ) {
      throw new ActionableError(
        `steps[${index}] (${step.tool}): device="${step.params.device}" differs from criticalSection owner device="${ownerLabel}". Put it in its own step for that device or use a separate criticalSection step.`,
      );
    }
    if (step.tool === "criticalSection" || step.tool === "barrier") {
      throw new ActionableError(
        `Nested critical sections are not supported. Found ${step.tool} step inside critical section "${lock}".`,
      );
    }
  }
}

/**
 * Critical section tool handler.
 * Coordinates multiple devices to execute steps serially at a synchronization point.
 */
const criticalSectionHandler = async (
  device: BootedDevice,
  params: CriticalSectionParams,
  _progress?: unknown,
  signal?: AbortSignal,
): Promise<any> => {
  const { lock, steps, deviceCount, timeout, __lockNamespace: namespace } = params;
  const normalizedSteps = PlanNormalizer.normalizeSteps(steps as CriticalSectionStepInput[]);
  const coordinator = CriticalSectionCoordinator.getInstance();

  logger.info(
    `Device ${device.deviceId} entering critical section "${lock}" (expecting ${deviceCount} devices)`,
  );

  // Preserve the caller's abort reason before entering coordination.
  signal?.throwIfAborted();

  validateCriticalSectionSteps(normalizedSteps, lock, params.device);

  // Register expected device count
  try {
    coordinator.registerExpectedDevices(lock, deviceCount, namespace);
  } catch (error) {
    throw toActionableError(error, `Failed to register devices for critical section "${lock}"`);
  }

  let release: (() => void) | undefined;

  try {
    // Wait at barrier and acquire lock
    release = await coordinator.enterCriticalSection(
      lock,
      device.deviceId,
      timeout,
      namespace,
      signal,
    );

    logger.info(
      `Device ${device.deviceId} executing ${normalizedSteps.length} steps in critical section "${lock}"`,
    );

    // Execute steps serially
    const { executedSteps, warnings } = await executeCriticalSectionSteps(
      device,
      normalizedSteps,
      lock,
      steps.length,
      signal,
    );

    logger.info(`Device ${device.deviceId} completed all steps in critical section "${lock}"`);

    return criticalSectionSuccess(
      lock,
      device.deviceId,
      executedSteps.length,
      normalizedSteps.length,
      warnings,
    );
  } catch (error) {
    // Force cleanup on error to prevent other devices from waiting forever
    coordinator.forceCleanup(lock, namespace);

    const errorMsg = errorMessage(error);
    logger.error(`Device ${device.deviceId} error in critical section "${lock}": ${errorMsg}`);

    if (isDeviceLostError(error) || (signal?.aborted && error === signal.reason)) {
      throw error;
    }
    const message = `Critical section "${lock}" failed for device ${device.deviceId}: ${errorMsg}`;
    if (error instanceof CriticalSectionStepError) {
      throw new CriticalSectionStepError(message, error.warnings);
    }
    throw new ActionableError(message);
  } finally {
    // Release the lock if we acquired it
    if (release) {
      release();
    }
  }
};

/**
 * Register the criticalSection tool.
 */
export function registerCriticalSectionTools(): void {
  ToolRegistry.registerDeviceAware(
    "criticalSection",
    "Synchronize multiple devices at a barrier, then run steps serially.",
    criticalSectionSchema,
    criticalSectionHandler,
    // Plan-only: a multi-device coordination primitive that only makes sense as
    // a plan step (a single direct call would just block). Hidden from tools/list
    // discovery, still runnable in plans via getToolForPlan.
    { defaultEnabled: false, planOnly: true, planExecutable: true, acceptsPlanLockNamespace: true },
  );

  logger.info("Critical section tools registered");
}
