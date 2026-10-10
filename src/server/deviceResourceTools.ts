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
import { reconcileDeviceResourcesSchema, setDeviceResourcesSchema } from "./deviceResourceSchemas";
import type { BootedDevice } from "../models/DeviceInfo";
import { ToolRegistry } from "./toolRegistry";
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
      const parsed = setDeviceResourcesSchema.parse(external);
      const deps = dependencies();
      const deadlineMs = resolveResourceDeadline(deps, parsed.timeoutMs, transportDeadline);
      return withDeviceResourceLease(
        deps,
        device,
        deadlineMs,
        callerSignal,
        async (operationSignal) => {
          const configured = await withDeviceReadiness(device, operationSignal, () =>
            deps.deviceResourceControllerFactory().setResources({
              device,
              resources: parsed.resources ?? {},
              restore: parsed.restore,
              deadlineMs,
              signal: operationSignal,
            }),
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
        },
      );
    },
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "reconcileDeviceResources",
    "Compare an iOS Simulator with a requested resource map (workload profile) and report typed drift: missingRequested, ownedExtra (overrides AutoMobile applied earlier), unsupported, commandFailure. Report-only by default; repair applies only the drifted delta, re-reads, and succeeds only when every requested resource is proven.",
    reconcileDeviceResourcesSchema,
    async (device, args: z.infer<typeof reconcileDeviceResourcesSchema>, _progress, signal) => {
      const callerSignal = signal ?? getAbortSignal();
      callerSignal?.throwIfAborted();
      const external: Record<string, unknown> = { ...args };
      const transportDeadline = external[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
      deleteInternalToolParams(external);
      const parsed = reconcileDeviceResourcesSchema.parse(external);
      const deps = dependencies();
      const deadlineMs = resolveResourceDeadline(deps, parsed.timeoutMs, transportDeadline);
      return withDeviceResourceLease(
        deps,
        device,
        deadlineMs,
        callerSignal,
        async (operationSignal) => {
          const result = await withDeviceReadiness(device, operationSignal, () =>
            deps.deviceResourceReconcilerFactory().reconcile({
              device,
              profile: { resources: parsed.resources },
              repair: parsed.repair ?? false,
              releaseOwnedExtras: parsed.releaseOwnedExtras ?? false,
              deadlineMs,
              signal: operationSignal,
            }),
          );
          return {
            ...createJSONToolResponse({ device, ...result }),
            ...(result.success ? {} : { isError: true }),
          };
        },
      );
    },
    { defaultEnabled: false },
  );
}

function resolveResourceDeadline(
  deps: Pick<DeviceToolsDependencies, "timer">,
  timeoutMs: number | undefined,
  transportDeadline: unknown,
): number {
  const requestedDeadline = deps.timer.now() + (timeoutMs ?? DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS);
  return typeof transportDeadline === "number" && Number.isFinite(transportDeadline)
    ? Math.min(requestedDeadline, transportDeadline - START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS)
    : requestedDeadline;
}

/** Resource writes join the device readiness transaction, like acquisition setup. */
function withDeviceReadiness<T>(
  device: BootedDevice,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return trackDeviceAcquisitionReadiness(
    deviceReadinessLockKey(device.platform, device.deviceId),
    async () => {
      signal.throwIfAborted();
      return operation();
    },
  );
}

/**
 * Resource operations hold the device's lifecycle lease, so they serialize per device
 * with boot, shutdown, teardown and other configuration.
 */
async function withDeviceResourceLease<T>(
  deps: Pick<DeviceToolsDependencies, "lifecycleCoordinator">,
  device: BootedDevice,
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
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
    return await operation(operationSignal);
  } finally {
    lease.release();
  }
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
