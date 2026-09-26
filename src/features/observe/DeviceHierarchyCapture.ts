import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { ViewHierarchy } from "./ViewHierarchy";
import { DefaultHierarchyCapture, type HierarchyCapture } from "./HierarchyCapture";
import { ViewHierarchyCaptureReader } from "./ViewHierarchyCaptureReader";
import {
  filterOffscreenNodes,
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "./HierarchyNormalization";
import type { SettleObserve } from "./interfaces/SettleObserve";

/** Dynamic platform bridge: normalizers own the raw response shape. */
export interface HierarchySyncClient {
  requestHierarchySync(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ hierarchy: unknown } | null>;
  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult;
}

export interface DeviceHierarchyCaptureDependencies {
  syncClientFactory?: (device: BootedDevice) => HierarchySyncClient;
  settle?: SettleObserve;
  timer?: Timer;
  ids?: IdGenerator;
}

/** One capture policy for action tools; a fresh request always bypasses client TTL caches. */
export function createDeviceHierarchyCapture(
  device: BootedDevice,
  dependencies: DeviceHierarchyCaptureDependencies = {},
): HierarchyCapture {
  const client = () =>
    dependencies.syncClientFactory?.(device) ??
    ((device.platform === "ios"
      ? IOSCtrlProxyClient.getInstance(device)
      : AndroidCtrlProxyClient.getInstance(device)) as HierarchySyncClient);
  const reader = new ViewHierarchyCaptureReader(
    {
      getViewHierarchy: (...args) =>
        new ViewHierarchy(device, undefined, null, dependencies.timer).getViewHierarchy(...args),
      filterOffscreenNodes,
    },
    async (request) => {
      const syncClient = client();
      const synced = await syncClient.requestHierarchySync(
        new NoOpPerformanceTracker(),
        false,
        request.signal,
        request.timeoutMs ?? 15000,
      );
      if (!synced) {
        throw new ActionableError("Unable to retrieve a fresh view hierarchy");
      }
      return device.platform === "ios"
        ? normalizeIosHierarchy(synced.hierarchy)
        : syncClient.convertToViewHierarchyResult(synced.hierarchy);
    },
    (hierarchy) => projectActionableHierarchy(device.platform, hierarchy),
    dependencies.settle,
  );
  return new DefaultHierarchyCapture(device.platform, reader, dependencies.timer, dependencies.ids);
}
