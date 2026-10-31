import { AdbAndroidFoldPostureRestore } from "./androidFoldPostureRestore";
import {
  InMemoryMutationRecordingGaps,
  type MutationRecordingGaps,
} from "./mutations/recordingGaps";
import { ENV } from "../../config/env";
import { readEnvInt } from "../../utils/envNumbers";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import {
  readAndroidSessionDeviceCatalog,
  readIosSessionDeviceCatalog,
  readWatchSessionDeviceCatalog,
} from "../../devices/sessionCatalog";
import { WatchSimulatorInventory } from "../../utils/ios-cmdline-tools/WatchSimulatorInventory";
import type { SessionCatalogPlatform } from "./brokerOptions";
import { nativeWatchReset } from "./watchResetNative";
import type { SessionDeviceCatalog } from "../../devices/sessionRequirements";
import {
  listDevices,
  listInstalledSystemImages,
} from "../../utils/android-cmdline-tools/avdmanager";
import { bootAdmissionServices } from "../../devices/bootAdmissionServices";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { tryAcquireExclusiveLock, releaseExclusiveLock } from "../../utils/fileLock";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultLockOwnerGenerationProbe } from "../lockOwnerGeneration";
import type { BrokerDeviceAcquisition } from "./provisioning/deviceAcquisition";
import { defaultBindingToolInvoker } from "./provisioning/daemonDeviceAcquisition";
import { readToolPayload } from "./provisioning/reconcilerPorts";
import type { BrokerExecutionRelease } from "./provisioning/executionRelease";
import type { BindingJournal } from "./registry/bindingJournal";
import {
  defaultBindingRegistryPath,
  type SqliteBindingRegistry,
} from "./registry/sqliteBindingRegistry";
import {
  computeBindingScopeKey,
  type BindingAssignmentRecord,
  type BindingProcessIdentity,
} from "./registry/bindingRegistry";
import { RECEIPT_PRUNE_BATCH, SessionBroker, type SessionBrokerOptions } from "./broker";
import { ManagedDevicePort } from "./managedDevicePort";
import { SESSION_BROKER_SCOPE, iosReusePolicy, type SessionBrokerHostConfig } from "./hostConfig";
import { IosBaselineReset } from "./iosBaselineReset";
import { IosKeepBootedReset } from "./iosKeepBootedReset";
import { IosMinimalReset } from "./iosMinimalReset";
import { nativeIosMutationResetPort, nativeIosResetHealth } from "./iosResetNativePorts";
import { captureFirstDeviceBaseline } from "./mutations/reset";
import type { ManagedDevicePortDependencies } from "./managedDevicePort";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import type { BrokerResourceRecord } from "./store";
import { SESSION_BROKER_RECOVERY_INTERVAL_MS } from "./timing";
import {
  AndroidBaselineReset,
  DEFAULT_ANDROID_RESET_TIMEOUT_MS,
  watchAndroidResetSession,
  type AndroidBaselineResetDependencies,
  type AndroidResetStrategy,
} from "./androidBaselineReset";
import {
  AndroidKeepBootedReset,
  type AndroidKeepBootedResetDependencies,
} from "./androidKeepBootedReset";
import { AndroidDeviceMutationResetPort } from "./androidDeviceMutationResetPort";
import type { DeviceMutationJournal } from "./mutations/types";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { FileAvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { executionTracker } from "../executionTracker";
import type { Session } from "../sessionManager/sessionTypes";
import { HeartbeatTaskLeaseKeepalive } from "../tasks/taskLeaseKeepalive";
import {
  brokerSessionMutationScope,
  SessionMutationRecorder,
  type MutationRecorder,
} from "./mutations/recorder";
import type { DeviceMutationScope } from "./mutations/types";
import { nativeProfile } from "./profile";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import { getAndroidHomeWithSystemImages } from "../../utils/android-cmdline-tools/detection";
import { defaultEmulatorConsoleBusyRegistry } from "../../utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import { reserveBootCapacity } from "../../features/bootAdmission/sharedBootAdmissionGates";
import { invalidateDisplayCaches } from "../../features/observe/DisplayTransition";
import { AndroidSnapshotReset } from "./androidSnapshotReset";
import {
  NativeAndroidSnapshotResetPort,
  type AndroidSnapshotReadiness,
} from "./androidSnapshotResetNativePort";
import { deviceSnapshotIncarnationInvalidator } from "../deviceSnapshotIncarnationInvalidator";
import { defaultDeviceClockRestoreRegistry } from "../../features/utility/DeviceClock";
import { getHostEmulatorProcessStopper } from "../../devices/hostEmulatorProcessStopper";
import { AVD_DEFAULT_BOOT_SNAPSHOT } from "../../utils/android-cmdline-tools/AvdSnapshotService";
import { AVD_SNAPSHOTS_DIRNAME } from "../../utils/android-cmdline-tools/AvdConfigReader";

export interface SessionBrokerHostLock {
  acquire(): void;
  release(): void;
}

/** Existing PID/generation lock primitive, held for the lifetime of the broker service. */
export function sessionBrokerHostLock(
  owner: BindingProcessIdentity,
  path = `${defaultBindingRegistryPath()}.session-broker.lock`,
): SessionBrokerHostLock {
  return {
    acquire: () => {
      if (
        !tryAcquireExclusiveLock(path, {
          pid: owner.pid,
          ownerToken: owner.daemonId,
          ownerGeneration: defaultLockOwnerGenerationProbe,
        })
      ) {
        throw new ActionableError(
          "Another provider owns session-broker execution on this host; stop it before starting a replacement",
        );
      }
    },
    release: () => releaseExclusiveLock(path, owner.pid, owner.daemonId),
  };
}

export interface OpenSessionBrokerServiceOptions {
  recordingGaps?: MutationRecordingGaps;
  mutationSessions?: {
    peekSession(
      sessionUuid: string,
    ): Pick<
      Session,
      "sessionId" | "assignedDevice" | "stableDeviceId" | "mutationRecorder" | "heartbeatTimeoutMs"
    > | null;
    recordHeartbeat(sessionId: string): void;
  };
  /** Daemon startup starts the loop explicitly after binding its control socket. */
  deferStart?: boolean;
  config: SessionBrokerHostConfig;
  registry: SqliteBindingRegistry;
  acquisition: Pick<BrokerDeviceAcquisition, "acquire">;
  release: Pick<BrokerExecutionRelease, "releaseExecution">;
  journal: Pick<BindingJournal, "owner" | "redriveBinding">;
  owner: BindingProcessIdentity;
  timer: Timer;
  sessionDisposition: NonNullable<SessionBrokerOptions["sessionDisposition"]>;
  /** Already rehydrated base sessions; generic work must be drained before opting in. */
  liveSessionIds?: () => readonly string[];
  /** Tests supply a fake host lock; production shares the registry's physical namespace. */
  hostLock?: SessionBrokerHostLock;
  catalog?: (
    platform: SessionCatalogPlatform,
    signal?: AbortSignal,
  ) => Promise<SessionDeviceCatalog>;
  androidReset?: {
    inventory(options: {
      signal?: AbortSignal;
      timeoutMs: number;
      targetDeviceId: string;
    }): Promise<BootedDevice[]>;
    ctrlProxyReady: AndroidBaselineResetDependencies["ctrlProxyReady"];
    snapshot?: AndroidSnapshotReadiness;
  };
}

function nativeCatalogReader(config: SessionBrokerHostConfig) {
  const ios = new SimCtlClient(null);
  // Apple Watch simulators exist only where simctl does; elsewhere the catalog is not installed.
  const watches = process.platform === "darwin" ? new WatchSimulatorInventory(ios) : undefined;
  return (
    platform: SessionCatalogPlatform,
    signal?: AbortSignal,
  ): Promise<SessionDeviceCatalog> => {
    if (platform === "watchos") {
      return readWatchSessionDeviceCatalog(watches, { signal });
    }
    if (platform === "ios") {
      return readIosSessionDeviceCatalog(ios, {
        signal,
        classifications: config.iosClassifications,
      });
    }
    return readAndroidSessionDeviceCatalog(
      {
        listDevices: (signal) => listDevices(undefined, signal),
        listInstalledSystemImages: (filter, signal) =>
          listInstalledSystemImages(filter, undefined, signal),
      },
      { profileArchetypes: config.androidProfileArchetypes },
      { signal },
    );
  };
}

/** Share one gap tracker between service recovery and both platform resets. */
function serviceDependencies(options: OpenSessionBrokerServiceOptions) {
  return {
    recordingGaps: options.recordingGaps ?? new InMemoryMutationRecordingGaps(),
    lock: options.hostLock ?? sessionBrokerHostLock(options.owner),
  };
}

/**
 * Opens one exclusive host service using the existing native assignment/journal authority.
 * Legacy binding/free-pool inventory must be drained before opting in; it cannot disappear from cap
 * accounting merely because it was created by another allocation path.
 */
export async function openSessionBrokerService(
  options: OpenSessionBrokerServiceOptions,
): Promise<SessionBrokerService> {
  const { recordingGaps, lock } = serviceDependencies(options);
  lock.acquire();
  let broker: SessionBroker | undefined;
  try {
    const scopeKey = computeBindingScopeKey(SESSION_BROKER_SCOPE);
    await assertBrokerInventoryOwned(options.registry, scopeKey);
    await assertBrokerSessionsOwned(options, scopeKey);
    const scope = await options.registry.ensureScope(SESSION_BROKER_SCOPE);
    if (scope.kind !== "ready") {
      throw new ActionableError(
        `Session broker's private ownership scope is unavailable: ${scope.kind}`,
      );
    }
    const store = options.registry.sessionBrokerStore(scopeKey);
    const reuse = iosReusePolicy(options.config);
    const journal = options.registry.deviceMutationJournal();
    const reset = nativeBaselineReset(options.config, options.androidReset, options.timer, {
      journal,
      recordingGaps,
    });
    const iosReset = reset?.ios;
    let resetIosBaseline: NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["ios"] =
      iosReset
        ? (device, profile, assertOwned, { signal, context } = {}) => {
            const operation = () => iosReset.resetWithTiming(device, profile, assertOwned, signal);
            return context?.runResetBoot ? context.runResetBoot(operation) : operation();
          }
        : undefined;
    let captureIosBaseline: ManagedDevicePortDependencies["captureIosBaseline"];
    if (iosReset) {
      ({ resetIosBaseline, captureIosBaseline } = iosReuseWiring(
        options,
        reuse,
        { erase: iosReset, journal, recordingGaps, store },
        resetIosBaseline,
      ));
    }
    const bindMutationRecorder = options.mutationSessions
      ? (scope: DeviceMutationScope) => {
          const session = options.mutationSessions!.peekSession(scope.sessionUuid);
          if (
            !session ||
            session.sessionId !== scope.sessionUuid ||
            session.assignedDevice !== scope.deviceId
          ) {
            throw new ActionableError(
              "Broker mutation scope must match the live native session and device",
            );
          }
          session.mutationRecorder = new SessionMutationRecorder(journal, scope);
        }
      : undefined;
    const devices = new ManagedDevicePort({
      scope: SESSION_BROKER_SCOPE,
      timer: options.timer,
      leaseKeepalive: preparationLeaseKeepalive(options),
      brokerDeviceAcquisition: options.acquisition,
      brokerExecutionRelease: options.release,
      registry: options.registry,
      bindingJournal: options.journal,
      bindMutationRecorder,
      ...(reset
        ? {
            resetBaseline: {
              ios: resetIosBaseline,
              android: reset.android,
              watch: reset.watch,
            },
            captureIosBaseline,
            isCurrentReset: (resource: BrokerResourceRecord) => isCurrentReset(store, resource),
          }
        : {}),
    });
    broker = new SessionBroker({
      store,
      devices,
      timer: options.timer,
      owner: options.owner,
      limits: options.config.limits,
      catalog: options.catalog ?? nativeCatalogReader(options.config),
      defaults: (platform) => {
        const defaults = options.config.defaults[platform];
        if (!defaults) {
          throw new ActionableError(
            `Session-broker execution is not configured for ${platform} on this host`,
          );
        }
        return defaults;
      },
      capabilities: options.config.capabilities,
      sessionDisposition: options.sessionDisposition,
      reuseCleanDevices: reuse.mode !== "off",
      reuseAndroidCleanDevices: options.config.reuseAndroidCleanDevices,
      idleTtlMs: { android: options.config.androidIdleTtlMs },
    });
    await broker.recoverReceipts();
    const recoverMutationRecorder = (sessionUuid: string) =>
      recoverSessionMutationRecorder(options, store, scopeKey, {
        bindMutationRecorder,
        sessionUuid,
      });
    await recoverActiveMutationRecorders(store, recoverMutationRecorder, recordingGaps);
    const service = new SessionBrokerService(broker, scopeKey, lock, {
      timer: options.timer,
      mutations: {
        recordingGaps,
        recorderFor: recoverMutationRecorder,
      },
    });
    if (!options.deferStart) {
      service.start();
    }
    return service;
  } catch (error) {
    await closeFailedStartupBroker(broker, lock);
    throw toActionableError(error, "Session broker startup failed");
  }
}

async function closeFailedStartupBroker(
  broker: SessionBroker | undefined,
  lock: SessionBrokerHostLock,
): Promise<void> {
  try {
    await broker?.close();
  } catch (error) {
    logger.warn("Failed to close broker after startup failure", error);
  } finally {
    lock.release();
  }
}

async function recoverActiveMutationRecorders(
  store: Pick<SqliteSessionBrokerStore, "listRecoverableRequests">,
  recover: (sessionUuid: string) => Promise<MutationRecorder | undefined>,
  recordingGaps: Pick<MutationRecordingGaps, "mark">,
): Promise<void> {
  let requests: Awaited<ReturnType<typeof store.listRecoverableRequests>>;
  try {
    requests = await store.listRecoverableRequests();
  } catch (error) {
    logger.warn("Cannot list recoverable session requests for mutation recorder recovery", error);
    return;
  }
  for (const request of requests) {
    if (request.state !== "active" || !request.sessionId) {
      continue;
    }
    try {
      await recover(request.sessionId!);
    } catch (error) {
      recordingGaps.mark(request.sessionId, `recorder recovery: ${errorMessage(error)}`);
      logger.warn(`Cannot recover mutation recorder for session ${request.sessionId}`, error);
    }
  }
}

/**
 * The resource of an active broker session whose device mutations are recorded. A watch session
 * never records them (no journal, baseline or runner): its binding skips the recorder, so recovery
 * must not attach one either (#15882).
 */
async function recordableSessionResource(
  store: Pick<SqliteSessionBrokerStore, "getSession" | "getResource">,
  sessionUuid: string,
): Promise<BrokerResourceRecord | undefined | "not-recordable"> {
  const request = await store.getSession(sessionUuid);
  if (request?.state !== "active" || !request.resourceId) {
    return "not-recordable";
  }
  const resource = await store.getResource(request.resourceId);
  return resource && nativeProfile(resource).platform === "watchos" ? "not-recordable" : resource;
}

async function recoverSessionMutationRecorder(
  options: Pick<OpenSessionBrokerServiceOptions, "mutationSessions" | "registry">,
  store: Pick<SqliteSessionBrokerStore, "getSession" | "getResource">,
  scopeKey: string,
  {
    bindMutationRecorder,
    sessionUuid,
  }: {
    bindMutationRecorder: ((scope: DeviceMutationScope) => void) | undefined;
    sessionUuid: string;
  },
): Promise<MutationRecorder | undefined> {
  if (!bindMutationRecorder || !options.mutationSessions) {
    return undefined;
  }
  const session = options.mutationSessions.peekSession(sessionUuid);
  if (!session) {
    return undefined;
  }
  const resource = await recordableSessionResource(store, sessionUuid);
  if (resource === "not-recordable") {
    return undefined;
  }
  const assignment = resource
    ? await options.registry.getAssignment({ scopeKey, bindingIndex: resource.allocationIndex })
    : null;
  assertRecoveredMutationAssignment(
    assignment,
    sessionUuid,
    session.stableDeviceId ?? session.assignedDevice,
  );
  bindMutationRecorder(
    recoveredMutationScope(sessionUuid, session.assignedDevice, resource, assignment),
  );
  const recorder = options.mutationSessions.peekSession(sessionUuid)?.mutationRecorder;
  if (!recorder) {
    throw new ActionableError(
      "Broker mutation recorder recovery did not attach a recorder to the active session",
    );
  }
  return recorder;
}

/** Chooses the iOS release reset for the configured reuse mode; `erase` keeps the default reset. */
function iosReuseWiring(
  options: OpenSessionBrokerServiceOptions,
  reuse: ReturnType<typeof iosReusePolicy>,
  parts: {
    erase: IosBaselineReset;
    journal: DeviceMutationJournal;
    recordingGaps: MutationRecordingGaps;
    store: Pick<SqliteSessionBrokerStore, "getRequest">;
  },
  erased: NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["ios"],
): {
  resetIosBaseline: NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["ios"];
  captureIosBaseline: ManagedDevicePortDependencies["captureIosBaseline"];
} {
  const { erase, journal, recordingGaps, store } = parts;
  if (reuse.mode === "keep-booted") {
    return keepBootedIosWiring(options, reuse, erase, { journal, recordingGaps, store });
  }
  if (reuse.mode === "minimal") {
    return {
      resetIosBaseline: minimalIosResetBaseline(options, reuse.maxUses, journal, {
        recordingGaps,
        store,
      }),
      captureIosBaseline: undefined,
    };
  }
  return { resetIosBaseline: erased, captureIosBaseline: undefined };
}

/** Wires `reuse.ios.mode: "keep-booted"`: baseline capture plus the cleaning reset with its erase or destroy fallback. */
function keepBootedIosWiring(
  options: OpenSessionBrokerServiceOptions,
  reuse: { maxUses: number; fallback: "erase" | "destroy" },
  erase: IosBaselineReset,
  {
    journal,
    recordingGaps,
    store,
  }: {
    journal: DeviceMutationJournal;
    recordingGaps: MutationRecordingGaps;
    store: Pick<SqliteSessionBrokerStore, "getRequest">;
  },
): {
  resetIosBaseline: NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["ios"];
  captureIosBaseline: ManagedDevicePortDependencies["captureIosBaseline"];
} {
  const mutations = nativeIosMutationResetPort(new SimCtlClient(null), options.timer);
  const fast = new IosKeepBootedReset({
    recordingGaps,
    journal,
    mutations,
    simctl: new SimCtlClient(null),
    timer: options.timer,
    health: nativeIosResetHealth(options.timer),
    erase,
    maxUses: reuse.maxUses,
    fallback: reuse.fallback,
    budgetMs: readEnvInt(ENV.IOS_RESET_STEP_BUDGET_MS),
    budgetCeilingMs: readEnvInt(ENV.IOS_RESET_STEP_BUDGET_MAX_MS),
  });
  return {
    captureIosBaseline: (context) => captureFirstDeviceBaseline(journal, mutations, context),
    resetIosBaseline: async (device, profile, assertOwned, { signal, context } = {}) => {
      const request = context?.resource.requestId
        ? await store.getRequest(context.resource.requestId)
        : undefined;
      if (!context || !request?.sessionId) {
        throw new ActionableError(
          "iOS keep-booted reset requires its durable released session identity",
        );
      }
      return fast.resetWithTiming(device, profile, assertOwned, {
        scope: { ...context.scope, sessionUuid: request.sessionId },
        reuseCount: context.resource.reuseCount ?? 0,
        signal,
        runResetBoot: context.runResetBoot,
      });
    },
  };
}

/** Wires `reuse.ios.mode: "minimal"`: release runs the fixed minimal cleaning, never an erase (#14682). */
function minimalIosResetBaseline(
  options: OpenSessionBrokerServiceOptions,
  maxUses: number,
  journal: DeviceMutationJournal,
  {
    recordingGaps,
    store,
  }: { recordingGaps: MutationRecordingGaps; store: Pick<SqliteSessionBrokerStore, "getRequest"> },
): NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["ios"] {
  const simctl = new SimCtlClient(null);
  const minimal = new IosMinimalReset({
    recordingGaps,
    journal,
    mutations: nativeIosMutationResetPort(simctl, options.timer),
    simctl,
    timer: options.timer,
    maxUses,
    budgetMs: readEnvInt(ENV.IOS_RESET_STEP_BUDGET_MS),
  });
  return async (device, profile, assertOwned, { signal, context } = {}) => {
    const request = context?.resource.requestId
      ? await store.getRequest(context.resource.requestId)
      : undefined;
    if (!context || !request?.sessionId) {
      throw new ActionableError("iOS minimal reset requires its durable released session identity");
    }
    return minimal.resetWithTiming(device, profile, assertOwned, {
      scope: { ...context.scope, sessionUuid: request.sessionId },
      reuseCount: context.resource.reuseCount ?? 0,
      signal,
    });
  };
}

/** An iOS journal shares the reset scope's incarnation, or the keep-booted reset cannot find it. */
function recoveredMutationScope(
  sessionUuid: string,
  assignedDevice: string,
  resource: BrokerResourceRecord | null | undefined,
  assignment: BindingAssignmentRecord,
): DeviceMutationScope {
  if (!resource) {
    throw new ActionableError("Recovered broker session has no resource");
  }
  return brokerSessionMutationScope({
    platform: nativeProfile(resource).platform,
    sessionUuid,
    resource,
    stableDeviceId: assignment.stableDeviceId ?? assignedDevice,
    transportId: assignedDevice,
    assignmentGeneration: assignment.generation,
    // Android has no boot ID or in-memory baseline after restart; reset already fails closed
    // with "lacks the original session baseline".
    bootId: null,
  });
}

function assertRecoveredMutationAssignment(
  assignment: BindingAssignmentRecord | null,
  sessionUuid: string,
  stableDeviceId: string,
): asserts assignment is BindingAssignmentRecord {
  if (
    !assignment ||
    assignment.state !== "ready" ||
    assignment.execOwner?.sessionUuid !== sessionUuid ||
    assignment.stableDeviceId !== stableDeviceId
  ) {
    throw new ActionableError(
      "Cannot recover broker mutation recording without the exact native assignment",
    );
  }
}

function nativeBaselineReset(
  config: SessionBrokerHostConfig,
  androidReset: OpenSessionBrokerServiceOptions["androidReset"],
  timer: Timer,
  {
    journal,
    recordingGaps,
  }: { journal: DeviceMutationJournal; recordingGaps: MutationRecordingGaps },
) {
  if (config.reuseAndroidCleanDevices && config.defaults.android && !androidReset) {
    throw new ActionableError("Android baseline reset requires the daemon readiness ports");
  }
  const reuseIos = iosReusePolicy(config).mode !== "off";
  return reuseIos || config.reuseAndroidCleanDevices
    ? {
        ios: reuseIos ? nativeIosBaselineReset() : undefined,
        // An Apple Watch follows the iOS reuse mode (#15882).
        watch: nativeWatchReset(config, timer),
        android:
          config.reuseAndroidCleanDevices && config.defaults.android
            ? nativeAndroidBaselineReset(androidReset!, timer, config, { journal, recordingGaps })
            : undefined,
      }
    : undefined;
}

function nativeIosBaselineReset(): IosBaselineReset {
  return new IosBaselineReset({
    simctl: new SimCtlClient(null),
    iosBootInstrumentation: bootAdmissionServices.iosBootInstrumentation(),
    stopDevice: async (device) => {
      // The ordinary lifecycle handler joins device controllers and invalidates caches before
      // erasure. A raw simctl shutdown would skip that provider bookkeeping.
      const result = readToolPayload(
        await defaultBindingToolInvoker("killDevice", { device }, undefined),
      );
      if (result.isError || result.payload.success === false) {
        throw new ActionableError(
          "Provider device shutdown did not confirm a clean controller teardown",
        );
      }
    },
  });
}

function nativeAndroidBaselineReset(
  ports: NonNullable<OpenSessionBrokerServiceOptions["androidReset"]>,
  timer: Timer,
  config: SessionBrokerHostConfig,
  {
    journal,
    recordingGaps,
  }: { journal: DeviceMutationJournal; recordingGaps: MutationRecordingGaps },
): AndroidBaselineReset {
  const configReader = new FileAvdConfigReader();
  const inventory = boundAndroidResetInventory(ports.inventory, timer);
  let snapshot: AndroidSnapshotReset | undefined;
  if (
    config.androidResetMode === "snapshot" ||
    (config.androidResetMode === "keep-booted" && config.androidKeepBootedFallback === "snapshot")
  ) {
    if (!ports.snapshot) {
      throw new ActionableError(
        "Android snapshot reset requires daemon readiness and identity ports",
      );
    }
    snapshot = new AndroidSnapshotReset(
      new NativeAndroidSnapshotResetPort({
        emulator: new AndroidEmulatorClient({ timer }),
        adb: defaultAdbClientFactory,
        config: configReader,
        console: defaultEmulatorConsoleBusyRegistry,
        clockRegistry: defaultDeviceClockRestoreRegistry,
        processStopper: getHostEmulatorProcessStopper(timer),
        clearQuickBoot: async (device, step) => {
          const directory = await configReader.resolveAvdDirectory(device.name);
          await step.assertOwned();
          if (!directory) {
            throw new ActionableError(
              "Android reset cannot locate its owned AVD to remove dirty quick-boot state",
            );
          }
          await rm(resolve(directory, AVD_SNAPSHOTS_DIRNAME, AVD_DEFAULT_BOOT_SNAPSHOT), {
            recursive: true,
            force: true,
          });
          await step.assertOwned();
        },
        capacity: {
          reserveBoot: (options) => {
            if (!bootAdmissionServices.androidColdBootAdmitter()) {
              throw new ActionableError(
                "Android snapshot replacement requires boot admission before stopping",
              );
            }
            return reserveBootCapacity("android", options);
          },
        },
        admitColdBoot: async (device, step) => {
          const admitter = bootAdmissionServices.androidColdBootAdmitter();
          if (!admitter) {
            throw new ActionableError(
              "Android snapshot wipe-data reset requires boot admission wiring",
            );
          }
          await step.assertOwned();
          return admitter.admit({
            avdName: device.name,
            timeoutMs: step.timeoutMs,
            signal: step.signal,
          });
        },
        readiness: ports.snapshot,
        inventory,
        ctrlProxyReady: ports.ctrlProxyReady,
        imageMetadata: async (imagePath, signal) => {
          const sdk = getAndroidHomeWithSystemImages();
          if (!sdk) {
            throw new ActionableError(
              "Android snapshot reset requires installed system-image metadata",
            );
          }
          return readFile(resolve(sdk.androidHome, imagePath, "source.properties"), {
            encoding: "utf8",
            signal,
          });
        },
        timer,
        invalidate: (deviceId) =>
          invalidateDisplayCaches(deviceId, "Android broker baseline reset"),
      }),
      timer,
      deviceSnapshotIncarnationInvalidator,
    );
  }
  const strategy = createAndroidResetStrategy(config, {
    recordingGaps,
    journal,
    timer,
    snapshot,
    port: (device) => new AndroidDeviceMutationResetPort(defaultAdbClientFactory.create(device)),
  });
  return new AndroidBaselineReset({
    postureReset: new AdbAndroidFoldPostureRestore(defaultAdbClientFactory),
    timer,
    resetTimeoutMs: config.androidResetTimeoutMs,
    inventory: async (options) => {
      const devices = await inventory(options);
      return Promise.all(
        devices.map(async (device) => {
          options?.signal?.throwIfAborted();
          const config = await configReader.readConfig(device.name);
          options?.signal?.throwIfAborted();
          return {
            ...device,
            isRunning: true,
            runtimeId: config?.systemImagePackage,
            deviceType: config?.deviceName,
            apiLevel: config?.apiLevel,
          };
        }),
      );
    },
    adb: (device) => defaultAdbClientFactory.create(device),
    watchSession: (sessionId) => watchAndroidResetSession(executionTracker, sessionId),
    ctrlProxyReady: ports.ctrlProxyReady,
    strategy,
  });
}

export function createAndroidResetStrategy(
  config: SessionBrokerHostConfig,
  {
    snapshot,
    ...dependencies
  }: Pick<AndroidKeepBootedResetDependencies, "journal" | "timer" | "port" | "recordingGaps"> & {
    snapshot?: AndroidResetStrategy;
  },
): AndroidResetStrategy | undefined {
  return config.androidResetMode === "keep-booted"
    ? new AndroidKeepBootedReset({
        ...dependencies,
        maxUses: config.androidKeepBootedMaxUses,
        fallback: snapshot,
        fallbackBudgetMs: snapshot
          ? (config.androidResetTimeoutMs ?? DEFAULT_ANDROID_RESET_TIMEOUT_MS)
          : undefined,
      })
    : snapshot;
}

export function boundAndroidResetInventory(
  inventory: NonNullable<OpenSessionBrokerServiceOptions["androidReset"]>["inventory"],
  timer: Timer,
): NonNullable<OpenSessionBrokerServiceOptions["androidReset"]>["inventory"] {
  return (options) => {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    return raceWithDeadline(() => inventory({ ...options, signal }), {
      timer,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      label: "Android baseline reset inventory",
      onTimeout: () => controller.abort(),
    });
  };
}

async function isCurrentReset(
  store: SqliteSessionBrokerStore,
  expected: BrokerResourceRecord,
): Promise<boolean> {
  const current = await store.getResource(expected.resourceId);
  return (
    current?.state === "resetting" &&
    current.revision === expected.revision &&
    current.requestId === expected.requestId &&
    current.scopeKey === expected.scopeKey
  );
}

async function assertBrokerSessionsOwned(
  options: OpenSessionBrokerServiceOptions,
  scopeKey: string,
): Promise<void> {
  const live = options.liveSessionIds?.() ?? [];
  if (live.length === 0) {
    return;
  }
  const requests = await options.registry.sessionBrokerStore(scopeKey).listRequests();
  const known = new Set(
    requests.flatMap((request) => (request.sessionId ? [request.sessionId] : [])),
  );
  // A create can have claimed native ownership before the broker's active receipt committed.
  for (const device of await options.registry.snapshotManagedDevices()) {
    if (device.scopeKey === scopeKey && device.execSessionUuid) {
      known.add(device.execSessionUuid);
    }
  }
  if (live.some((session) => !known.has(session))) {
    throw new ActionableError(
      "Session-broker mode requires prior generic sessions to be drained before startup",
    );
  }
}

async function assertBrokerInventoryOwned(
  registry: SqliteBindingRegistry,
  scopeKey: string,
): Promise<void> {
  const resources = await registry.sessionBrokerStore(scopeKey).listLiveResources();
  const occupied = new Set(
    resources
      .filter((resource) => resource.state !== "destroyed")
      .map((resource) => resource.allocationIndex),
  );
  const foreign = (await registry.snapshotManagedDevices()).some(
    (device) =>
      device.scopeKey !== scopeKey ||
      device.holder !== "session_broker" ||
      device.bindingIndex === null ||
      !occupied.has(device.bindingIndex),
  );
  const foreignJournal = (await registry.listOpenBindingJournal()).some(
    (entry) => entry.scopeKey !== scopeKey || !occupied.has(entry.bindingIndex),
  );
  if (foreign || foreignJournal) {
    throw new ActionableError(
      "Session-broker mode requires prior or unaccounted managed allocations to be drained; existing inventory remains untouched",
    );
  }
}

/** Explicit owner of the recovery loop, including interruptible idle waiting and a joined stop. */
/** Receipt retention runs at most this often; pruning is not urgent and takes the write lock. */
export const RECEIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Mutation-recording seams the service exposes to device-tool calls. */
export interface SessionBrokerServiceMutations {
  recordingGaps: Pick<MutationRecordingGaps, "mark">;
  /** Recovers a session's mutation recorder; absent resolves no recorder. */
  recorderFor?: (sessionUuid: string) => Promise<MutationRecorder | undefined>;
}

export class SessionBrokerService {
  private stopped = false;
  private lastPruneAtMs: number | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">;
  private readonly mutations: SessionBrokerServiceMutations;

  constructor(
    readonly broker: SessionBroker,
    readonly scopeKey: string,
    private readonly lock: SessionBrokerHostLock,
    {
      timer,
      mutations,
    }: {
      timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">;
      mutations: SessionBrokerServiceMutations;
    },
  ) {
    this.timer = timer;
    this.mutations = mutations;
  }

  markMutationUnrecorded(sessionUuid: string, reason: string): void {
    this.mutations.recordingGaps.mark(sessionUuid, reason);
  }

  async recoverMutationRecorder(sessionUuid: string): Promise<MutationRecorder | undefined> {
    try {
      if (this.stopped) {
        throw new ActionableError(
          "Cannot recover mutation recording from a stopped session broker",
        );
      }
      return await this.mutations.recorderFor?.(sessionUuid);
    } catch (error) {
      this.markMutationUnrecorded(sessionUuid, `recorder recovery: ${errorMessage(error)}`);
      logger.warn(
        `Cannot recover mutation recorder for session ${sessionUuid}; proceeding without recording`,
        error,
      );
      return undefined;
    }
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    this.running ??= this.loop();
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    try {
      await this.broker.markRestartHandoff();
    } catch (error) {
      // Preparations are already aborted; close retries the best-effort handoff after recovery.
      logger.warn(`Session broker restart handoff failed: ${errorMessage(error)}`, error);
    }
    await this.running;
    await this.broker.close();
    // Keep ownership if broker shutdown throws: the process's eventual exit makes the lock
    // reclaimable, whereas releasing it early could admit a successor over unfinished work.
    this.lock.release();
  }

  private async loop(): Promise<void> {
    let firstPass = true;
    while (!this.stopped) {
      if (!firstPass) {
        await this.wait();
      }
      if (this.stopped) {
        return;
      }
      try {
        await this.broker.recoverReceipts();
        await this.broker.recoverCleanup();
      } catch (error) {
        logger.warn(`Session broker recovery remains pending: ${errorMessage(error)}`);
      }
      await this.expireIdlePool();
      if (this.stopped) {
        return;
      }
      // Recovery is urgent at bind; retention keeps its existing delayed first pass.
      if (!firstPass) {
        await this.pruneIfDue();
      }
      firstPass = false;
    }
  }

  /** Idle expiry rides the recovery cadence, so its precision is one recovery interval. */
  private async expireIdlePool(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.broker.expireIdlePool();
    } catch (error) {
      // Expiry is housekeeping: an idle device left in the pool stays reusable for the next pass.
      logger.warn(`Session broker idle expiry failed: ${errorMessage(error)}`, error);
    }
  }

  private async pruneIfDue(): Promise<void> {
    const now = this.timer.now();
    if (this.lastPruneAtMs !== undefined && now - this.lastPruneAtMs < RECEIPT_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAtMs = now;
    try {
      // A full batch means more expired receipts may remain: do not wait out the interval.
      if ((await this.broker.pruneReceipts()) >= RECEIPT_PRUNE_BATCH) {
        this.lastPruneAtMs = undefined;
      }
    } catch (error) {
      // Retention is housekeeping; a busy registry only delays it to the next interval.
      logger.warn(`Session broker receipt retention failed: ${errorMessage(error)}`, error);
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.wake = undefined;
        resolve();
      };
      const timeout = this.timer.setTimeout(done, SESSION_BROKER_RECOVERY_INTERVAL_MS);
      this.wake = () => {
        this.timer.clearTimeout(timeout);
        done();
      };
    });
  }
}

function preparationLeaseKeepalive(
  options: Pick<OpenSessionBrokerServiceOptions, "mutationSessions" | "timer">,
): HeartbeatTaskLeaseKeepalive | undefined {
  const { mutationSessions, timer } = options;
  return mutationSessions
    ? new HeartbeatTaskLeaseKeepalive({ sessions: () => mutationSessions, timer })
    : undefined;
}
