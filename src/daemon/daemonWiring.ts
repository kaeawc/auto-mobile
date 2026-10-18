import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { Timer } from "../utils/SystemTimer";
import type { IdGenerator } from "../utils/IdGenerator";
import { defaultDisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import { stopLocationRouteForRemovedDevice } from "../features/utility/LocationRoutePlayer";
import { defaultMockLocationClearRegistry } from "../features/utility/MockLocationClear";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { ForeignCtrlProxyForwardEvidence } from "../features/observe/android/foreignCtrlProxyForwardEvidence";
import { DeviceReadiness } from "../devices/DeviceReadiness";
import { NetworkState } from "../server/NetworkState";
import { clearSessionAppearanceConfig } from "../server/appearanceManager";
import { ambientExecutionIdReader } from "../server/deviceExecutionBinding";
import type { DeviceStateChangeNotifier } from "../server/deviceStateChangeNotifier";
import { EmulatorLossIncidentRepository } from "../db/emulatorLossIncidentRepository";
import { InstalledAppsRepository, type InstalledAppsStore } from "../db/installedAppsRepository";
import { executionTracker } from "../server/executionTracker";
import { sessionExecutionProbe } from "./toolCallActivity";
import type { Daemon } from "./daemon";
import { DaemonState } from "./daemonState";
import type { LiveDaemonSessionIdProvider } from "./daemonFiles";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";
import { DevicePool, type DevicePoolDependencies } from "./devicePool";
import { ForwardLeaseForeignDeviceOwnership } from "./foreignDeviceOwnership";
import type { IncumbentOwnerGuard } from "./incumbentOwnerGuard";
import { ObserverReleaseBroadcaster } from "./observerReleaseBroadcast";
import { ObserverSessionRegistry } from "./observerSessionRegistry";
import {
  OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
  OwnerDisconnectExecutionVeto,
} from "./ownerDisconnectRelease";
import { isDeviceSessionContinuityEnabled, type parseDeviceRecoveryPolicy } from "./poolConfig";
import { SessionManager } from "./sessionManager";
import type { BindingExclusion } from "./sessionBroker/provisioning/exclusion";
import type { ManagedExecutionReowner } from "./sessionBroker/provisioning/executionReowner";
import { getDaemonStreamDeviceLifecycleEmitter } from "./streamDeviceLifecycleEvents";
import {
  wireSessionLifecycle,
  type DaemonSessionLifecycleHost,
} from "./daemonSessionLifecycleWiring";

/**
 * The daemon-owned behaviour the constructed collaborators call back into. Every member is read
 * when it is invoked, not when the graph is built, so the cycle between the session manager, the
 * pool and the daemon is resolved here, in one place, rather than by setters in the constructor.
 */
export interface DaemonWiringHost extends Omit<
  DaemonSessionLifecycleHost,
  "deviceDataStreamServer" | "managedExecutionReowner" | "devicePool"
> {
  devicePool(): Pick<
    DevicePool,
    "getDevice" | "getAllDevices" | "releaseDevice" | "isSessionRecoveryInFlight"
  >;
  deviceDataStreamServer(): {
    invalidateDeviceFrames(deviceId: string): void;
    invalidateInitialDeviceFrames(deviceId: string): void;
    removeDeviceFrames(deviceId: string): void;
  } | null;
  managedExecutionReowner(): ManagedExecutionReowner | undefined;
  cancelAndReleaseSession: Daemon["cancelAndReleaseSession"];
  cancelAndDrainDeviceSessionExecutions(
    sessionId: string,
    reason: string,
    options?: { excludeExecutionId?: string },
  ): Promise<number>;
  cancelAndDrainDeviceExecutions(
    deviceId: string,
    reason: string | Error,
    options?: { excludeExecutionId?: string; onlySessionUuid?: string },
  ): Promise<number>;
  onDeviceReadyForSessionRegistry(deviceId: string): void;
  recorderDeviceIncarnationListener(): ((deviceId: string) => void) | undefined;
}

export interface DaemonWiringInputs {
  timer: Timer;
  idGenerator: IdGenerator;
  daemonSessionId: string;
  deviceSessionRepository: ConstructorParameters<typeof SessionManager>[1] &
    NonNullable<DevicePoolDependencies["deviceSessionRepository"]>;
  /** Defaults to the production repository. */
  installedAppsRepository?: InstalledAppsStore;
  incumbentOwnerGuard: Pick<IncumbentOwnerGuard, "withLiveIncumbent">;
  liveDaemonSessionIdProvider: LiveDaemonSessionIdProvider;
  bindingExclusionFactory: (timer: Timer) => BindingExclusion;
  foreignCtrlProxyForwardEvidence?: ForeignCtrlProxyForwardEvidence;
  recoveryPolicy: ReturnType<typeof parseDeviceRecoveryPolicy>["policy"];
  recoveryPolicyEnvironment: NodeJS.ProcessEnv;
  deviceDisconnectMisses: Map<string, number>;
  deviceStateChangeNotifier: DeviceStateChangeNotifier;
  host: DaemonWiringHost;
}

export interface DaemonCollaborators {
  sessionManager: SessionManager;
  observerSessionRegistry: ObserverSessionRegistry;
  installedAppsRepository: InstalledAppsStore;
  deviceSessionRegistry: DeviceSessionRegistry;
  devicePool: DevicePool;
}

/**
 * Builds the daemon's session manager, registries and device pool in dependency order and wires
 * the session lifecycle listeners. The pool is created last because the owner-disconnect veto and
 * its callbacks read it lazily through `host`.
 */
export function wireDaemonCollaborators(inputs: DaemonWiringInputs): DaemonCollaborators {
  const { timer, host } = inputs;
  const sessionManager = new SessionManager(timer, inputs.deviceSessionRepository);
  sessionManager.attachDaemonSessionId(inputs.daemonSessionId);
  // Read when a recovery claims its row, so a peer that started after this daemon is seen. A
  // restart incumbent whose pid file this daemon replaced is not listed, so it is added while
  // it is still live: its rows and its terminal-release journal are not a dead daemon's (#11355).
  sessionManager.attachLiveDaemonSessionIds(() =>
    inputs.incumbentOwnerGuard.withLiveIncumbent(
      inputs.liveDaemonSessionIdProvider.collectLiveDaemonSessionIds(),
    ),
  );
  const observerSessionRegistry = new ObserverSessionRegistry(timer, undefined, (sessionId) => {
    // An observer's per-session appearance config (#10976) dies with the observer.
    clearSessionAppearanceConfig(sessionId).catch((error: unknown) => {
      logger.warn(`[Appearance] Failed to drop config of observer ${sessionId}`, error);
    });
    // So do the viewer streams its registration admitted (#11076).
    ObserverReleaseBroadcaster.emit(sessionId);
  });
  wireSessionLifecycle(sessionManager, timer, host);
  const installedAppsRepository = inputs.installedAppsRepository ?? new InstalledAppsRepository();
  const deviceSessionRegistry = new DeviceSessionRegistry(timer, inputs.idGenerator);
  const devicePool = createDevicePool(inputs, sessionManager, deviceSessionRegistry, {
    installedAppsRepository,
  });
  return {
    sessionManager,
    observerSessionRegistry,
    installedAppsRepository,
    deviceSessionRegistry,
    devicePool,
  };
}

/** Publishes the constructed collaborators to the process-wide {@link DaemonState}. */
export function publishDaemonState(
  collaborators: DaemonCollaborators,
  sessionBrokerMode: boolean,
): void {
  DaemonState.getInstance().initialize(
    collaborators.sessionManager,
    collaborators.devicePool,
    collaborators.deviceSessionRegistry,
    collaborators.observerSessionRegistry,
  );
  DaemonState.getInstance().setSessionBrokerMode(sessionBrokerMode);
}

function createDevicePool(
  inputs: DaemonWiringInputs,
  sessionManager: SessionManager,
  deviceSessionRegistry: DeviceSessionRegistry,
  repositories: { installedAppsRepository: InstalledAppsStore },
): DevicePool {
  const { timer, host } = inputs;
  const ownerDisconnectExecutionVeto = new OwnerDisconnectExecutionVeto(
    // The pool is read when the probe is asked, not when it is built: the veto is built while the
    // pool itself is being constructed, so it is not available yet.
    sessionExecutionProbe(
      executionTracker,
      sessionManager,
      { isSessionRecoveryInFlight: (id) => host.devicePool().isSessionRecoveryInFlight(id) },
      { excludeReads: true },
    ),
    timer,
    OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
    () => sessionManager.sessionNow(),
  );
  return DevicePool.create({
    sessionManager,
    daemonSessionId: inputs.daemonSessionId,
    timer,
    bindingExclusion: inputs.bindingExclusionFactory(timer),
    ...(inputs.foreignCtrlProxyForwardEvidence
      ? {
          foreignDeviceOwnership: new ForwardLeaseForeignDeviceOwnership(
            undefined,
            undefined,
            undefined,
            undefined,
            timer,
            inputs.foreignCtrlProxyForwardEvidence,
          ),
        }
      : {}),
    managedExecutionOwnership: () => host.managedExecutionReowner(),
    missingDeviceMisses: inputs.deviceDisconnectMisses,
    installedAppsRepository: repositories.installedAppsRepository,
    deviceSessionRepository: inputs.deviceSessionRepository,
    releaseSessionForDisconnectedDevice: (
      sessionId,
      _deviceId,
      releaseReason,
      shouldCommit,
      releaseOptions,
    ) =>
      host.cancelAndReleaseSession(sessionId, releaseReason, false, undefined, shouldCommit, {
        deferFailureFallback: true,
        releaseOptions,
      }),
    ownerDisconnect: {
      release: async (session, reason) => {
        // A control call defers release (#5343); retry when it ends or the veto's bound
        // passes (#10663, #10712). A read never defers release and is cut instead (#11381).
        const deferral = ownerDisconnectExecutionVeto.keeps(session);
        if (deferral) {
          return deferral;
        }
        // A cut read or a control call past the veto's bound is told the session is gone,
        // as a call arriving after the release is (#11381).
        await host.cancelAndReleaseSession(session.sessionId, reason, false, session, undefined, {
          cutCallsLearnRelease: true,
        });
      },
    },
    onDeviceReady: (deviceId) => host.onDeviceReadyForSessionRegistry(deviceId),
    recoveryPolicy: inputs.recoveryPolicy,
    onDeviceFramesInvalidated: (deviceId) => {
      // Full: pool callbacks signal new incarnations or untrusted runtime identity.
      host.deviceDataStreamServer()?.invalidateDeviceFrames(deviceId);
      getDaemonStreamDeviceLifecycleEmitter().deviceIdentityChanged(deviceId);
    },
    onDeviceIncarnationAssigned: (deviceId) => host.recorderDeviceIncarnationListener()?.(deviceId),
    onDeviceRemoved: (deviceId, platform) => {
      getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(deviceId);
      stopLocationRouteForRemovedDevice(deviceId);
      defaultMockLocationClearRegistry.retireDevice(deviceId);
      NetworkState.getInstance().retireDevice(deviceId);
      defaultDisplayInventoryProvider.invalidate(deviceId);
      DeviceReadiness.getInstance().clearExplicitDevicePin(deviceId);
      deviceSessionRegistry.onDeviceDisconnected(deviceId);
      // Full removal: prune AFTER epoch retirement, which also invalidates frames.
      host.deviceDataStreamServer()?.removeDeviceFrames(deviceId);
      if (platform === "android") {
        void AndroidCtrlProxyClient.evictAfterDeviceRemoval(deviceId).catch((error) => {
          logger.warn(
            `[Daemon] Failed to stop Android CtrlProxy for removed device ${deviceId}: ${errorMessage(error)}`,
            error,
          );
        });
      }
      if (platform === "ios") {
        void IOSCtrlProxyManager.evictAfterDeviceRemoval(deviceId).catch((error) => {
          logger.warn(
            `[Daemon] Failed to stop iOS CtrlProxy for removed device ${deviceId}: ${errorMessage(error)}`,
          );
        });
      }
    },
    // Subscribers to the booted-device resources learn of status and holder changes (#11413).
    onDeviceStateChanged: inputs.deviceStateChangeNotifier,
    emulatorLossIncidentStore: new EmulatorLossIncidentRepository(
      undefined,
      timer,
      inputs.idGenerator,
    ),
    ambientExecutionIdReader,
    cancelDeviceSessionExecutions: Object.assign(
      (sessionId: string, reason: string, options?: { excludeExecutionId?: string }) =>
        host.cancelAndDrainDeviceSessionExecutions(sessionId, reason, options),
      {
        cancelDeviceExecutions: (
          deviceId: string,
          reason: string | Error,
          options?: { excludeExecutionId?: string; onlySessionUuid?: string },
        ) => host.cancelAndDrainDeviceExecutions(deviceId, reason, options),
      },
    ),
    idGenerator: inputs.idGenerator,
    deviceSessionContinuityEnabled: isDeviceSessionContinuityEnabled(
      inputs.recoveryPolicyEnvironment,
    ),
  });
}
