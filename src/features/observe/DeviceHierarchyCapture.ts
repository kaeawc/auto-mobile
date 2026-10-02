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
import type { HierarchySyncDiagnostics, ObserverHierarchyRequestOptions } from "./android/types";

/** Dynamic platform bridge: normalizers own the raw response shape. */
export interface HierarchySyncClient {
  requestHierarchySync(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    diagnostics?: HierarchySyncDiagnostics,
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
    display?: number | ObserverHierarchyRequestOptions,
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

async function requestSyncHierarchy(
  client: HierarchySyncClient,
  request: HierarchyCaptureRequest,
  options: { timeoutMs: number; deviceId: string; owned: boolean },
): Promise<NonNullable<Awaited<ReturnType<HierarchySyncClient["requestHierarchySync"]>>>> {
  const diagnostics: HierarchySyncDiagnostics = {};
  const args = [
    new NoOpPerformanceTracker(),
    request.searchRaw === true,
    request.signal,
    options.timeoutMs,
  ] as const;
  let synced: Awaited<ReturnType<HierarchySyncClient["requestHierarchySync"]>>;
  if (request.observerMode) {
    if (!client.requestHierarchySyncForObserver) {
      throw new ActionableError("Observer hierarchy read is unavailable for this client");
    }
    synced = await client.requestHierarchySyncForObserver(
      ...args,
      request.preserveDisplayState
        ? { displayId: request.displayId, preserveDisplayState: true }
        : request.displayId,
    );
  } else {
    synced = await client.requestHierarchySync(...args, diagnostics, request.displayId);
  }
  if (!synced) {
    const detail =
      diagnostics.failureReason ??
      (diagnostics.runnerError ? `runner error: ${diagnostics.runnerError}` : undefined);
    const message =
      !request.observerMode || options.owned
        ? `Device ${options.deviceId} hierarchy service did not answer`
        : `Device ${options.deviceId} has no reachable hierarchy service`;
    throw new ActionableError(detail ? `${message}: ${detail}` : message);
  }
  return synced;
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
  existing?: AndroidCtrlProxyClient | IOSCtrlProxyClient | null,
): HierarchySyncClient {
  if (device.platform === "ios") {
    return transient
      ? IOSCtrlProxyClient.createForObservationRead(device)
      : IOSCtrlProxyClient.getInstance(device);
  }
  return transient
    ? AndroidCtrlProxyClient.createForObservationRead(
        device,
        adbFactory,
        existing instanceof AndroidCtrlProxyClient ? existing : undefined,
      )
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
  if (!observerMode) {
    return {
      syncClient: existing ?? newHierarchyClient(device, dependencies.adbFactory),
      transient: false,
      owned: false,
    };
  }
  const daemon = DaemonState.getInstance();
  const owned = daemon.isInitialized()
    ? !!daemon.getDevicePool().getDevice(device.deviceId)?.sessionId
    : false;
  if (owned && !existing?.isConnected()) {
    throw new ActionableError(
      `Device ${device.deviceId} is session-owned and has no connected hierarchy service: the owning session's hierarchy client is disconnected. Run a session observe as the owner to reconnect it; a deviceId read only connects to an already-running service.`,
    );
  }
  if (existing?.isConnected()) {
    return { syncClient: existing, transient: false, owned };
  }
  return {
    syncClient: newHierarchyClient(device, dependencies.adbFactory, true, existing),
    transient: true,
    owned: false,
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
  observerMode?: boolean;
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
  // UIAutomator supplementation writes a dump and can interfere with an owner action.
  if (options.observerMode || !hierarchy.ctrlProxyIncomplete || timer.now() >= deadline) {
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
        const synced = await requestSyncHierarchy(syncClient, request, {
          timeoutMs: remaining,
          deviceId: device.deviceId,
          owned,
        });
        return normalizeSyncedHierarchy({
          device,
          dependencies,
          syncClient,
          synced,
          deadline,
          signal: request.signal,
          timer,
          observerMode: request.observerMode,
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
