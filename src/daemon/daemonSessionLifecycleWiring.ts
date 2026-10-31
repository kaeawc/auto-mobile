import { lazySessionReleasePool } from "./releaseSessionAndDevice";
import { logger } from "../utils/logger";
import { defaultDisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import { registerLocationRouteSessionCleanup } from "../features/utility/LocationRoutePlayer";
import { registerStatusBarSessionCleanup } from "./statusBarSessionCleanup";
import { registerKillProfileSessionCleanup } from "./killProfileSessionCleanup";
import { registerEmulatorSensorSessionCleanup } from "./emulatorSensorSessionCleanup";
import {
  createOwnerlessAudioAcquisitionCleanup,
  registerEmulatorAudioSessionCleanup,
} from "./emulatorAudioSessionCleanup";
import { registerDisplayProfileSessionCleanup } from "./displayProfileSessionCleanup";
import { registerKeyboardProfileSessionCleanup } from "./keyboardProfileSessionCleanup";
import { registerDeviceConditionSessionCleanup } from "./deviceConditionSessionCleanup";
import { registerDerivedLabelSessionReleaseCascade } from "./derivedLabelSessionReleaseCascade";
import { executionTracker } from "./executionTracker";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { announceSessionRelease } from "./announceSessionRelease";
import { clearSessionAppearanceConfig } from "./appearanceManager";
import {
  DefaultDeviceSettingsAccess,
  DeviceSettingDefaults,
  createDeviceSettingDefaultsAcquisitionReset,
  installDeviceSettingDefaults,
  registerDeviceSettingDefaultsIdentityListener,
} from "../features/utility/DeviceSettingDefaults";
import { DeviceSettingDefaultsRepository } from "../db/deviceSettingDefaultsRepository";
import {
  createOwnerlessNetworkStateAcquisitionCleanup,
  registerNetworkStateSessionCleanup,
} from "./networkStateSessionCleanup";
import { registerPerformanceMonitorSessionCleanup } from "./performanceMonitorSessionCleanup";
import { registerAppLinksSessionCleanup } from "./appLinksSessionCleanup";
import { registerScreenLockSessionCleanup } from "./screenLockSessionCleanup";
import { registerPowerSessionCleanup } from "./powerSessionCleanup";
import { registerProfilingSessionCleanup } from "./profilingSessionCleanup";
import { registerSystemAlertSessionCleanup } from "./systemAlertSessionCleanup";
import {
  createOwnerlessRecordingAcquisitionCleanup,
  createRecorderTeardownRecoveryMarker,
  defaultRecordingSessionCleanupDeps,
  takeRecordingIdsFinalizedByRelease,
  registerRecordingSessionCleanup,
} from "./recordingSessionCleanup";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import {
  NavigationGraphManager,
  type NavigationGraphService,
} from "../features/navigation/NavigationGraphManager";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { DeviceReadiness } from "./readiness/DeviceReadiness";
import { registerAppearanceClaimSync } from "./appearanceClaimSync";
import type { Timer } from "../utils/SystemTimer";
import type { SessionManager } from "./sessionManager";
import type { DevicePool } from "./devicePool";
import type { PassiveWorkPolicy } from "./PassiveWorkPolicy";
import type { ManagedExecutionReowner } from "./sessionBroker/provisioning/executionReowner";
import type { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import type { ActiveSessionExecutionQuery } from "./sessionManager";

/**
 * Daemon-owned collaborators the session lifecycle wiring reads. Members that can change after
 * construction (servers, per-shutdown sets) are accessors so each callback sees the current value.
 */
export interface DaemonSessionLifecycleHost {
  markMutationUnrecorded(sessionUuid: string, reason: string): void;
  deviceReadiness(): Pick<DeviceReadiness, "clearExplicitDevicePin">;
  deviceDataStreamServer(): {
    invalidateDeviceFrames(deviceId: string): void;
    invalidateInitialDeviceFrames(deviceId: string): void;
  } | null;
  socketServer(): {
    liftSessionlessStrokesOn(deviceId: string): void;
    liftStrokesHeldByOn(sessionId: string, deviceId: string): void;
  } | null;
  managedExecutionReowner(): Pick<ManagedExecutionReowner, "noteRecovering"> | undefined;
  devicePool(): Pick<DevicePool, "getDevice" | "getAllDevices" | "releaseDevice">;
  passiveWorkPolicy(): Pick<PassiveWorkPolicy, "allows">;
  navigationGraphListenerManagers: WeakSet<NavigationGraphService>;
  shutdownReleaseNotifications(): Set<string> | null;
  shutdownFallbackReleaseNotifications(): Set<string> | null;
  setupNavigationGraphUpdateListener(manager: NavigationGraphService): void;
  reownRehydratedManagedExecutions(rehydrated: readonly string[]): Promise<void>;
  hasActiveSessionExecution(sessionId: string, query?: ActiveSessionExecutionQuery): boolean;
  latestSessionExecutionDeadlineMs(
    sessionId: string,
    options?: { onSessionClock?: boolean; excludeReads?: boolean },
  ): number | undefined;
  cancelExecutionsForExpiryRelease(
    sessionId: string,
    cancellation: SessionReleasedDuringCallError,
    query: ActiveSessionExecutionQuery,
    releasedDeviceId: string | undefined,
  ): void;
}

// Capture aliases before release removes the session and derived-label relationships.
function captureNetworkGapMarker(
  sessionManager: SessionManager,
  host: Pick<DaemonSessionLifecycleHost, "markMutationUnrecorded">,
  sessionId: string,
): (reason: string) => void {
  const ids = new Set(
    [
      sessionId,
      sessionManager.ownershipSessionUuid(sessionId),
      sessionManager.getBaseSessionOfDerivedLabel(sessionId),
    ].filter((id) => id !== undefined),
  );
  return (reason) => {
    for (const id of ids) {
      host.markMutationUnrecorded(id, reason);
    }
  };
}

/**
 * Registers every SessionManager listener/setter the daemon needs for session-scoped cleanup,
 * in the order the daemon has always registered them (release listeners fire in that order).
 */
export function wireSessionLifecycle(
  sessionManager: SessionManager,
  timer: Timer,
  host: DaemonSessionLifecycleHost,
): void {
  registerLocationRouteSessionCleanup(sessionManager);
  registerNetworkStateSessionCleanup(sessionManager, {
    timer,
    gapMarkerFor: (sessionId) => captureNetworkGapMarker(sessionManager, host, sessionId),
  });
  registerStatusBarSessionCleanup(sessionManager);
  registerAppLinksSessionCleanup(sessionManager);
  registerKillProfileSessionCleanup(sessionManager);
  registerEmulatorSensorSessionCleanup(sessionManager);
  registerEmulatorAudioSessionCleanup(sessionManager);
  registerDisplayProfileSessionCleanup(sessionManager);
  registerKeyboardProfileSessionCleanup(sessionManager);
  registerDeviceConditionSessionCleanup(sessionManager);
  registerPerformanceMonitorSessionCleanup(sessionManager);
  registerScreenLockSessionCleanup(sessionManager);
  registerPowerSessionCleanup(sessionManager);
  registerProfilingSessionCleanup(sessionManager);
  registerSystemAlertSessionCleanup(sessionManager);
  registerRecordingSessionCleanup(sessionManager, {
    ...defaultRecordingSessionCleanupDeps,
    markDeviceNeedsRecorderRecovery: createRecorderTeardownRecoveryMarker(sessionManager),
  });
  sessionManager.onDeviceOwnershipChange((deviceId, frameInvalidation) => {
    // Generation only for unchanged-screen acquire/release; full for runtime-changing rebinds.
    if (frameInvalidation === "full") {
      host.deviceDataStreamServer()?.invalidateDeviceFrames(deviceId);
    } else {
      host.deviceDataStreamServer()?.invalidateInitialDeviceFrames(deviceId);
    }
  });
  sessionManager.setManagedExecutionRecoveryListener((id, recovered) =>
    host.managedExecutionReowner()?.noteRecovering(id, recovered),
  );
  sessionManager.setLateRehydrationListener((rehydrated) =>
    host.reownRehydratedManagedExecutions(rehydrated),
  );
  sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
    host.hasActiveSessionExecution(sessionId, query),
  );
  sessionManager.setSessionExecutionDeadlineLookup((sessionId, query) =>
    host.latestSessionExecutionDeadlineMs(sessionId, { onSessionClock: true, ...query }),
  );
  // Deadlines are stamped on the wall clock; remember how far the session clock stood from it
  // so the idle veto can judge them without a later wall step (#11105).
  executionTracker.setSessionClockOffsetProvider(() => sessionManager.sessionNow() - timer.now());
  sessionManager.setExpiryReleaseExecutionCanceller(
    (sessionId, cancellation, query, releasedDeviceId) =>
      host.cancelExecutionsForExpiryRelease(sessionId, cancellation, query, releasedDeviceId),
  );
  // A sessionless call admitted while the device was free must not keep driving it for the new
  // holder (#10829). The call performing the acquisition is spared.
  // The acquiring holder adopts active sessionless recordings without stopping them (#11665).
  const adoptOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(sessionManager);
  // Sessionless network mocks and simulations are cleared the same way (#11130).
  const clearOwnerlessNetworkState = createOwnerlessNetworkStateAcquisitionCleanup(sessionManager, {
    timer: timer,
  });
  // Sessionless emulator microphone feeds are stopped the same way.
  const stopOwnerlessAudio = createOwnerlessAudioAcquisitionCleanup(sessionManager);
  // Display/system settings a previous session changed are reset to the recorded device
  // defaults when a different session acquires the device (#11145).
  const settingDefaults = new DeviceSettingDefaults(
    new DeviceSettingDefaultsRepository(),
    new DefaultDeviceSettingsAccess(),
    (deviceId) => sessionManager.getSessionForDevice(deviceId),
    { timer },
  );
  installDeviceSettingDefaults(settingDefaults);
  registerDeviceSettingDefaultsIdentityListener(settingDefaults);
  const resetSettingDefaults = createDeviceSettingDefaultsAcquisitionReset(
    sessionManager,
    settingDefaults,
    timer,
  );
  sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId, sessionId) => {
    executionTracker.cancelSessionlessDeviceUse(deviceId, {
      excludeExecutionId: getToolSelectionContext()?.execution?.executionId,
    });
    // A sessionless stroke parked on the device with no frame in flight is lifted too (#11541).
    host.socketServer()?.liftSessionlessStrokesOn(deviceId);
    adoptOwnerlessRecordings(deviceId, sessionId);
    clearOwnerlessNetworkState(deviceId);
    stopOwnerlessAudio(deviceId);
    resetSettingDefaults(deviceId, sessionId);
  });
  sessionManager.onSessionCreated((session) => {
    NavigationGraphManager.clearReleasedSession(session.sessionId);
    host.setupNavigationGraphUpdateListener(
      NavigationGraphManager.getInstanceForSession(session.sessionId),
    );
  });
  // The device a session is created on or rebound to takes that session's appearance (#11363).
  registerAppearanceClaimSync(sessionManager, host);
  // Register centralized cleanup for session-scoped state
  sessionManager.onSessionRelease((sessionId, deviceId, _reason, options) => {
    // A terminal upgrade of an already-cleaned-up release must not touch the device's next
    // owner: its pin, caches and CtrlProxy binding (#10825).
    if (options?.upgradeOnly) {
      return;
    }
    host.deviceReadiness().clearExplicitDevicePin(deviceId);
    // Only this session's own manager: the lookup with fallback returns the global manager for
    // an already-released session, and dropping it would silence its listeners (#10825).
    const navigationManager = NavigationGraphManager.findInstanceForSession(sessionId);
    if (navigationManager) {
      host.navigationGraphListenerManagers.delete(navigationManager);
    }
    NavigationGraphManager.releaseSession(sessionId);
    RealObserveScreen.clearCache(deviceId);
    defaultDisplayInventoryProvider.invalidate(deviceId);
    // Clear the per-device CtrlProxy client's binding to the released session
    // (#4984) so a nav/hierarchy event arriving before the next session binds the
    // still-connected device is never attributed to the ended session, and its
    // cached hierarchy detector (which retains the released session's manager) is
    // dropped. Central here so it covers EVERY release path — explicit, idle,
    // heartbeat, device-switch, and derived `${base}:${label}` sessions alike.
    AndroidCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
    IOSCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
  });
  // A released base takes its derived `${base}:${label}` sessions with it (#11091).
  // The pool is created after these callbacks are wired, so resolve it per release.
  registerDerivedLabelSessionReleaseCascade(
    sessionManager,
    lazySessionReleasePool(() => host.devicePool()),
  );
  // A rebind keeps the session live, but its navigation state was collected on
  // the old device and must not follow it to the new one.
  sessionManager.onSessionDeviceUnbound((sessionId, deviceId) => {
    host.socketServer()?.liftStrokesHeldByOn(sessionId, deviceId);
    host.deviceReadiness().clearExplicitDevicePin(deviceId);
    const previousNavigationManager = NavigationGraphManager.getInstanceForSession(sessionId);
    NavigationGraphManager.resetSession(sessionId);
    host.navigationGraphListenerManagers.delete(previousNavigationManager);
    host.setupNavigationGraphUpdateListener(
      NavigationGraphManager.getInstanceForSession(sessionId),
    );
    RealObserveScreen.clearCache(deviceId);
    defaultDisplayInventoryProvider.invalidate(deviceId);
    AndroidCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
    IOSCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
  });
  // Emit a real "session released" signal so a connected DaemonMcpProxy clears
  // its remembered session binding the moment the daemon releases the session
  // (heartbeat / idle / plan), rather than guessing with the replay TTL. Fires
  // for every released key — base and derived `${base}:${label}` alike; the
  // proxy matches its bound (base) UUID by exact equality (issue #4610).
  sessionManager.onSessionRelease((sessionId, _deviceId, releaseReason, { snapshot, ...opts }) => {
    // Name the recordings this release is finalizing so the previous owner can fetch them
    // (#10958); the recording cleanup captured them when the release began.
    announceSessionRelease(
      {
        takeRecordingIds: takeRecordingIdsFinalizedByRelease,
        emit: (...args) => SessionReleaseBroadcaster.emit(...args),
      },
      sessionId,
      releaseReason,
      {
        shutdown: {
          fallbacks: host.shutdownFallbackReleaseNotifications(),
          announced: host.shutdownReleaseNotifications(),
        },
        snapshot,
        upgradeOnly: opts?.upgradeOnly,
      },
    );
    if (host.shutdownFallbackReleaseNotifications()?.has(sessionId)) {
      return;
    }
    // A session that is gone for good takes its appearance config with it (#10976). A derived
    // `${base}:${label}` session stores none, so its release clears nothing.
    if (snapshot.terminal) {
      clearSessionAppearanceConfig(sessionId).catch((error: unknown) => {
        logger.warn(`[Appearance] Failed to drop config of released session ${sessionId}`, error);
      });
    }
  });
}
