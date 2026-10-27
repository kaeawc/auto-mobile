import { lazyDeviceClaims, StoreDeviceClaimMirror, type DeviceClaimMirror } from "../deviceClaims";
import type { SqliteBindingRegistry } from "../sessionBroker/registry/sqliteBindingRegistry";
import type {
  DaemonCoreServices,
  DaemonIdentityState,
  DaemonLifecycleState,
} from "./DaemonCoreState";
import { holderOf } from "../deviceBinding";
import { wireSessionLifecycle } from "../daemonSessionLifecycleWiring";
import type { SessionReleaseReason } from "../releaseReasons";
import { type BindingExclusion } from "../sessionBroker/provisioning/exclusion";
import { getDaemonStreamDeviceLifecycleEmitter } from "../streamDeviceLifecycleEvents";
import {
  cancelAndReleaseSession as cancelExecutionsAndReleaseSession,
  cancelExecutionsCutBySessionRelease,
  releaseSessionAndDevice,
} from "../releaseSessionAndDevice";
import type { SessionReleasedDuringCallError } from "../sessionReleasedDuringCall";
import { ambientExecutionIdReader } from "../deviceExecutionBinding";
import { ObserverSessionRegistry } from "../observerSessionRegistry";
import { logger } from "../../utils/logger";
import { defaultDisplayInventoryProvider } from "../../devices/DisplayInventoryProvider";
import { stopLocationRouteForRemovedDevice } from "../../features/utility/LocationRoutePlayer";
import { defaultKillProfileRestoreRegistry } from "../../features/utility/KillProfileRestore";
import { defaultEmulatorSensorRestoreRegistry } from "../../features/utility/EmulatorSensorRestore";
import { defaultDisplayProfileRestoreRegistry } from "../../features/utility/DisplayProfileRestore";
import { defaultPersonaRestoreRegistry } from "../../features/utility/PersonaRestore";
import { defaultSystemAlertPolicyRegistry } from "../../features/action/systemAlerts/SystemAlertPolicy";
import { defaultKeyboardProfileRestoreRegistry } from "../../features/utility/KeyboardProfileRestore";
import { defaultMockLocationClearRegistry } from "../../features/utility/MockLocationClear";
import { forgetStatusBarOverrideForRemovedDevice } from "../statusBarSessionCleanup";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import {
  type ActiveSessionExecutionQuery,
  type Session,
  type SessionReleaseOptions,
} from "../sessionManager";
import {
  hasActiveSessionExecution,
  latestSessionExecutionDeadlineMs,
  sessionExecutionProbe,
  subscribeToolCallEndActivity,
} from "../toolCallActivity";
import { DevicePool } from "../devicePool";
import { ForwardLeaseForeignDeviceOwnership } from "../foreignDeviceOwnership";
import { type ForeignCtrlProxyForwardEvidence } from "../../features/observe/android/foreignCtrlProxyForwardEvidence";
import {
  OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
  OwnerDisconnectExecutionVeto,
} from "../ownerDisconnectRelease";
import type { SessionExecutionProbe } from "../unsettledExecutionVeto";
import { isDeviceSessionContinuityEnabled, parseDeviceRecoveryPolicy } from "../poolConfig";
import { executionTracker } from "../executionTracker";
import { type DeviceStateChangeNotifier } from "../deviceStateChangeNotifier";
import { appearanceSyncTargets } from "../appearanceSyncTargets";
import { NetworkState } from "../../utils/NetworkState";
import { defaultAppLinksRestoreRegistry } from "../../features/utility/appLinks/AppLinkRestore";
import { resolveToolSelectionBaseSessionUuid } from "../../features/toolSelection/selectionSessionResolver";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { EmulatorLossIncidentRepository } from "../../db/emulatorLossIncidentRepository";
import { type AppearanceSyncTarget } from "../AppearanceSyncScheduler";
import { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import type { DaemonBroker } from "./DaemonBroker";
import type { DaemonStreams } from "./DaemonStreams";

const DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS = 1_000;

function androidOwnershipWithMirror(
  ownership: ForwardLeaseForeignDeviceOwnership,
  mirror: DeviceClaimMirror,
): ForwardLeaseForeignDeviceOwnership {
  ownership.attachClaimMirror(mirror);
  return ownership;
}
export interface DaemonSessionsHost {
  services: Pick<
    DaemonCoreServices,
    | "daemonState"
    | "deviceReadiness"
    | "sessionManager"
    | "devicePool"
    | "deviceSessionRegistry"
    | "installedAppsRepository"
    | "deviceSessionRepository"
    | "timer"
    | "passiveWorkPolicy"
    | "idGenerator"
  >;
  identity: Pick<DaemonIdentityState, "daemonSessionId">;
  lifecycle: Pick<
    DaemonLifecycleState,
    | "socketServer"
    | "deviceDisconnectMisses"
    | "managedExecutionReowner"
    | "deviceDataStreamServer"
    | "navigationGraphBridge"
    | "recorderDeviceIncarnationListener"
    | "shutdownReleaseNotifications"
    | "shutdownFallbackReleaseNotifications"
  >;
  bindingExclusionFactory: () => (timer: Timer) => BindingExclusion;
  /** The open binding registry, observed only: the claims mirror never opens one. */
  bindingRegistry: () => Promise<SqliteBindingRegistry> | undefined;
  foreignCtrlProxyForwardEvidence: () => ForeignCtrlProxyForwardEvidence | undefined;
  deviceStateChangeNotifier: () => DeviceStateChangeNotifier;
  observerSessionRegistry: () => ObserverSessionRegistry;
  cancelAndReleaseSession: DaemonSessions["cancelAndReleaseSession"];
  onDeviceReadyForSessionRegistry: DaemonStreams["onDeviceReadyForSessionRegistry"];
  reownRehydratedManagedExecutions: DaemonBroker["reownRehydratedManagedExecutions"];
}

/** Wires session ownership, pool callbacks, execution vetoes and bounded release. */
export class DaemonSessions {
  private unsubscribeSessionExecutionEnded: (() => void) | null = null;
  constructor(private readonly host: DaemonSessionsHost) {}

  createDevicePool(
    recoveryPolicy: ReturnType<typeof parseDeviceRecoveryPolicy>["policy"],
    recoveryPolicyEnvironment: NodeJS.ProcessEnv,
  ): DevicePool {
    const ownerDisconnectExecutionVeto = new OwnerDisconnectExecutionVeto(
      this.sessionExecutionProbe({ excludeReads: true }),
      this.host.services.timer(),
      OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
      () => this.host.services.sessionManager().sessionNow(),
    );
    const claimStore = lazyDeviceClaims(() => this.host.bindingRegistry());
    const claimMirror = (platform: "android" | "ios"): StoreDeviceClaimMirror =>
      new StoreDeviceClaimMirror({
        platform,
        store: claimStore,
        timer: this.host.services.timer(),
        daemonSessionId: this.host.identity.daemonSessionId(),
      });
    const androidClaimMirror = claimMirror("android");
    return DevicePool.create({
      deviceClaimMirrors: { android: androidClaimMirror, ios: claimMirror("ios") },
      sessionManager: this.host.services.sessionManager(),
      daemonSessionId: this.host.identity.daemonSessionId(),
      timer: this.host.services.timer(),
      bindingExclusion: this.host.bindingExclusionFactory()(this.host.services.timer()),
      ...(this.host.foreignCtrlProxyForwardEvidence()
        ? {
            foreignDeviceOwnership: androidOwnershipWithMirror(
              new ForwardLeaseForeignDeviceOwnership(
                undefined,
                undefined,
                undefined,
                undefined,
                this.host.services.timer(),
                this.host.foreignCtrlProxyForwardEvidence(),
              ),
              androidClaimMirror,
            ),
          }
        : {}),
      managedExecutionOwnership: () => this.host.lifecycle.managedExecutionReowner(),
      missingDeviceMisses: this.host.lifecycle.deviceDisconnectMisses(),
      installedAppsRepository: this.host.services.installedAppsRepository(),
      deviceSessionRepository: this.host.services.deviceSessionRepository(),
      releaseSessionForDisconnectedDevice: (
        sessionId,
        _deviceId,
        releaseReason,
        shouldCommit,
        releaseOptions,
      ) =>
        this.host.cancelAndReleaseSession(sessionId, releaseReason, {
          shouldCommit,
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
          await this.host.cancelAndReleaseSession(session.sessionId, reason, {
            expectedSession: session,
            cutCallsLearnRelease: true,
          });
        },
      },
      onDeviceReady: (deviceId) => this.host.onDeviceReadyForSessionRegistry(deviceId),
      recoveryPolicy: recoveryPolicy,
      onDeviceFramesInvalidated: (deviceId) => {
        // Full: pool callbacks signal new incarnations or untrusted runtime identity.
        this.host.lifecycle.deviceDataStreamServer()?.invalidateDeviceFrames(deviceId);
        getDaemonStreamDeviceLifecycleEmitter().deviceIdentityChanged(deviceId);
      },
      onDeviceIncarnationAssigned: (deviceId) =>
        this.host.lifecycle.recorderDeviceIncarnationListener()?.(deviceId),
      onDeviceRemoved: (deviceId, platform) => {
        getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(deviceId);
        stopLocationRouteForRemovedDevice(deviceId);
        defaultMockLocationClearRegistry.retireDevice(deviceId);
        forgetStatusBarOverrideForRemovedDevice(deviceId);
        NetworkState.getInstance().retireDevice(deviceId);
        defaultAppLinksRestoreRegistry.retireDevice(deviceId);
        defaultKillProfileRestoreRegistry.retireDevice(deviceId);
        defaultEmulatorSensorRestoreRegistry.retireDevice(deviceId);
        defaultDisplayProfileRestoreRegistry.retireDevice(deviceId);
        defaultPersonaRestoreRegistry.retireDevice(deviceId);
        defaultSystemAlertPolicyRegistry.retireDevice(deviceId);
        defaultKeyboardProfileRestoreRegistry.retireDevice(deviceId);
        defaultDisplayInventoryProvider.invalidate(deviceId);
        this.host.services.deviceReadiness().clearExplicitDevicePin(deviceId);
        this.host.services.deviceSessionRegistry().onDeviceDisconnected(deviceId);
        // Full removal: prune AFTER epoch retirement, which also invalidates frames.
        this.host.lifecycle.deviceDataStreamServer()?.removeDeviceFrames(deviceId);
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
      onDeviceStateChanged: this.host.deviceStateChangeNotifier(),
      emulatorLossIncidentStore: new EmulatorLossIncidentRepository(
        undefined,
        this.host.services.timer(),
        this.host.services.idGenerator(),
      ),
      ambientExecutionIdReader,
      cancelDeviceSessionExecutions: Object.assign(
        (sessionId: string, reason: string, options?: { excludeExecutionId?: string }) =>
          this.cancelAndDrainDeviceSessionExecutions(sessionId, reason, options),
        {
          cancelDeviceExecutions: (
            deviceId: string,
            reason: string | Error,
            options?: { excludeExecutionId?: string; onlySessionUuid?: string },
          ) => this.cancelAndDrainDeviceExecutions(deviceId, reason, options),
        },
      ),
      idGenerator: this.host.services.idGenerator(),
      deviceSessionContinuityEnabled: isDeviceSessionContinuityEnabled(recoveryPolicyEnvironment),
    });
  }

  /** Stop the session sweeps and the tool-call-end subscription that feed session expiry. */
  stopSessionTimers(): void {
    // A change in the last debounce window must not notify after the daemon closed (#11413).
    this.host.deviceStateChangeNotifier().dispose();
    this.host.services.sessionManager().stopCleanupTimer();
    this.host.observerSessionRegistry().dispose();
    this.unsubscribeSessionExecutionEnded?.();
    this.unsubscribeSessionExecutionEnded = null;
  }

  /**
   * Idleness counts from the END of the last tool call (owner decision 2026-10-08), and a call's
   * end re-arms the owner-disconnect releases it deferred (#10712). Subscribed by `start()` and
   * dropped by {@link stopSessionTimers}; idempotent so a retried start cannot stack listeners.
   */
  subscribeToolCallEndActivity(): void {
    this.unsubscribeSessionExecutionEnded?.();
    this.unsubscribeSessionExecutionEnded = subscribeToolCallEndActivity(
      executionTracker,
      this.host.services.sessionManager(),
      this.host.services.devicePool(),
    );
  }

  configureSessionLifecycleCallbacks(): void {
    wireSessionLifecycle(this.host.services.sessionManager(), this.host.services.timer(), {
      markMutationUnrecorded: (sessionUuid, reason) =>
        this.host.services
          .daemonState()
          .getSessionBrokerService()
          ?.markMutationUnrecorded(sessionUuid, reason),
      deviceDataStreamServer: () => this.host.lifecycle.deviceDataStreamServer(),
      socketServer: () => this.host.lifecycle.socketServer(),
      managedExecutionReowner: () => this.host.lifecycle.managedExecutionReowner(),
      deviceReadiness: () => this.host.services.deviceReadiness(),
      devicePool: () => this.host.services.devicePool(),
      passiveWorkPolicy: () => this.host.services.passiveWorkPolicy(),
      navigationGraphListenerManagers: this.host.lifecycle.navigationGraphBridge().listenerManagers,
      shutdownReleaseNotifications: () => this.host.lifecycle.shutdownReleaseNotifications(),
      shutdownFallbackReleaseNotifications: () =>
        this.host.lifecycle.shutdownFallbackReleaseNotifications(),
      setupNavigationGraphUpdateListener: (manager) =>
        this.host.lifecycle.navigationGraphBridge().attach(manager),
      reownRehydratedManagedExecutions: (rehydrated) =>
        this.host.reownRehydratedManagedExecutions(rehydrated),
      hasActiveSessionExecution: (sessionId, query) =>
        this.hasActiveSessionExecution(sessionId, query),
      latestSessionExecutionDeadlineMs: (sessionId, options) =>
        this.latestSessionExecutionDeadlineMs(sessionId, options),
      cancelExecutionsForExpiryRelease: (sessionId, cancellation, query, releasedDeviceId) =>
        this.cancelExecutionsForExpiryRelease(sessionId, cancellation, query, releasedDeviceId),
    });
  }

  getAppearanceSyncTargets(): AppearanceSyncTarget[] {
    return appearanceSyncTargets(
      this.host.services.devicePool(),
      this.host.services.passiveWorkPolicy(),
      this.host.services.sessionManager(),
    );
  }

  private hasActiveSessionExecution(
    sessionId: string,
    query?: ActiveSessionExecutionQuery,
  ): boolean {
    return hasActiveSessionExecution(
      executionTracker,
      this.host.services.sessionManager(),
      this.host.services.devicePool(),
      sessionId,
      query,
    );
  }

  /**
   * How the unsettled-execution veto sees a session's in-flight work: whether any runs, and the
   * latest request deadline among them, which bounds the veto (#10712). The veto judges on the
   * session clock, so the deadlines are converted onto it (#11162).
   */
  sessionExecutionProbe(options: { excludeReads?: boolean } = {}): SessionExecutionProbe {
    // The pool is read when the probe is asked, not when it is built: the owner-disconnect veto
    // is built while the pool itself is being constructed, so `this.devicePool` is not set yet.
    const pool = {
      isSessionRecoveryInFlight: (sessionId: string) =>
        this.host.services.devicePool().isSessionRecoveryInFlight(sessionId),
    };
    return sessionExecutionProbe(
      executionTracker,
      this.host.services.sessionManager(),
      pool,
      options,
    );
  }

  /** Mirrors {@link hasActiveSessionExecution}; a recovery in flight carries no deadline. */
  private latestSessionExecutionDeadlineMs(
    sessionId: string,
    options: { onSessionClock?: boolean; excludeReads?: boolean } = {},
  ): number | undefined {
    return latestSessionExecutionDeadlineMs(
      executionTracker,
      this.host.services.sessionManager(),
      this.host.services.devicePool(),
      sessionId,
      options,
    );
  }

  /**
   * Abort what a release overrides — idle expiry (#10820), heartbeat reap and owner disconnect
   * (#11400) — through {@link cancelExecutionsCutBySessionRelease}: the released session's own
   * calls with the typed release (#11381), and a base session's calls only where they drive the
   * released derived session's device. The aborts land before the release that follows starts.
   */
  private cancelExecutionsForExpiryRelease(
    sessionId: string,
    cancellation: SessionReleasedDuringCallError,
    query: ActiveSessionExecutionQuery,
    releasedDeviceId: string | undefined,
  ): void {
    cancelExecutionsCutBySessionRelease(
      executionTracker,
      {
        sessionId,
        baseSessionId: resolveToolSelectionBaseSessionUuid(
          sessionId,
          this.host.services.sessionManager(),
        ),
        deviceId: releasedDeviceId,
        excludeExecutionId: query.excludeExecutionId,
      },
      cancellation,
    ).catch((error: unknown) => {
      logger.warn(
        `[Daemon] Failed to cancel executions of released session ${sessionId}: ${errorMessage(error)}`,
        error,
      );
    });
  }

  /** Cancel a session's in-flight calls and release it. Public so tests can drive one release without a full lifecycle. */
  async cancelAndReleaseSession(
    sessionId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
    options?: {
      allowExpired?: boolean;
      expectedSession?: Session;
      shouldCommit?: () => boolean;
      deferFailureFallback?: boolean;
      releaseOptions?: SessionReleaseOptions;
      /**
       * The release ends the session for a reason of its own (heartbeat reap, owner disconnect),
       * so every call it cuts is aborted with the typed release, through the routine the
       * idle-expiry releases use (#11381, #11400).
       */
      cutCallsLearnRelease?: boolean;
    },
  ): Promise<boolean> {
    const { allowExpired = false, expectedSession, shouldCommit } = options ?? {};
    const release = async (cancelled: number): Promise<boolean> => {
      // Early identity fence: discovery can replace a same-serial runtime while
      // execution cancellation is in flight. It is not the final one — the
      // session manager re-evaluates `shouldCommit` immediately before it
      // removes the session, after its own setup/restoration awaits (#7031).
      if (shouldCommit?.() === false) {
        return false;
      }
      // Capture the owner before release can remove it or hide it behind a
      // terminal fence. Pool lookup also covers expired sessions during shutdown.
      const assignedDeviceId =
        expectedSession?.assignedDevice ??
        this.host.services
          .devicePool()
          .getAllDevices()
          .find((device) => holderOf(device) === sessionId)?.id ??
        null;
      let deviceId: string | null = null;
      let superseded = false;
      await releaseSessionAndDevice(
        this.host.services.sessionManager(),
        this.host.services.devicePool(),
        assignedDeviceId,
        sessionId,
        releaseReason,
        {
          deferFailureFallback: options?.deferFailureFallback,
          release: async () => {
            if (expectedSession) {
              deviceId = await this.host.services
                .sessionManager()
                .releaseSession(sessionId, releaseReason, {
                  expectedOwner: {
                    session: expectedSession,
                    deviceId: expectedSession.assignedDevice,
                  },
                });
            } else if (shouldCommit) {
              const release = await this.host.services
                .sessionManager()
                .releaseSessionUnlessSuperseded(sessionId, releaseReason, {
                  commitFence: shouldCommit,
                  allowExpired,
                  ...options?.releaseOptions,
                });
              if (release.superseded) {
                logger.info(
                  `Kept session ${sessionId}: a newer identity confirmation superseded its release (reason=${releaseReason})`,
                );
                superseded = true;
                return null;
              }
              deviceId = release.deviceId;
            } else {
              deviceId = await this.host.services
                .sessionManager()
                .releaseSession(sessionId, releaseReason, {
                  allowExpired,
                  ...options?.releaseOptions,
                });
            }
            // A completed persistence retry may return a device already idle or
            // reassigned. Do not issue a stale pool release or report it as freed.
            if (!this.isSessionDeviceAssigned(deviceId, sessionId)) {
              deviceId = null;
            }
            return deviceId;
          },
        },
      );
      if (superseded) {
        return false;
      }
      if (!deviceId || this.isSessionDeviceAssigned(deviceId, sessionId)) {
        logger.info(
          `Cancelled session ${sessionId} (${cancelled} executions); no device freed (reason=${releaseReason})`,
        );
        return false;
      }
      logger.info(
        `Cancelled session ${sessionId} (${cancelled} executions) and released device ${deviceId} ` +
          `(reason=${releaseReason})`,
      );
      return true;
    };
    if (options?.cutCallsLearnRelease) {
      // The veto that held this release counted the session's implicit (autolock) calls too, so
      // the release must cut them as well, never only the calls that name the session UUID: one
      // left running would keep driving a device that is already free (#11400). The aborts are
      // signalled before the release starts.
      const cancelled = executionTracker.getActiveDeviceSessionExecutionCount(sessionId);
      this.host.services.sessionManager().cancelExecutionsCutByRelease(sessionId, releaseReason);
      return release(cancelled);
    }
    return cancelExecutionsAndReleaseSession(sessionId, releaseReason, release);
  }

  private isSessionDeviceAssigned(deviceId: string | null, sessionId: string): boolean {
    return (
      deviceId !== null &&
      holderOf(this.host.services.devicePool().getDevice(deviceId)) === sessionId
    );
  }

  private async cancelAndDrainDeviceExecutions(
    deviceId: string,
    reason: string | Error,
    options?: { excludeExecutionId?: string; onlySessionUuid?: string },
  ): Promise<number> {
    const cancelled = await executionTracker.cancelDeviceExecutions(deviceId, reason, options);
    if (cancelled === 0) {
      return 0;
    }
    const drained = await executionTracker.waitForDeviceExecutionsToEnd(
      deviceId,
      DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS,
      options,
    );
    if (!drained) {
      logger.warn(
        `[Daemon] Timed out after ${DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS}ms draining ` +
          `cancelled executions for device ${deviceId}`,
      );
    }
    return cancelled;
  }

  private async cancelAndDrainDeviceSessionExecutions(
    sessionId: string,
    reason: string,
    options?: { excludeExecutionId?: string },
  ): Promise<number> {
    const cancelled = await executionTracker.cancelDeviceSessionExecutions(
      sessionId,
      reason,
      options,
    );
    if (cancelled === 0) {
      return 0;
    }
    const drained = await executionTracker.waitForDeviceSessionExecutionsToEnd(
      sessionId,
      DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS,
      options,
    );
    if (!drained) {
      logger.warn(
        `[Daemon] Timed out after ${DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS}ms draining ` +
          `cancelled executions for device session ${sessionId}`,
      );
    }
    return cancelled;
  }
}
