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
        const result = await trackDeviceAcquisitionReadiness(
          deviceReadinessLockKey(device.platform, device.deviceId),
          () => {
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
