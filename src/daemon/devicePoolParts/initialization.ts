import type { EmulatorLossIncidentStore } from "../emulatorLossIncident";
import { deviceHold, holdAllowsHealthRecovery } from "../deviceHold";
import type { SessionReleaseReason } from "../releaseReasons";
import { releaseSessionAndDevice } from "../releaseSessionAndDevice";
import { type DeviceHealthMarkers } from "../deviceHealthMarkers";
import { NotifyingDeviceHealthMarkers } from "../notifyingDeviceHealthMarkers";
import { type BackoffPolicy } from "../../utils/Backoff";
import { type Session } from "../sessionManager";
import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import { defaultTimer } from "../../utils/SystemTimer";
import { TTLCache } from "../../utils/cache/Cache";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { InstalledAppsRepository } from "../../db/installedAppsRepository";
import { DefaultRetryExecutor } from "../../utils/retry/RetryExecutor";
import { type DevicePoolRefreshPort } from "../devicePoolRefresh";
import { getDeviceRecoveryWindowMs } from "../poolConfig";
import { DeviceSessionRepository } from "../../db/deviceSessionRepository";
import { BoundedAndroidDeviceReboot } from "../../devices/androidDeviceReboot";
import { DeviceCriteriaMatcher } from "../DeviceCriteriaMatcher";
import { InMemoryEmulatorLossIncidentStore } from "../emulatorLossIncident";
import { EmulatorLossIncidentLedger } from "../emulatorLossIncidentLedger";
import { type EmulatorProcessLifecyclePoolPort } from "../emulatorProcessLifecycle";
import { type DeviceRuntimeIdentityPoolPort } from "../deviceRuntimeIdentity";
import { type DeviceShutdownReservationsPoolPort } from "../deviceShutdownReservations";
import { AndroidRecoveryRecordLedger } from "../androidRecoveryRecordLedger";
import { OwnerDisconnectRelease, OWNER_DISCONNECT_GRACE_MS } from "../ownerDisconnectRelease";
import {
  resolveDeviceHealthMarkers,
  resolveLifecycleCoordinator,
  resolveConsoleBusyRegistry,
  OwnerDisconnectOptions,
  DevicePoolDependencies,
  createEmulatorProcessLifecycle,
  createMissingDeviceLiveness,
  createAndroidTransportAliases,
  resolveMissingDeviceMisses,
  createDevicePoolRefresh,
  createDeviceRuntimeIdentity,
  createDeviceShutdownReservations,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface InitializationOperations {
  setDeviceProcessStartedListener(
    listener: ((deviceId: string) => void | Promise<void>) | undefined,
  ): void;
  notifyingHealthMarkers(inner: DeviceHealthMarkers): DeviceHealthMarkers;
  wireSessionDeviceHealth(backoff: BackoffPolicy | undefined): void;
  createOwnerDisconnectRelease(options?: OwnerDisconnectOptions): OwnerDisconnectRelease;
  releaseSessionForDisconnectedOwner(session: Session, reason: SessionReleaseReason): Promise<void>;
}
type InitializationState = Pick<
  DevicePoolState,
  | "onDeviceProcessStarted"
  | "devices"
  | "sessionManager"
  | "deviceHealthMarkers"
  | "timer"
  | "multiDeviceAllocations"
  | "foreignClaims"
  | "connectionOwnership"
  | "deviceAutoStart"
  | "deviceReservations"
  | "deviceReplacement"
  | "explicitDeviceBind"
  | "deviceAllocation"
  | "foreignDeviceOwnership"
  | "iosForeignDeviceOwnership"
  | "watchForeignDeviceOwnership"
  | "bindingExclusion"
  | "managedExecutionOwnership"
  | "daemonSessionId"
  | "androidTransportAliases"
  | "recoveryRetryRefresh"
  | "RECOVERY_RETRY_REFRESH_INTERVAL_MS"
  | "refreshMissingDeviceMisses"
  | "idGenerator"
  | "consoleBusyRegistry"
  | "installedAppsRepository"
  | "deviceManager"
  | "shutdownReservationCoordinator"
  | "missingDeviceLiveness"
  | "refreshCoordinator"
  | "emulatorProcessLifecycle"
  | "idleDeviceReaper"
  | "retryExecutor"
  | "deviceSessionRepository"
  | "autolockManager"
  | "criteriaMatcher"
  | "onDeviceReady"
  | "onDeviceRemoved"
  | "onDeviceIncarnationAssigned"
  | "onDeviceStateChanged"
  | "onDeviceFramesInvalidated"
  | "cancelDeviceSessionExecutions"
  | "ambientExecutionIdReader"
  | "runtimeIdentity"
  | "androidRecoveryRecordLedger"
  | "recoveryCoordinator"
  | "sessionPreservingRecovery"
  | "adbResetSessionRecovery"
  | "adbServerResetQuarantine"
  | "emulatorLossLedger"
  | "startedDeviceProcessOutput"
  | "lifecycleCoordinator"
  | "recoveryPolicy"
  | "deviceSessionContinuityEnabled"
  | "androidDeviceReboot"
  | "androidRebootCoordinator"
  | "disconnectHandler"
  | "releaseSessionForDisconnectedDevice"
  | "ownerDisconnectRelease"
>;
export type InitializationCallbacks = Pick<
  DevicePoolOperations,
  | "notifyDeviceStateChanged"
  | "getDeviceIncarnation"
  | "holdFactsFor"
  | "hasConnectedMcpSessionOwner"
  | "releaseDevice"
  | "createMultiDeviceAllocationQueue"
  | "createForeignClaims"
  | "createConnectionOwnership"
  | "createDeviceAutoStart"
  | "createDeviceReservations"
  | "createDeviceReplacement"
  | "createExplicitDeviceBind"
  | "createDeviceAllocation"
  | "registerMcpSessionOwnerCallReader"
  | "createShutdownReservationsPort"
  | "createMissingDevicePort"
  | "createRefreshPort"
  | "createEmulatorProcessPort"
  | "createIdleDeviceReaper"
  | "createAutolockManager"
  | "createRuntimeIdentityPort"
  | "getDevice"
  | "clearAdbResetRecoveryReservation"
  | "createRecoveryCoordinator"
  | "createSessionPreservingRecovery"
  | "createAdbResetSessionRecovery"
  | "createAdbResetQuarantine"
  | "getRecoveryPolicy"
  | "resolveRecoveryPolicy"
  | "resolveDeviceSessionContinuity"
  | "createAndroidRebootCoordinator"
  | "createDisconnectHandler"
  | "registerSessionReleaseHandlers"
>;

/** Initialization responsibilities of DevicePool. */
export class DevicePoolInitialization {
  constructor(
    private readonly state: InitializationState,
    private readonly callbacks: InitializationCallbacks,
  ) {}
  private wireForeignInventorySource(): void {
    this.state.deviceManager.withForeignAndroidSerialSource?.(this.state.foreignClaims);
  }

  initialize({
    env,
    sessionManager,
    daemonSessionId,
    timer = defaultTimer,
    deviceHealthMarkers,
    deviceHealthRecoveryBackoff,
    installedAppsRepository,
    deviceManager = new MultiPlatformDeviceManager(),
    retryExecutor = new DefaultRetryExecutor(timer),
    deviceSessionRepository = new DeviceSessionRepository(),
    criteriaMatcher = new DeviceCriteriaMatcher(),
    releaseSessionForDisconnectedDevice,
    ownerDisconnect,
    onDeviceReady,
    androidDeviceReboot,
    recoveryPolicy,
    onDeviceRemoved,
    onDeviceIncarnationAssigned,
    onDeviceStateChanged,
    onDeviceFramesInvalidated,
    emulatorLossIncidentStore = new InMemoryEmulatorLossIncidentStore(timer),
    cancelDeviceSessionExecutions,
    ambientExecutionIdReader,
    idGenerator = defaultIdGenerator,
    lifecycleCoordinator,
    consoleBusyRegistry,
    missingDeviceMisses,
    adbServerResetQuarantineFactory,
    emulatorProcessLifecycleFactory,
    missingDeviceLivenessFactory,
    devicePoolRefreshFactory,
    runtimeIdentityFactory,
    deviceShutdownReservationsFactory,
    deviceSessionContinuityEnabled,
    androidAdbFactory,
    foreignDeviceOwnership,
    iosForeignDeviceOwnership,
    watchForeignDeviceOwnership,
    bindingExclusion,
    managedExecutionOwnership,
  }: DevicePoolDependencies): void {
    this.state.multiDeviceAllocations = this.callbacks.createMultiDeviceAllocationQueue();
    this.state.foreignClaims = this.callbacks.createForeignClaims();
    this.state.connectionOwnership = this.callbacks.createConnectionOwnership();
    this.state.deviceAutoStart = this.callbacks.createDeviceAutoStart();
    this.state.deviceReservations = this.callbacks.createDeviceReservations();
    this.state.deviceReplacement = this.callbacks.createDeviceReplacement();
    this.state.explicitDeviceBind = this.callbacks.createExplicitDeviceBind();
    this.state.deviceAllocation = this.callbacks.createDeviceAllocation();
    this.state.sessionManager = sessionManager;
    this.callbacks.registerMcpSessionOwnerCallReader();
    this.state.foreignDeviceOwnership = foreignDeviceOwnership;
    this.state.iosForeignDeviceOwnership = iosForeignDeviceOwnership;
    this.state.watchForeignDeviceOwnership = watchForeignDeviceOwnership;
    this.state.bindingExclusion = bindingExclusion;
    this.state.managedExecutionOwnership = managedExecutionOwnership;
    this.state.daemonSessionId = daemonSessionId;
    this.state.timer = timer;
    this.state.androidTransportAliases = createAndroidTransportAliases(androidAdbFactory);
    this.state.recoveryRetryRefresh = new TTLCache(timer, {
      ttlMs: this.state.RECOVERY_RETRY_REFRESH_INTERVAL_MS,
      maxEntries: 1,
    });
    this.state.deviceHealthMarkers = this.notifyingHealthMarkers(
      resolveDeviceHealthMarkers(deviceHealthMarkers, timer),
    );
    this.wireSessionDeviceHealth(deviceHealthRecoveryBackoff);
    this.state.refreshMissingDeviceMisses = resolveMissingDeviceMisses(missingDeviceMisses);
    this.state.idGenerator = idGenerator;
    this.state.consoleBusyRegistry = resolveConsoleBusyRegistry(consoleBusyRegistry);
    this.state.installedAppsRepository = installedAppsRepository ?? new InstalledAppsRepository();
    this.state.deviceManager = deviceManager;
    this.wireForeignInventorySource();
    const shutdownReservationsPort: DeviceShutdownReservationsPoolPort =
      this.callbacks.createShutdownReservationsPort();
    this.state.shutdownReservationCoordinator = createDeviceShutdownReservations(
      shutdownReservationsPort,
      deviceShutdownReservationsFactory,
    );
    this.state.missingDeviceLiveness = createMissingDeviceLiveness(
      this.callbacks.createMissingDevicePort(),
      missingDeviceLivenessFactory,
    );
    const refreshPort: DevicePoolRefreshPort = this.callbacks.createRefreshPort();
    this.state.refreshCoordinator = createDevicePoolRefresh(refreshPort, devicePoolRefreshFactory);
    const emulatorProcessPort: EmulatorProcessLifecyclePoolPort =
      this.callbacks.createEmulatorProcessPort();
    this.state.emulatorProcessLifecycle = createEmulatorProcessLifecycle(
      emulatorProcessPort,
      emulatorProcessLifecycleFactory,
    );
    this.state.idleDeviceReaper = this.callbacks.createIdleDeviceReaper();
    this.state.retryExecutor = retryExecutor;
    this.state.deviceSessionRepository = deviceSessionRepository;
    this.state.autolockManager = this.callbacks.createAutolockManager(env);
    this.state.criteriaMatcher = criteriaMatcher;
    this.state.onDeviceReady = onDeviceReady;
    this.state.onDeviceRemoved = onDeviceRemoved;
    this.state.onDeviceIncarnationAssigned = onDeviceIncarnationAssigned;
    this.state.onDeviceStateChanged = onDeviceStateChanged;
    this.state.onDeviceFramesInvalidated = onDeviceFramesInvalidated;
    this.state.cancelDeviceSessionExecutions = cancelDeviceSessionExecutions ?? (async () => 0);
    this.state.ambientExecutionIdReader = ambientExecutionIdReader;
    const runtimeIdentityPort: DeviceRuntimeIdentityPoolPort =
      this.callbacks.createRuntimeIdentityPort(ambientExecutionIdReader);
    this.state.runtimeIdentity = createDeviceRuntimeIdentity(
      runtimeIdentityPort,
      runtimeIdentityFactory,
    );
    this.initializeAndroidRecoveryRecords();
    this.state.recoveryCoordinator = this.callbacks.createRecoveryCoordinator();
    this.state.sessionPreservingRecovery = this.callbacks.createSessionPreservingRecovery();
    this.state.adbResetSessionRecovery = this.callbacks.createAdbResetSessionRecovery();
    this.state.adbServerResetQuarantine = this.callbacks.createAdbResetQuarantine(
      adbServerResetQuarantineFactory,
    );
    this.initializeEmulatorLossLedger(emulatorLossIncidentStore);
    this.state.lifecycleCoordinator = resolveLifecycleCoordinator(lifecycleCoordinator);
    // Resolve recovery policy once so retries and status agree even if the
    // process environment changes after construction.
    this.state.recoveryPolicy = this.callbacks.resolveRecoveryPolicy(recoveryPolicy);
    this.state.deviceSessionContinuityEnabled = this.callbacks.resolveDeviceSessionContinuity(
      deviceSessionContinuityEnabled,
    );
    this.state.androidDeviceReboot =
      androidDeviceReboot ??
      new BoundedAndroidDeviceReboot(
        timer,
        this.state.recoveryPolicy.maxAttempts,
        getDeviceRecoveryWindowMs(),
      );
    this.state.androidRebootCoordinator = this.callbacks.createAndroidRebootCoordinator();
    this.state.disconnectHandler = this.callbacks.createDisconnectHandler();
    this.state.releaseSessionForDisconnectedDevice =
      releaseSessionForDisconnectedDevice ??
      (async (sessionId, _deviceId, releaseReason, { shouldCommit, releaseOptions } = {}) => {
        // The session manager re-evaluates the fence immediately before it
        // removes the session, after its setup/restoration awaits (#7031).
        const release = await this.state.sessionManager.releaseSessionUnlessSuperseded(
          sessionId,
          releaseReason,
          { commitFence: shouldCommit, ...releaseOptions },
        );
        return !release.superseded;
      });
    this.state.ownerDisconnectRelease = this.createOwnerDisconnectRelease(ownerDisconnect);
    this.callbacks.registerSessionReleaseHandlers();
  }

  setDeviceProcessStartedListener(
    listener: ((deviceId: string) => void | Promise<void>) | undefined,
  ): void {
    this.state.onDeviceProcessStarted = listener;
  }

  /**
   * Every marker mutation moves a device between idle and assigned: publish it from this one
   * wrapper rather than from each session-manager call site (#11568).
   */
  notifyingHealthMarkers(inner: DeviceHealthMarkers): DeviceHealthMarkers {
    return new NotifyingDeviceHealthMarkers(inner, (deviceId) => {
      const device = this.state.devices.get(deviceId);
      if (device) {
        this.callbacks.notifyDeviceStateChanged(device);
      }
    });
  }

  /** Health recovery may only act on an idle, unowned device with no cleanup in flight. */
  wireSessionDeviceHealth(backoff: BackoffPolicy | undefined): void {
    this.state.sessionManager.setDeviceHealthMarkers(
      this.state.deviceHealthMarkers,
      (id) => this.callbacks.getDeviceIncarnation(id),
      (id) => {
        const device = this.state.devices.get(id);
        return device
          ? holdAllowsHealthRecovery(
              deviceHold(this.callbacks.holdFactsFor(device, undefined, "health")),
            )
          : false;
      },
      backoff,
    );
  }

  createOwnerDisconnectRelease(options: OwnerDisconnectOptions = {}): OwnerDisconnectRelease {
    return new OwnerDisconnectRelease(
      {
        getSession: (sessionId) => this.state.sessionManager.getSession(sessionId),
        hasConnectedOwner: (sessionId) => this.callbacks.hasConnectedMcpSessionOwner(sessionId),
        release:
          options.release ??
          ((session, reason) => this.releaseSessionForDisconnectedOwner(session, reason)),
      },
      this.state.timer,
      options.graceMs ?? OWNER_DISCONNECT_GRACE_MS,
      () => this.state.sessionManager.sessionNow(),
    );
  }

  async releaseSessionForDisconnectedOwner(
    session: Session,
    reason: SessionReleaseReason,
  ): Promise<void> {
    const { sessionId, assignedDevice } = session;
    await releaseSessionAndDevice(
      this.state.sessionManager,
      this.callbacks,
      assignedDevice,
      sessionId,
      {
        reason,
        release: () =>
          this.state.sessionManager.releaseSession(sessionId, reason, {
            expectedOwner: { session: session, deviceId: assignedDevice },
          }),
      },
    );
  }

  private initializeAndroidRecoveryRecords(): void {
    this.state.androidRecoveryRecordLedger = new AndroidRecoveryRecordLedger(
      {
        getDevice: (deviceId) => this.callbacks.getDevice(deviceId),
        getSession: (sessionId) => this.state.sessionManager.getSession(sessionId),
        clearAdbResetReservation: (record) =>
          this.callbacks.clearAdbResetRecoveryReservation(record),
      },
      this.state.timer,
    );
  }
  private initializeEmulatorLossLedger(emulatorLossIncidentStore: EmulatorLossIncidentStore): void {
    this.state.emulatorLossLedger = new EmulatorLossIncidentLedger(
      {
        getDevice: (deviceId) => this.callbacks.getDevice(deviceId),
        getRecoveryPolicy: () => this.callbacks.getRecoveryPolicy(),
        getSessionForDevice: (deviceId) => this.state.sessionManager.getSessionForDevice(deviceId),
        getSession: (sessionId) => this.state.sessionManager.getSession(sessionId),
        sessionClockToWall: (sessionClockMs) =>
          this.state.sessionManager.sessionClockToWall(sessionClockMs),
        getProcessOutputTail: (deviceId) => this.state.startedDeviceProcessOutput.get(deviceId),
      },
      emulatorLossIncidentStore,
      this.state.timer,
      this.state.retryExecutor,
    );
  }
}

export function connectInitialization(
  part: () => DevicePoolInitialization,
  seams: Pick<DevicePoolOperations, "setDeviceProcessStartedListener">,
): InitializationOperations {
  return {
    setDeviceProcessStartedListener: (...args) => seams.setDeviceProcessStartedListener(...args),
    notifyingHealthMarkers: (...args) => part().notifyingHealthMarkers(...args),
    wireSessionDeviceHealth: (...args) => part().wireSessionDeviceHealth(...args),
    createOwnerDisconnectRelease: (...args) => part().createOwnerDisconnectRelease(...args),
    releaseSessionForDisconnectedOwner: (...args) =>
      part().releaseSessionForDisconnectedOwner(...args),
  };
}
