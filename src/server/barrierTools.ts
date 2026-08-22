import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models/index";
import { logger } from "../utils/logger";
import { createJSONToolResponse, throwIfAborted } from "../utils/toolUtils";
import { CriticalSectionCoordinator } from "./CriticalSectionCoordinator";

// Barrier tool schema. A barrier is a pure synchronization point: every
// participating device arrives, and once all `deviceCount` devices have
// arrived they all proceed concurrently. Unlike criticalSection there is no
// serialized section and no steps — each device's own track continues in
// parallel after the barrier lifts.
const barrierSchema = z.object({
  lock: z
    .string()
    .describe("Shared barrier name; all devices using the same name synchronize together"),
  deviceCount: z
    .number()
    .int()
    .positive()
    .describe("Number of devices that must arrive before the barrier lifts"),
  timeout: z.number().int().positive().optional().describe("Barrier timeout ms (default 30000)"),
  // Internal: the plan's base session UUID, injected by PlanExecutor
  // (buildEnhancedStepParams). Scopes the shared coordinator so two independent
  // plans that reuse the same lock name get isolated barriers instead of
  // colliding. Not authored by users; stripped from recordings via INTERNAL_PARAMS.
  __lockNamespace: z.string().optional().describe("Internal plan-scoped lock namespace (injected)"),
});

type BarrierParams = z.infer<typeof barrierSchema>;

/**
 * Barrier tool handler. Blocks the calling device at a named synchronization
 * point until `deviceCount` devices have arrived, then returns so every device
 * continues concurrently.
 */
const barrierHandler = async (
  device: BootedDevice,
  params: BarrierParams,
  _progress?: unknown,
  signal?: AbortSignal,
): Promise<any> => {
  const { lock, deviceCount, timeout, __lockNamespace: namespace } = params;
  const coordinator = CriticalSectionCoordinator.getInstance();

  logger.info(
    `Device ${device.deviceId} arriving at barrier "${lock}" (expecting ${deviceCount} devices)`,
  );

  throwIfAborted(signal);

  try {
    await coordinator.awaitBarrier(lock, device.deviceId, deviceCount, timeout, namespace);
  } catch (error) {
    // Release any devices still waiting so they fail fast instead of hanging
    // until their own barrier timeout.
    coordinator.forceCleanup(lock, namespace);

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Device ${device.deviceId} error at barrier "${lock}": ${errorMessage}`);
    throw new ActionableError(
      `Barrier "${lock}" failed for device ${device.deviceId}: ${errorMessage}`,
    );
  }

  logger.info(`Device ${device.deviceId} passed barrier "${lock}"`);

  return createJSONToolResponse({
    success: true,
    lock,
    deviceId: device.deviceId,
    deviceCount,
  });
};

/**
 * Register the barrier tool.
 */
export function registerBarrierTools(): void {
  ToolRegistry.registerDeviceAware(
    "barrier",
    "Synchronize multiple devices at a barrier, then let all proceed concurrently (no serialized section).",
    barrierSchema,
    barrierHandler,
    // Plan-only: a multi-device coordination primitive that only makes sense as
    // a plan step (a single direct call would just block). Hidden from tools/list
    // discovery, still runnable in plans via getToolForPlan.
    { defaultEnabled: false, planOnly: true, planExecutable: true, acceptsPlanLockNamespace: true },
  );

  logger.info("Barrier tools registered");
}
