import { normalizeTvosHierarchy } from "../tvos/TvosHierarchy";
import { tvosRunners } from "../tvos/TvosRunnerRegistry";
import { normalizeWatchHierarchy } from "../watch/WatchHierarchy";
import { watchRunners } from "../watch/WatchRunnerRegistry";
import { holderOf } from "../../daemon/deviceBinding";
import type { ViewHierarchyRequestReader } from "./interfaces/ViewHierarchy";
import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
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
import { iosHierarchyAcquisition, type IosHierarchyAcquisition } from "./ios/types";
import { ViewHierarchy } from "./ViewHierarchy";
import {
  DefaultHierarchyCapture,
  recordAcquisitionTimestamp,
  type HierarchyCapture,
  type HierarchyCaptureRequest,
} from "./HierarchyCapture";
import { ViewHierarchyCaptureReader } from "./ViewHierarchyCaptureReader";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import {
  filterOffscreenNodes,
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "./HierarchyNormalization";
import type { SettleObserve } from "./interfaces/SettleObserve";
import type {
  HierarchySyncDiagnostics,
  HierarchySyncRequestOptions,
  ObserverHierarchyRequestOptions,
} from "./android/types";
import {
  existingHierarchyClient,
  getObservationReadServiceStart,
  type ObservationReadServiceStart,
} from "./ObservationReadServiceStart";
import { errorMessage } from "../../utils/describeUnknownError";
import { fixedBackoff } from "../../utils/Backoff";
import { logger } from "../../utils/logger";

export const DEFAULT_HIERARCHY_READ_TIMEOUT_MS = 15000;
const incompleteHierarchyBackoff = fixedBackoff(100);

type SyncedHierarchy = {
  hierarchy: unknown;
  frameContext?: ViewHierarchyResult["frameContext"];
} & IosHierarchyAcquisition;

/** Dynamic platform bridge: normalizers own the raw response shape. */
export interface HierarchySyncClient {
  requestHierarchySync(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    options: HierarchySyncRequestOptions & { timeoutMs: number },
  ): Promise<SyncedHierarchy | null>;
  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult;
  connectForObservationRead?(): Promise<boolean>;
  close?(): Promise<void>;
  requestHierarchySyncForObserver?(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    options: { timeoutMs: number; display?: number | ObserverHierarchyRequestOptions },
  ): Promise<SyncedHierarchy | null>;
}

export interface DeviceHierarchyCaptureDependencies {
  adbFactory?: AdbClientFactory;
  syncClientFactory?: (device: BootedDevice) => HierarchySyncClient;
  /** Where Android clients come from when no `syncClientFactory` is injected. */
  androidClients?: AndroidHierarchyClients;
  settle?: SettleObserve;
  viewHierarchy?: ViewHierarchyRequestReader;
  timer?: Timer;
  ids?: IdGenerator;
  observationServiceStart?: Pick<ObservationReadServiceStart, "start">;
  observationClientResolver?: (device: BootedDevice) => {
    syncClient: HierarchySyncClient;
    transient: boolean;
    owned: boolean;
  };
}

function normalizeSyncedIosHierarchy(
  client: HierarchySyncClient,
  synced: SyncedHierarchy,
  timer: Timer,
): ViewHierarchyResult {
  const acquisition = synced[iosHierarchyAcquisition];
  return {
    ...normalizeIosHierarchy(client.convertToViewHierarchyResult(synced.hierarchy)),
    ...(acquisition === "device" || acquisition === "client-cache"
      ? { [iosHierarchyAcquisition]: acquisition }
      : {}),
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
  const args = [new NoOpPerformanceTracker(), request.searchRaw === true, request.signal] as const;
  const { timeoutMs } = options;
  let synced: Awaited<ReturnType<HierarchySyncClient["requestHierarchySync"]>>;
  if (request.observerMode) {
    if (!client.requestHierarchySyncForObserver) {
      throw new ActionableError("Observer hierarchy read is unavailable for this client");
    }
    synced = await client.requestHierarchySyncForObserver(...args, {
      timeoutMs,
      display: request.preserveDisplayState
        ? { displayId: request.displayId, preserveDisplayState: true }
        : request.displayId,
    });
  } else {
    synced = await client.requestHierarchySync(...args, {
      timeoutMs,
      diagnostics,
      displayId: request.displayId,
    });
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

/** The Android client lookups a capture uses; `AndroidCtrlProxyClient`'s statics satisfy it. */
export interface AndroidHierarchyClients {
  getInstance(device: BootedDevice, adbFactory?: AdbClientFactory): HierarchySyncClient;
  createForObservationRead(
    device: BootedDevice,
    adbFactory?: AdbClientFactory,
    existing?: AndroidCtrlProxyClient,
  ): HierarchySyncClient;
}

function newHierarchyClient(
  device: BootedDevice,
  dependencies: DeviceHierarchyCaptureDependencies,
  transient = false,
  existing?: AndroidCtrlProxyClient | IOSCtrlProxyClient | null,
): HierarchySyncClient {
  const { adbFactory } = dependencies;
  const clients = dependencies.androidClients ?? AndroidCtrlProxyClient;
  if (device.platform === "ios") {
    return transient
      ? IOSCtrlProxyClient.createForObservationRead(device)
      : IOSCtrlProxyClient.getInstance(device);
  }
  return transient
    ? clients.createForObservationRead(
        device,
        adbFactory,
        existing instanceof AndroidCtrlProxyClient ? existing : undefined,
      )
    : clients.getInstance(device, adbFactory);
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
      syncClient: existing ?? newHierarchyClient(device, dependencies),
      transient: false,
      owned: false,
    };
  }
  const pool = defaultDaemonContext.devicePool();
  const owned = pool ? !!holderOf(pool.getDevice(device.deviceId)) : false;
  if (owned && !existing?.isConnected()) {
    throw new ActionableError(
      `Device ${device.deviceId} is session-owned and has no connected hierarchy service: the owning session's hierarchy client is disconnected. Run a session observe as the owner to reconnect it; a deviceId read only connects to an already-running service.`,
    );
  }
  if (existing?.isConnected()) {
    return { syncClient: existing, transient: false, owned };
  }
  return {
    syncClient: newHierarchyClient(device, dependencies, true, existing),
    transient: true,
    owned: false,
  };
}

interface HierarchyConnection {
  syncClient: HierarchySyncClient;
  transient: boolean;
  owned: boolean;
}

function resolveCaptureClient(options: {
  device: BootedDevice;
  dependencies: DeviceHierarchyCaptureDependencies;
  observerMode: boolean;
}): HierarchyConnection {
  const { device, dependencies, observerMode } = options;
  if (observerMode && dependencies.observationClientResolver) {
    return dependencies.observationClientResolver(device);
  }
  return resolveHierarchyClient(device, dependencies, observerMode);
}

interface ObserverConnectionOptions {
  device: BootedDevice;
  dependencies: DeviceHierarchyCaptureDependencies;
  connection: HierarchyConnection;
  request: HierarchyCaptureRequest;
  timer: Timer;
  deadline: number;
}

async function dialObservationReader(options: ObserverConnectionOptions): Promise<boolean> {
  const { connection, request, timer, deadline, device } = options;
  return await raceWithDeadline(
    () => connection.syncClient.connectForObservationRead?.() ?? Promise.resolve(false),
    {
      timer,
      timeoutMs: Math.max(0, deadline - timer.now()),
      signal: request.signal,
      label: `Observer hierarchy connection for ${device.deviceId}`,
    },
  );
}

/** Returns true only for readers that joined successful start-on-read setup. */
async function connectObserverHierarchy(options: ObserverConnectionOptions): Promise<boolean> {
  const { connection, request, timer, deadline, device, dependencies } = options;
  if (!connection.transient || (await dialObservationReader(options))) {
    return false;
  }
  // Release the failed reader's forwarding lease before resident setup.
  await connection.syncClient.close?.();
  connection.transient = false;
  let serviceStarted: boolean;
  try {
    serviceStarted = await (
      dependencies.observationServiceStart ?? getObservationReadServiceStart(timer)
    ).start({
      device,
      deadlineMs: deadline,
      signal: request.signal,
    });
  } catch (error) {
    request.signal?.throwIfAborted();
    throw new ActionableError(
      `Device ${device.deviceId} has no reachable hierarchy service; read tried to start the service: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  Object.assign(connection, resolveCaptureClient({ device, dependencies, observerMode: true }));
  if (connection.transient && !(await dialObservationReader(options))) {
    throw new ActionableError(
      `Device ${device.deviceId} has no reachable hierarchy service; read started the service but could not connect`,
    );
  }
  return serviceStarted;
}

function normalizeSyncedAndroidHierarchy(
  syncClient: HierarchySyncClient,
  synced: SyncedHierarchy,
  timer: Timer,
): ViewHierarchyResult {
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
  return hierarchy;
}

async function normalizeSyncedHierarchy(options: {
  device: BootedDevice;
  dependencies: DeviceHierarchyCaptureDependencies;
  syncClient: HierarchySyncClient;
  synced: SyncedHierarchy;
  deadline: number;
  request: HierarchyCaptureRequest;
  timer: Timer;
  owned: boolean;
}): Promise<ViewHierarchyResult> {
  const { device, dependencies, syncClient, deadline, request, timer, owned } = options;
  let synced = options.synced;
  if (device.platform === "ios") {
    return normalizeSyncedIosHierarchy(syncClient, synced, timer);
  }
  let hierarchy = normalizeSyncedAndroidHierarchy(syncClient, synced, timer);
  // UIAutomator supplementation writes a dump and can interfere with an owner action.
  if (request.observerMode || !hierarchy.ctrlProxyIncomplete || timer.now() >= deadline) {
    return hierarchy;
  }
  // A window transition can briefly withhold roots. Give the answering service one
  // fresh read before a dump displaces it; persistent incompleteness still needs XML.
  const delay = incompleteHierarchyBackoff.delayForAttempt(1);
  if (deadline - timer.now() > delay) {
    try {
      synced = await raceWithDeadline(
        async () => {
          await timer.sleep(delay);
          request.signal?.throwIfAborted();
          const remaining = deadline - timer.now();
          if (remaining <= 0) {
            throw new ActionableError(
              `Device ${device.deviceId} hierarchy retry deadline exhausted`,
            );
          }
          return requestSyncHierarchy(syncClient, request, {
            timeoutMs: remaining,
            deviceId: device.deviceId,
            owned,
          });
        },
        {
          timer,
          timeoutMs: deadline - timer.now(),
          signal: request.signal,
          label: `Device ${device.deviceId} incomplete hierarchy retry`,
        },
      );
      hierarchy = normalizeSyncedAndroidHierarchy(syncClient, synced, timer);
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn("[HierarchyCapture] Incomplete CtrlProxy hierarchy retry failed", error);
    }
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
    request.signal,
  );
  recordAcquisitionTimestamp(supplemented, hierarchy.updatedAt);
  return supplemented;
}

/** One capture policy for action tools; a fresh request always bypasses client TTL caches. */
export function createDeviceHierarchyCapture(
  device: BootedDevice,
  dependencies: DeviceHierarchyCaptureDependencies = {},
): HierarchyCapture {
  if (device.platform === "watchos" || device.platform === "tvos") {
    const read = async (request: HierarchyCaptureRequest) =>
      device.platform === "tvos"
        ? normalizeTvosHierarchy(
            await tvosRunners.require(device.deviceId).hierarchy(request.signal),
          )
        : normalizeWatchHierarchy(
            await watchRunners.require(device.deviceId).hierarchy(request.signal),
          );
    // Watch wire trees use the iOS bounds/attribute projection, without routing iOS commands.
    return new DefaultHierarchyCapture(
      "ios",
      {
        readCached: read,
        readFresh: read,
        projectVisible: (hierarchy) => hierarchy,
      },
      dependencies.timer,
      dependencies.ids,
    );
  }
  const platform = requireAndroidOrIosPlatform(device.platform, "Observing the view hierarchy");
  const reader = new ViewHierarchyCaptureReader(
    {
      getViewHierarchy: (queryOptions, request) => {
        const hierarchy: ViewHierarchyRequestReader =
          dependencies.viewHierarchy ??
          new ViewHierarchy(device, dependencies.adbFactory, null, { timer: dependencies.timer });
        return hierarchy.getViewHierarchy(queryOptions, request);
      },
      filterOffscreenNodes,
    },
    async (request) => {
      const timer = dependencies.timer ?? defaultTimer;
      const timeoutMs = request.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS;
      const deadline = timer.now() + timeoutMs;
      request.signal?.throwIfAborted();
      const connection = resolveCaptureClient({
        device,
        dependencies,
        observerMode: request.observerMode === true,
      });
      try {
        const serviceStarted = await connectObserverHierarchy({
          device,
          dependencies,
          connection,
          request,
          timer,
          deadline,
        });
        const { syncClient, owned } = connection;
        const remaining = deadline - timer.now();
        if (remaining <= 0) {
          throw new ActionableError(`Device ${device.deviceId} hierarchy read timed out`);
        }
        const read = () =>
          requestSyncHierarchy(syncClient, request, {
            timeoutMs: remaining,
            deviceId: device.deviceId,
            owned,
          });
        const synced = request.observerMode
          ? await raceWithDeadline(read, {
              timer,
              timeoutMs: remaining,
              signal: request.signal,
              label: `Device ${device.deviceId} hierarchy read`,
            })
          : await read();
        const hierarchy = await normalizeSyncedHierarchy({
          device,
          dependencies,
          syncClient,
          synced,
          deadline,
          timer,
          request,
          owned,
        });
        // Action captures may carry native timestamp provenance in a WeakMap.
        // Only observer captures need call-scoped start metadata.
        if (!request.observerMode) {
          return hierarchy;
        }
        const result = { ...hierarchy };
        delete result.hierarchyServiceStarted;
        if (serviceStarted) {
          result.hierarchyServiceStarted = true;
        }
        return result;
      } finally {
        if (connection.transient) {
          await connection.syncClient.close?.();
        }
      }
    },
    (hierarchy) =>
      projectActionableHierarchy(
        platform,
        hierarchy,
        platform === "ios" && (device.displays?.panels.length ?? 0) > 1,
      ),
    dependencies.settle,
  );
  return new DefaultHierarchyCapture(platform, reader, dependencies.timer, dependencies.ids);
}
