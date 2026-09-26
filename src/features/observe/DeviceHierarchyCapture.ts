import type { ViewHierarchy as ViewHierarchyReader } from "./interfaces/ViewHierarchy";
import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import type { IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { supplementAndroidHierarchy } from "../action/AndroidHierarchyFallback";
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
  adbFactory?: AdbClientFactory;
  syncClientFactory?: (device: BootedDevice) => HierarchySyncClient;
  settle?: SettleObserve;
  viewHierarchy?: Pick<ViewHierarchyReader, "getViewHierarchy">;
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
        (
          dependencies.viewHierarchy ??
          new ViewHierarchy(device, dependencies.adbFactory, null, dependencies.timer)
        ).getViewHierarchy(...args),
      filterOffscreenNodes,
    },
    async (request) => {
      const timer = dependencies.timer ?? defaultTimer;
      const timeoutMs = request.timeoutMs ?? 15000;
      const deadline = timer.now() + timeoutMs;
      const syncClient = client();
      const synced = await syncClient.requestHierarchySync(
        new NoOpPerformanceTracker(),
        false,
        request.signal,
        timeoutMs,
      );
      if (!synced) {
        throw new ActionableError("Unable to retrieve a fresh view hierarchy");
      }
      if (device.platform === "ios") {
        return normalizeIosHierarchy(synced.hierarchy);
      }
      const hierarchy = syncClient.convertToViewHierarchyResult(synced.hierarchy);
      if (!hierarchy.ctrlProxyIncomplete || timer.now() >= deadline) {
        return hierarchy;
      }
      return supplementAndroidHierarchy(
        hierarchy,
        {
          adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
          timer,
          idGenerator: dependencies.ids,
        },
        deadline,
        request.signal,
      );
    },
    (hierarchy) => projectActionableHierarchy(device.platform, hierarchy),
    dependencies.settle,
  );
  return new DefaultHierarchyCapture(device.platform, reader, dependencies.timer, dependencies.ids);
}
