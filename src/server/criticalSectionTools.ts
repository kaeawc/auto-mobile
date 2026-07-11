import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models/index";
import { logger } from "../utils/logger";
import { createJSONToolResponse, throwIfAborted } from "../utils/toolUtils";
import { CriticalSectionCoordinator } from "./CriticalSectionCoordinator";
import { PlanNormalizer } from "../utils/plan/PlanNormalizer";

// Schema for steps inside critical section.
// Every sub-step MUST declare a target `device` — there is no routing
// fallback inside a critical section, so an undefined device would silently
// run on whichever device acquired the lock first.
const criticalSectionStepSchema = z
  .object({
    tool: z.string().describe("Tool name"),
    params: z
      .record(z.string(), z.any())
      .describe("Tool params; must include device"),
    label: z.string().optional().describe("Step label"),
  })
  .passthrough()
  .superRefine((step, ctx) => {
    const device = step.params?.device;
    if (device === undefined || device === null || device === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "device"],
        message:
          "Every step inside a criticalSection must declare a non-empty 'device' parameter",
      });
    }
  });

type CriticalSectionStepInput = z.infer<typeof criticalSectionStepSchema>;

// Critical section tool schema
const criticalSectionSchema = z.object({
  lock: z
    .string()
    .describe(
      "Shared barrier lock name"
    ),
  steps: z
    .array(criticalSectionStepSchema)
    .min(1)
    .describe(
      "Serial steps; each needs params.device"
    ),
  deviceCount: z
    .number()
    .int()
    .positive()
    .describe(
      "Devices required at barrier"
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Barrier timeout ms (default 30000)"
    ),
});

type CriticalSectionParams = z.infer<typeof criticalSectionSchema>;

/**
 * Critical section tool handler.
 * Coordinates multiple devices to execute steps serially at a synchronization point.
 */
const criticalSectionHandler = async (
  device: BootedDevice,
  params: CriticalSectionParams,
  _progress?: unknown,
  signal?: AbortSignal
): Promise<any> => {
  const { lock, steps, deviceCount, timeout } = params;
  const normalizedSteps = PlanNormalizer.normalizeSteps(
    steps as CriticalSectionStepInput[]
  );
  const coordinator = CriticalSectionCoordinator.getInstance();

  logger.info(
    `Device ${device.deviceId} entering critical section "${lock}" (expecting ${deviceCount} devices)`
  );

  // Check for abort before entering
  throwIfAborted(signal);

  // Validate steps to prevent nesting. A nested criticalSection or barrier
  // would deadlock: the device holding this section's mutex would wait for
  // peers that cannot enter until it releases.
  for (const step of normalizedSteps) {
    if (step.tool === "criticalSection" || step.tool === "barrier") {
      throw new ActionableError(
        `Nested critical sections are not supported. Found ${step.tool} step inside critical section "${lock}".`
      );
    }
  }

  // Register expected device count
  try {
    coordinator.registerExpectedDevices(lock, deviceCount);
  } catch (error) {
    throw new ActionableError(
      `Failed to register devices for critical section "${lock}": ${error}`
    );
  }

  let release: (() => void) | undefined;

  try {
    // Wait at barrier and acquire lock
    release = await coordinator.enterCriticalSection(
      lock,
      device.deviceId,
      timeout
    );

    logger.info(
      `Device ${device.deviceId} executing ${normalizedSteps.length} steps in critical section "${lock}"`
    );

    // Execute steps serially
    const executedSteps: Array<{ tool: string; success: boolean }> = [];

    for (let i = 0; i < normalizedSteps.length; i++) {
      const step = normalizedSteps[i];
      throwIfAborted(signal);

      logger.debug(
        `Device ${device.deviceId} executing step ${i + 1}/${normalizedSteps.length}: ${step.tool}`
      );

      try {
        // Critical-section steps are plan steps, so use the same lookup rules
        // as executePlan for tools hidden from MCP discovery.
        const tool = ToolRegistry.getToolForPlan(step.tool);
        if (!tool) {
          throw new ActionableError(`Tool "${step.tool}" not found in registry`);
        }

        // Execute the tool with the device context
        let result;
        if (tool.deviceAwareHandler) {
          // Device-aware tool
          result = await tool.deviceAwareHandler(
            device,
            step.params,
            undefined,
            signal
          );
        } else if (tool.handler) {
          // Regular tool
          result = await tool.handler(step.params, undefined, signal);
        } else {
          throw new ActionableError(
            `Tool "${step.tool}" has no handler registered`
          );
        }

        // Check if tool returned failure
        if (result?.success === false) {
          const errorMsg =
						result.error || `Tool "${step.tool}" returned failure status`;
          throw new ActionableError(errorMsg);
        }

        executedSteps.push({ tool: step.tool, success: true });
      } catch (error) {
        executedSteps.push({ tool: step.tool, success: false });

        const errorMessage =
					error instanceof Error ? error.message : String(error);
        logger.error(
          `Device ${device.deviceId} failed at step ${i + 1}/${steps.length} in critical section "${lock}": ${errorMessage}`
        );

        throw new ActionableError(
          `Failed at step ${i + 1}/${steps.length} (${step.tool}): ${errorMessage}`
        );
      }
    }

    logger.info(
      `Device ${device.deviceId} completed all steps in critical section "${lock}"`
    );

    return createJSONToolResponse({
      success: true,
      lock,
      deviceId: device.deviceId,
      executedSteps: executedSteps.length,
      totalSteps: normalizedSteps.length,
    });
  } catch (error) {
    // Force cleanup on error to prevent other devices from waiting forever
    coordinator.forceCleanup(lock);

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Device ${device.deviceId} error in critical section "${lock}": ${errorMessage}`
    );

    throw new ActionableError(
      `Critical section "${lock}" failed for device ${device.deviceId}: ${errorMessage}`
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
  ToolRegistry.registerDeviceAware("criticalSection", "Synchronize multiple devices at a barrier, then run steps serially.", criticalSectionSchema, criticalSectionHandler);

  logger.info("Critical section tools registered");
}
