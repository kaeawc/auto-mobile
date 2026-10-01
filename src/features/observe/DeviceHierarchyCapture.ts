import type { ViewHierarchy as ViewHierarchyReader } from "./interfaces/ViewHierarchy";
import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import type { IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { supplementAndroidHierarchy } from "../action/AndroidHierarchyFallback";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { ViewHierarchy } from "./ViewHierarchy";
import {
  DefaultHierarchyCapture,
  recordAcquisitionTimestamp,
  type HierarchyCapture,
  type HierarchyCaptureRequest,
} from "./HierarchyCapture";
import { ViewHierarchyCaptureReader } from "./ViewHierarchyCaptureReader";
import { DaemonState } from "../../daemon/daemonState";
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
    diagnostics?: unknown,
    displayId?: number,
  ): Promise<{ hierarchy: unknown; frameContext?: ViewHierarchyResult["frameContext"] } | null>;
  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult;
  connectForObservationRead?(): Promise<boolean>;
  close?(): Promise<void>;
  requestHierarchySyncForObserver?(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    displayId?: number,
  ): Promise<{ hierarchy: unknown; frameContext?: ViewHierarchyResult["frameContext"] } | null>;
}

export interface DeviceHierarchyCaptureDependencies {
  adbFactory?: AdbClientFactory;
  syncClientFactory?: (device: BootedDevice) => HierarchySyncClient;
  settle?: SettleObserve;
  viewHierarchy?: Pick<ViewHierarchyReader, "getViewHierarchy">;
  timer?: Timer;
  ids?: IdGenerator;
}

function normalizeSyncedIosHierarchy(
  client: HierarchySyncClient,
  synced: { hierarchy: unknown; frameContext?: ViewHierarchyResult["frameContext"] },
  timer: Timer,
): ViewHierarchyResult {
  return {
    ...normalizeIosHierarchy(client.convertToViewHierarchyResult(synced.hierarchy)),
    receivedAt: timer.now(),
    fresh: true,
    ...(synced.frameContext !== undefined ? { frameContext: synced.frameContext } : {}),
  };
}

function requestSyncHierarchy(
  client: HierarchySyncClient,
  request: HierarchyCaptureRequest,
  timeoutMs: number,
): ReturnType<HierarchySyncClient["requestHierarchySync"]> {
  const args = [
    new NoOpPerformanceTracker(),
    request.searchRaw === true,
    request.signal,
    timeoutMs,
  ] as const;
  if (request.observerMode) {
    if (!client.requestHierarchySyncForObserver) {
      throw new ActionableError("Observer hierarchy read is unavailable for this client");
    }
    return client.requestHierarchySyncForObserver(...args, request.displayId);
  }
  return request.displayId === undefined
    ? client.requestHierarchySync(...args)
    : client.requestHierarchySync(...args, undefined, request.displayId);
}

function existingHierarchyClient(
  device: BootedDevice,
): AndroidCtrlProxyClient | IOSCtrlProxyClient | null {
  return device.platform === "ios"
    ? IOSCtrlProxyClient.getExistingInstance(device.deviceId)
    : AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
}

function newHierarchyClient(
  device: BootedDevice,
  adbFactory?: AdbClientFactory,
  transient = false,
): HierarchySyncClient {
  if (device.platform === "ios") {
    return transient
      ? IOSCtrlProxyClient.createForObservationRead(device)
      : IOSCtrlProxyClient.getInstance(device);
  }
  return transient
    ? AndroidCtrlProxyClient.createForObservationRead(device, adbFactory)
    : AndroidCtrlProxyClient.getInstance(device, adbFactory);
}

function resolveHierarchyClient(
  device: BootedDevice,
  dependencies: DeviceHierarchyCaptureDependencies,
  observerMode: boolean,
): { syncClient: HierarchySyncClient; transient: boolean; owned: boolean } {
  if (dependencies.syncClientFactory) {
    return { syncClient: dependencies.syncClientFactory(device), transient: false, owned: false };
  }
  const existing = existingHierarchyClient(device);
  const daemon = DaemonState.getInstance();
  const owned =
    observerMode && daemon.isInitialized()
      ? !!daemon.getDevicePool().getDevice(device.deviceId)?.sessionId
      : false;
  if (observerMode && owned && !existing?.isConnected()) {
    throw new ActionableError(
      `Device ${device.deviceId} is session-owned and has no connected hierarchy service`,
    );
  }
  const transient = observerMode && !existing;
  return {
    syncClient: existing ?? newHierarchyClient(device, dependencies.adbFactory, transient),
    transient,
    owned,
  };
}

async function normalizeSyncedHierarchy(options: {
  device: BootedDevice;
  dependencies: DeviceHierarchyCaptureDependencies;
  syncClient: HierarchySyncClient;
  synced: { hierarchy: unknown; frameContext?: ViewHierarchyResult["frameContext"] };
  deadline: number;
  signal?: AbortSignal;
  timer: Timer;
}): Promise<ViewHierarchyResult> {
  const { device, dependencies, syncClient, synced, deadline, signal, timer } = options;
  if (device.platform === "ios") {
    return normalizeSyncedIosHierarchy(syncClient, synced, timer);
  }
  const hierarchy = syncClient.convertToViewHierarchyResult(synced.hierarchy);
  const updatedAt = (synced.hierarchy as { updatedAt?: number } | null)?.updatedAt;
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    hierarchy.updatedAt = updatedAt;
  }
  hierarchy.receivedAt = timer.now();
  hierarchy.fresh = true;
  if (synced.frameContext !== undefined) {
    hierarchy.frameContext = synced.frameContext;
  }
  if (!hierarchy.ctrlProxyIncomplete || timer.now() >= deadline) {
    return hierarchy;
  }
  const supplemented = await supplementAndroidHierarchy(
    hierarchy,
    {
      adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      timer,
      idGenerator: dependencies.ids,
    },
    deadline,
    signal,
  );
  recordAcquisitionTimestamp(supplemented, updatedAt);
  return supplemented;
}

/** One capture policy for action tools; a fresh request always bypasses client TTL caches. */
export function createDeviceHierarchyCapture(
  device: BootedDevice,
  dependencies: DeviceHierarchyCaptureDependencies = {},
): HierarchyCapture {
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
      const { syncClient, transient, owned } = resolveHierarchyClient(
        device,
        dependencies,
        request.observerMode === true,
      );
      try {
        if (transient) {
          const connected =
            syncClient.connectForObservationRead &&
            (await raceWithDeadline(syncClient.connectForObservationRead(), {
              timer,
              timeoutMs,
              signal: request.signal,
              label: `Observer hierarchy connection for ${device.deviceId}`,
            }));
          if (!connected) {
            throw new ActionableError(
              `Device ${device.deviceId} has no reachable hierarchy service`,
            );
          }
        }
        const remaining = deadline - timer.now();
        if (remaining <= 0) {
          throw new ActionableError(`Device ${device.deviceId} hierarchy read timed out`);
        }
        const synced = await requestSyncHierarchy(syncClient, request, remaining);
        if (!synced) {
          throw new ActionableError(
            owned
              ? `Device ${device.deviceId} hierarchy service did not answer`
              : `Device ${device.deviceId} has no reachable hierarchy service`,
          );
        }
        return normalizeSyncedHierarchy({
          device,
          dependencies,
          syncClient,
          synced,
          deadline,
          signal: request.signal,
          timer,
        });
      } finally {
        if (transient) {
          await syncClient.close?.();
        }
      }
    },
    (hierarchy) =>
      projectActionableHierarchy(
        device.platform,
        hierarchy,
        device.platform === "ios" && (device.displays?.panels.length ?? 0) > 1,
      ),
    dependencies.settle,
  );
  return new DefaultHierarchyCapture(device.platform, reader, dependencies.timer, dependencies.ids);
}
