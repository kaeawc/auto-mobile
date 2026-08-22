import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models/index";
import { logger } from "../utils/logger";
import { createJSONToolResponse, throwIfAborted } from "../utils/toolUtils";
import { CriticalSectionCoordinator } from "./CriticalSectionCoordinator";
import { PlanNormalizer } from "../utils/plan/PlanNormalizer";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { formatStructuredToolError } from "../utils/formatStructuredToolError";

// Schema for steps inside critical section.
// Every sub-step MUST declare a target `device` — there is no routing
// fallback inside a critical section, so an undefined device would silently
// run on whichever device acquired the lock first.
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
  z.object({
    lock: z.string().describe("Shared barrier lock name"),
    steps: z
      .array(criticalSectionStepSchema)
      .min(1)
      .describe("Serial steps; each needs params.device"),
    deviceCount: z.number().int().positive().describe("Devices required at barrier"),
    timeout: z.number().int().positive().optional().describe("Barrier timeout ms (default 30000)"),
    // Internal: the plan's base session UUID, injected by PlanExecutor
    // (buildEnhancedStepParams). Scopes the shared coordinator so two independent
    // plans that reuse the same lock name get isolated barriers instead of
    // colliding. Not authored by users; stripped from recordings via INTERNAL_PARAMS.
    __lockNamespace: z
      .string()
      .optional()
      .describe("Internal plan-scoped lock namespace (injected)"),
  }),
);

type CriticalSectionParams = z.infer<typeof criticalSectionSchema>;

function unwrapCriticalSectionResult(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const directResult = result as Record<string, unknown>;
  if ("success" in directResult) {
    return directResult;
  }
  const content = directResult.content;
  const firstContent = Array.isArray(content) ? content[0] : undefined;
  if (!firstContent || typeof firstContent !== "object") {
    return undefined;
  }
  const text = (firstContent as Record<string, unknown>).text;
  if (typeof text !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch (error) {
    logger.debug(`Failed to parse nested critical-section tool response: ${error}`);
    return undefined;
  }
}

function formatCriticalSectionError(result: Record<string, unknown>, tool: string): string {
  return (
    formatStructuredToolError(result.error) ??
    (typeof result.message === "string" ? result.message : `Tool "${tool}" returned failure status`)
  );
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

  // Check for abort before entering
  throwIfAborted(signal);

  // Validate steps to prevent nesting. A nested criticalSection or barrier
  // would deadlock: the device holding this section's mutex would wait for
  // peers that cannot enter until it releases.
  for (const step of normalizedSteps) {
    if (step.tool === "criticalSection" || step.tool === "barrier") {
      throw new ActionableError(
        `Nested critical sections are not supported. Found ${step.tool} step inside critical section "${lock}".`,
      );
    }
  }

  // Register expected device count
  try {
    coordinator.registerExpectedDevices(lock, deviceCount, namespace);
  } catch (error) {
    throw new ActionableError(
      `Failed to register devices for critical section "${lock}": ${error}`,
    );
  }

  let release: (() => void) | undefined;

  try {
    // Wait at barrier and acquire lock
    release = await coordinator.enterCriticalSection(lock, device.deviceId, timeout, namespace);

    logger.info(
      `Device ${device.deviceId} executing ${normalizedSteps.length} steps in critical section "${lock}"`,
    );

    // Execute steps serially
    const executedSteps: Array<{ tool: string; success: boolean }> = [];

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
          throw new ActionableError(`Tool "${step.tool}" not found in registry`);
        }

        const result = await ToolRegistry.callInternal(tool, step.params, undefined, signal, {
          forPlan: true,
          targetDevice: device,
        });

        // Internal tool calls can return an MCP envelope whose JSON payload
        // contains the actual success/error fields.
        const toolResult = unwrapCriticalSectionResult(result);
        if (toolResult?.success === false) {
          const errorMsg = formatCriticalSectionError(toolResult, step.tool);
          throw new ActionableError(errorMsg);
        }

        executedSteps.push({ tool: step.tool, success: true });
      } catch (error) {
        executedSteps.push({ tool: step.tool, success: false });

        const errorMsg = errorMessage(error);
        logger.error(
          `Device ${device.deviceId} failed at step ${i + 1}/${steps.length} in critical section "${lock}": ${errorMsg}`,
        );

        throw new ActionableError(
          `Failed at step ${i + 1}/${steps.length} (${step.tool}): ${errorMsg}`,
        );
      }
    }

    logger.info(`Device ${device.deviceId} completed all steps in critical section "${lock}"`);

    return createJSONToolResponse({
      success: true,
      lock,
      deviceId: device.deviceId,
      executedSteps: executedSteps.length,
      totalSteps: normalizedSteps.length,
    });
  } catch (error) {
    // Force cleanup on error to prevent other devices from waiting forever
    coordinator.forceCleanup(lock, namespace);

    const errorMsg = errorMessage(error);
    logger.error(`Device ${device.deviceId} error in critical section "${lock}": ${errorMsg}`);

    throw new ActionableError(
      `Critical section "${lock}" failed for device ${device.deviceId}: ${errorMsg}`,
    );
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
