import {
  IOS_APP_NETWORK_RULE_LEASE_MS,
  IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS,
  IosAppNetworkRuleClient,
} from "../../features/networkFilter/IosAppNetworkRuleClient";
import { ExecNetworkFilterBridge } from "../../features/networkFilter/NetworkFilterBridge";
import { DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS } from "../../models/deviceAcquisitionRefusals";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { type Timer } from "../../utils/SystemTimer";
import { DeviceCleanupQuarantine } from "../deviceCleanupQuarantine";
import { type IosAppNetworkRuleRestorer } from "../iosAppNetworkLease";
import {
  defaultBiometricEnrollmentRestorer,
  defaultClockRestorerFactory,
  defaultKeepScreenAwakeRestorer,
  defaultNetworkConditionRestorer,
  defaultRotationRestorerFactory,
  defaultScreenReaderRestorer,
} from "../sessionDefaultRestorers";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import { SessionLivenessController } from "../sessionLivenessLease";
import { ForcedStuckRelease } from "./forcedStuckRelease";
import { type SessionManagerCollaboratorHost } from "./host";
import { managedExecutionReleaseMarker } from "./internalContracts";
import { RecoveredTerminalReleaseIntents } from "./recoveredTerminalReleaseIntents";
import { type TerminalReleaseJournal } from "../terminalReleaseJournal";
import type { SessionManagerOptions, DeviceStateRestorerFactories } from "../sessionManager";
import {
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
  getDefaultSessionHeartbeatTimeoutMs,
} from "../sessionManager";
import type { SessionDeviceStateRestoreHost } from "../sessionDeviceStateRestore";
import type { SessionLivenessPort } from "../sessionLivenessLease";
export type SessionManagerConstructionSeams = Pick<
  SessionDeviceStateRestoreHost,
  "trackSessionSetup" | "clearRestoreHealth" | "abandonRestore"
> &
  Pick<SessionLivenessPort, "getBarrier" | "livenessOwnerView" | "hasUnissuedActivity"> & {
    setJournal(journal: TerminalReleaseJournal): void;
    trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void;
  };

function resolveDeviceStateRestorers(
  timer: Timer,
  overrides: DeviceStateRestorerFactories,
): Required<Omit<DeviceStateRestorerFactories, "iosAppNetworkRule">> &
  Pick<DeviceStateRestorerFactories, "iosAppNetworkRule"> {
  // The facade exports the retry delay; defer reading it until its module has initialized.
  DEFAULT_ROTATION_RESTORE_BACKOFF ??= exponentialBackoff({
    initialDelayMs: NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
    maxDelayMs: 2_000,
  });
  return {
    networkCondition: overrides.networkCondition ?? defaultNetworkConditionRestorer,
    clock: overrides.clock ?? defaultClockRestorerFactory(timer),
    rotation: overrides.rotation ?? defaultRotationRestorerFactory(timer),
    rotationBackoff: overrides.rotationBackoff ?? DEFAULT_ROTATION_RESTORE_BACKOFF,
    screenReader: overrides.screenReader ?? defaultScreenReaderRestorer,
    screenReaderBackoff: overrides.screenReaderBackoff ?? DEFAULT_SCREEN_READER_RESTORE_BACKOFF,
    iosAppNetworkRule: overrides.iosAppNetworkRule,
  };
}
function defaultIosAppNetworkRuleRestorer(): IosAppNetworkRuleRestorer {
  const client = new IosAppNetworkRuleClient(new ExecNetworkFilterBridge());
  return {
    reset: async (rule) => {
      const result = await client.reset(rule);
      // Another session's rule for the same app is not ours to remove; ours is gone.
      if (
        result.kind === "reset" ||
        (result.kind === "refused" && result.outcome === "owned_by_another_session")
      ) {
        return;
      }
      throw new Error(
        `Failed to remove the offline rule for ${rule.bundleId} on ${rule.udid}: ${result.detail}`,
      );
    },
    renew: (rule, leaseMs) => client.renew(rule, leaseMs),
  };
}
/** Construction wiring keeps all calls live through the facade's injected host. */
export class SessionManagerConstruction {
  constructor(
    private readonly host: SessionManagerCollaboratorHost,
    private readonly seams: SessionManagerConstructionSeams,
  ) {}
  createDeviceCleanupQuarantine(timer: Timer) {
    return new DeviceCleanupQuarantine({
      timer,
      now: () => this.host.sessionNow(),
      hasOwner: (deviceId) => this.host.getSessionForDevice(deviceId) !== null,
      teardownCapMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
      defaultRetryAfterMs: DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
    });
  }
  createStateRestore(timer: Timer, options: SessionManagerOptions) {
    const restorers = options.restorers ?? {};
    const keepScreenAwake = options.keepScreenAwakeRestorer ?? defaultKeepScreenAwakeRestorer;
    const biometricEnrollment =
      options.biometricEnrollmentRestorer ?? defaultBiometricEnrollmentRestorer;
    const resolved = resolveDeviceStateRestorers(timer, restorers);
    return new SessionDeviceStateRestore(
      {
        timer,
        dispatchDeviceRestore: (deviceId, restore, generation, teardownStep) =>
          this.host.dispatchDeviceRestore(deviceId, restore, generation, teardownStep),
        restoreGeneration: (deviceId) => this.host.replacedRestoreGenerations.get(deviceId) ?? 0,
        hasIdentityReplacementFence: (deviceId) =>
          this.host.identityReplacementFences.has(deviceId),
        trackSessionSetup: (session, createSetup) =>
          this.seams.trackSessionSetup(session, createSetup),
        isPublished: (session) => this.host.sessions.get(session.sessionId) === session,
        healthIncarnation: (deviceId) => this.host.deviceHealth?.incarnation(deviceId),
        restoreIncarnationIsCurrent: (target) => this.host.restoreIncarnationIsCurrent(target),
        clearRestoreHealth: (target, reason) => this.seams.clearRestoreHealth(target, reason),
        markHealth: (deviceId, incarnation, reason) =>
          this.host.deviceHealth?.markers.mark(deviceId, incarnation, reason),
        clearHealthMarker: (deviceId, incarnation, reason) =>
          this.host.deviceHealth?.markers.clear(deviceId, incarnation, reason),
        waitForIdentityReplacement: (deviceId, generation) =>
          this.host.waitForIdentityReplacement(deviceId, generation),
        abandonRestore: (target, reason, restore, restoreTimeoutMs) =>
          this.seams.abandonRestore(target, reason, restore, restoreTimeoutMs),
        sessionSetupsOf: (session) =>
          Array.from(this.host.sessionSetupPromises, (setup) =>
            setup.session === session ? setup.promise : null,
          ).filter((setup): setup is Promise<void> => setup !== null),
        waitForSessionSetup: (sessionId, setups, phase) =>
          this.host.waitForSessionSetup(sessionId, setups, phase),
        noteTeardownBound: (bounded, settlesBy) =>
          this.host.deviceCleanupQuarantine.noteTeardownBound(bounded, settlesBy),
        trackPendingDeviceCleanup: (deviceId, cleanups) =>
          this.seams.trackPendingDeviceCleanup(deviceId, cleanups),
        isAdmittedForAutomation: (session) => this.host.isAdmittedForAutomation(session),
        sessionNow: () => this.host.sessionNow(),
        registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
          this.host.registerPendingDeviceCleanup(deviceId, cleanup, capMs),
      },
      {
        keepScreenAwake,
        biometricEnrollment,
        networkCondition: resolved.networkCondition,
        screenReader: resolved.screenReader,
        screenReaderBackoff: resolved.screenReaderBackoff,
        rotation: resolved.rotation,
        rotationBackoff: resolved.rotationBackoff,
        clock: resolved.clock,
        iosAppNetworkRuleRestorer: resolved.iosAppNetworkRule,
        defaultIosAppNetworkRuleRestorer,
        iosLease: {
          leaseMs: IOS_APP_NETWORK_RULE_LEASE_MS,
          renewIntervalMs: IOS_APP_NETWORK_RULE_RENEW_INTERVAL_MS,
        },
      },
    );
  }
  createRecoveredIntents(timer: Timer) {
    return new RecoveredTerminalReleaseIntents({
      terminalReleaseJournal: () => this.host.terminalReleaseJournal,
      setJournal: (journal) => {
        this.seams.setJournal(journal);
      },
      daemonSessionId: () => this.host.daemonSessionId,
      liveDaemonSessionIds: () => this.host.liveDaemonSessionIds?.bind(this),
      sessionSlots: () => this.host.sessionSlots,
      deviceSessionRepository: () => this.host.deviceSessionRepository,
      timer,
      sessionNow: () => this.host.sessionNow(),
      wallToSessionClock: (at) => this.host.wallToSessionClock(at),
      checkSlotShadow: (sessionId, event) => this.host.slotShadowProbe.check(sessionId, event),
      liftTerminalFence: (uuid, resolved, retainFence) =>
        this.host.liftTerminalFence(uuid, resolved, retainFence),
    });
  }
  createForcedStuckRelease(timer: Timer) {
    return new ForcedStuckRelease({
      sessionSlots: () => this.host.sessionSlots,
      removeSession: (sessionId, expectedSession) =>
        this.host.removeSession(sessionId, expectedSession),
      notifySessionRelease: (snapshot, options) =>
        this.host.notifySessionRelease(snapshot, options),
      managedExecutionReleaseMarker,
      restartReleasePersistence: () => this.host.restartReleasePersistence,
      registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
        this.host.registerPendingDeviceCleanup(deviceId, cleanup, capMs),
      persistSessionRelease: (snapshot) => this.host.persistSessionRelease(snapshot),
      scheduleTerminalReleaseRetry: (snapshot) => this.host.scheduleTerminalReleaseRetry(snapshot),
      trackReleaseDrainWrite: (write) => this.host.trackReleaseDrainWrite(write),
      retryNonTerminalRowAfterRelease: (snapshot) =>
        this.host.retryNonTerminalRowAfterRelease(snapshot),
      releaseRowSessions: () => this.host.releaseRowSessions,
      captureReleaseRowGeneration: (snapshot, generation) =>
        this.host.captureReleaseRowGeneration(snapshot, generation),
      persistedRowGenerations: () => this.host.persistedRowGenerations,
      volatileTerminalReleaseIntents: () => this.host.volatileTerminalReleaseIntents,
      terminalReleaseJournal: () => this.host.terminalReleaseJournal,
      rowWriter: () => this.host.rowWriter,
      timer,
      sessionNow: () => this.host.sessionNow(),
    });
  }
  createLiveness() {
    return new SessionLivenessController({
      getSession: (sessionId) => this.host.getSession(sessionId),
      peekSession: (sessionId) => this.host.peekSession(sessionId),
      unlessBaseEnded: (session) => this.host.unlessBaseEnded(session),
      isAdmittedForAutomation: (session) => this.host.isAdmittedForAutomation(session),
      sessionNow: () => this.host.sessionNow(),
      ownershipSessionUuid: (sessionId) => this.host.ownershipSessionUuid(sessionId),
      livenessOwnerView: (session) => this.seams.livenessOwnerView(session),
      hasUnissuedActivity: (session) => this.seams.hasUnissuedActivity(session),
      recordSessionActivity: (session) => this.host.recordSessionActivity(session),
      getBarrier: () => this.seams.getBarrier(),
      recordLivenessOwnership: (sessionId, ownerToken) =>
        this.host.deviceSessionRepository.recordLivenessOwnership(sessionId, ownerToken),
      replaceLivenessOwnership: (sessionId, ownerToken) =>
        this.host.deviceSessionRepository.replaceLivenessOwnership(sessionId, ownerToken),
      defaultHeartbeatTimeoutMs: () => getDefaultSessionHeartbeatTimeoutMs(),
    });
  }
}

const DEFAULT_SCREEN_READER_RESTORE_BACKOFF = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});
let DEFAULT_ROTATION_RESTORE_BACKOFF: BackoffPolicy | undefined;
