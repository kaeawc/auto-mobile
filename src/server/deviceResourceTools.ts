import type {
  DeviceResourceConfigurationResult,
  ConfigurableDeviceResource,
} from "../models/DeviceResourceConfiguration";
import type { DeviceResourceObservationRequest } from "../utils/deviceResourceObserver";
import type { DeviceResourceStatus } from "../models/DeviceResource";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { z } from "zod/v4";
import type { DeviceToolsDependencies } from "./deviceTools";
import { setDeviceResourcesSchema } from "./deviceResourceSchemas";
import { ToolRegistry } from "./toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "./internalToolCall";
import { createJSONToolResponse } from "../utils/toolUtils";
import { getAbortSignal } from "../utils/AbortContext";
import {
  DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../utils/deviceTimeouts";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM, deleteInternalToolParams } from "../daemon/constants";
import {
  trackDeviceAcquisitionReadiness,
  deviceReadinessLockKey,
} from "../utils/deviceReadinessLock";

/** Device-aware registration preserves the normal session/target ownership checks. */
export function registerDeviceResourceTools(dependencies: () => DeviceToolsDependencies): void {
  ToolRegistry.registerDeviceAware(
    "setDeviceResources",
    "Set selected device resources and verify native state. All settings are opt-in; omitted resources stay unchanged. iOS Simulator services and Android optional apps/settings are runtime-dependent. Android changes return a restore receipt for exact restoration during the same boot. Disabling Google infrastructure changes push/auth behavior.",
    setDeviceResourcesSchema,
    async (device, args: z.infer<typeof setDeviceResourcesSchema>, _progress, signal) => {
      const callerSignal = signal ?? getAbortSignal();
      callerSignal?.throwIfAborted();
      const external: Record<string, unknown> = { ...args };
      const transportDeadline = external[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
      deleteInternalToolParams(external);
      delete external[INTERNAL_NO_DIFF_PARAM];
      const parsed = setDeviceResourcesSchema.parse(external);
      const deps = dependencies();
      const requestedDeadline =
        deps.timer.now() + (parsed.timeoutMs ?? DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS);
      const deadlineMs =
        typeof transportDeadline === "number" && Number.isFinite(transportDeadline)
          ? Math.min(requestedDeadline, transportDeadline - START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS)
          : requestedDeadline;
      const lease = await deps.lifecycleCoordinator.reserve(
        {
          kind: "stable",
          platform: device.platform,
          stableId: device.platform === "ios" ? device.deviceId : device.name,
        },
        { operation: "configure", deadlineMs, signal: callerSignal },
      );
      try {
        const operationSignal = callerSignal
          ? AbortSignal.any([callerSignal, lease.signal])
          : lease.signal;
        const configured = await trackDeviceAcquisitionReadiness(
          deviceReadinessLockKey(device.platform, device.deviceId),
          async () => {
            operationSignal.throwIfAborted();
            return deps.deviceResourceControllerFactory().setResources({
              device,
              resources: parsed.resources ?? {},
              restore: parsed.restore,
              deadlineMs,
              signal: operationSignal,
            });
          },
        );
        const result = await observeConfiguredDeviceResources(deps, configured, {
          device,
          deadlineMs,
          signal: operationSignal,
        });
        return {
          ...createJSONToolResponse({ device, ...result }),
          ...(result.success ? {} : { isError: true }),
        };
      } finally {
        lease.release();
      }
    },
    { defaultEnabled: false },
  );
}

// Preserve abort identity and cancellation routing while retaining completed mutation evidence.
export type DeviceResourceObservationAbort = Error & {
  deviceResourceResult: DeviceResourceConfigurationResult;
};
const OBSERVATION_REMAINING_BUDGET_FRACTION = 0.5;

/** Observation is best-effort, but explicit contradictions invalidate configuration success. */
export async function observeConfiguredDeviceResources(
  deps: Pick<DeviceToolsDependencies, "deviceResourceObserverFactory" | "timer">,
  result: DeviceResourceConfigurationResult,
  request: DeviceResourceObservationRequest,
): Promise<DeviceResourceConfigurationResult> {
  const now = deps.timer.now();
  request = {
    ...request,
    deadlineMs: now + Math.max(0, request.deadlineMs - now) * OBSERVATION_REMAINING_BUDGET_FRACTION,
  };
  try {
    request.signal?.throwIfAborted();
    const observed = await deps.deviceResourceObserverFactory().observeResources(request);
    request.signal?.throwIfAborted();
    const states: Partial<Record<ConfigurableDeviceResource, DeviceResourceStatus>> =
      observed.resources;
    const contradictions = (Object.keys(result.requested) as ConfigurableDeviceResource[]).filter(
      (resource) => {
        const state = states[resource]?.state;
        const requested = result.requested[resource];
        return (
          requested !== undefined &&
          (state === "enabled" || state === "disabled") &&
          state !== requested
        );
      },
    );
    return {
      ...result,
      observed,
      ...(contradictions.length
        ? { success: false, observationContradictions: contradictions }
        : {}),
    };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      const reason: unknown = request.signal?.aborted ? request.signal.reason : error;
      // Receipts exist only in returned JSON; cancellation cannot also return a tool response.
      // Carry the result on the same error so direct callers can recover it without suppressing abort.
      const abort =
        reason instanceof Error ? reason : new DOMException(String(reason), "AbortError");
      throw Object.assign(abort, {
        deviceResourceResult: result,
      }) satisfies DeviceResourceObservationAbort;
    }
    logger.warn(`Device resource observation failed: ${errorMessage(error)}`, error);
    // Keep mutation evidence usable when independent observation cannot complete.
    return result;
  }
}
