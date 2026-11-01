import type { SessionDeviceReboundEmitter } from "./sessionDeviceReboundBroadcast";
import type { Session } from "./sessionManager/sessionTypes";

import type * as Types from "./sessionManager/publicExports";
import type * as Lifecycle from "./sessionManager/internalContracts";
import type * as Rows from "../db/deviceSessionRepository";
export * from "./sessionManager/publicExports";
import { getDbWriteBarrier, type DbWriteBarrier } from "../db/dbWriteBarrier";
import { DeviceSessionRepository } from "../db/deviceSessionRepository";
import type { DeviceSession } from "../db/types";
import { type Platform } from "../models";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import { type BackoffPolicy } from "../utils/Backoff";
import { type KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import { logger } from "../utils/logger";
import { defaultTimer, SteadyWallClock, type Timer } from "../utils/SystemTimer";
import { DeviceCleanupQuarantine } from "./deviceCleanupQuarantine";
import type { DeviceHealthReason } from "./deviceHealthMarkers";
import type { LivenessOwnerView } from "./livenessClaimDecision";
import { NoopTerminalReleaseJournal } from "./NoopTerminalReleaseJournal";
import { PlanLabelRegistry } from "./planLabelRegistry";
import { SessionReleasePersistTimeoutError } from "./releaseErrors";
import { type SessionReleaseReason } from "./releaseReasons";
import type { ReleaseSessionRequest } from "./releaseSessionRequest";
import { onSessionClock } from "./sessionClockPersistence";
import { SessionDeviceStateRestore } from "./sessionDeviceStateRestore";
import { SessionLivenessController } from "./sessionLivenessLease";
import * as livenessWindows from "./wire/sessionLivenessWindows";
import { SessionManagerCleanup } from "./sessionManager/cleanup";
import { SessionManagerConfiguration } from "./sessionManager/configuration";
import { SessionManagerConstruction } from "./sessionManager/construction";
import { ForcedStuckRelease } from "./sessionManager/forcedStuckRelease";
import {
  SessionManagerForwarders,
  type SessionManagerForwardersHost,
} from "./sessionManager/forwarders";
import { SessionQueries } from "./sessionManager/queries";
import { RecoveredTerminalReleaseIntents } from "./sessionManager/recoveredTerminalReleaseIntents";
import { DeviceRestoreHealth } from "./sessionManager/restoreHealth";
import * as budgets from "./sessionManager/sessionConstants";
import { SessionManagerWiring } from "./sessionManager/wiring";
import type { ReleaseRowRetry } from "./sessionRowWriter";
import { SerializedSessionRowWriter, type SessionRowWriter } from "./sessionRowWriter";
import { SessionSlots } from "./sessionSlots";
import { SessionSlotShadowProbe, type SlotShadowProbeMode } from "./sessionSlotShadowProbe";
import type * as Reasserts from "./supersededRowReasserts";
import { type TerminalReleaseJournal } from "./terminalReleaseJournal";

export class SessionManager extends SessionManagerForwarders {
  protected readonly forwardersHost = this.createForwardersHost();
  private createForwardersHost(): SessionManagerForwardersHost {
    const manager = this;
    return {
      get rowWriter() {
        return manager.rowWriter;
      },
      get configuration() {
        return manager.configuration;
      },
      get recoveredIntents() {
        return manager.recoveredIntents;
      },
      get restoreHealth() {
        return manager.wiring.restoreHealth;
      },
      get sessionClock() {
        return manager.sessionClock;
      },
      get callbacks() {
        return manager.wiring.callbacks;
      },
      get deviceCleanupQuarantine() {
        return manager.deviceCleanupQuarantine;
      },
      get bookkeeping() {
        return manager.wiring.bookkeeping;
      },
      get forcedStuckRelease() {
        return manager.forcedStuckRelease;
      },
      get activityClocks() {
        return manager.wiring.activityClocks;
      },
      get creationGuard() {
        return manager.wiring.creationGuard;
      },
      get persistedAdmission() {
        return manager.wiring.persistedAdmission;
      },
      get admission() {
        return manager.wiring.admission;
      },
      get leaseExpiry() {
        return manager.wiring.leaseExpiry;
      },
      get acquisition() {
        return manager.wiring.acquisition;
      },
      get rehydration() {
        return manager.wiring.rehydration;
      },
      get rebinding() {
        return manager.wiring.rebinding;
      },
      get queries() {
        return manager.queries;
      },
      get slotShadowProbe() {
        return manager.slotShadowProbe;
      },
      get releaseRequests() {
        return manager.wiring.releaseRequests;
      },
      get stateRestore() {
        return manager.stateRestore;
      },
      get cache() {
        return manager.wiring.cache;
      },
      get planLabelsLifecycle() {
        return manager.wiring.planLabelsLifecycle;
      },
      get liveness() {
        return manager.liveness;
      },
      get cleanup() {
        return manager.cleanup;
      },
    };
  }
  private waitOutRebindOf(session: Session): Promise<void> {
    return this.wiring.supersededRows.waitOutRebindOf(session);
  }

  private waitOutReleaseOf(sessionId: string): Promise<void> {
    return this.wiring.supersededRows.waitOutReleaseOf(sessionId);
  }

  private waitOutRecreationOf(sessionId: string): Promise<void> {
    return this.wiring.supersededRows.waitOutRecreationOf(sessionId);
  }
  private readonly configuration = new SessionManagerConfiguration();
  private get stallProbe() {
    return this.configuration.stallProbe;
  }
  private set stallProbe(value: SessionManagerConfiguration["stallProbe"]) {
    this.configuration.stallProbe = value;
  }
  private get daemonSessionId() {
    return this.configuration.daemonSessionId;
  }
  private set daemonSessionId(value: SessionManagerConfiguration["daemonSessionId"]) {
    this.configuration.daemonSessionId = value;
  }
  private get liveDaemonSessionIds() {
    return this.configuration.liveDaemonSessionIds;
  }
  private set liveDaemonSessionIds(value: SessionManagerConfiguration["liveDaemonSessionIds"]) {
    this.configuration.liveDaemonSessionIds = value;
  }
  private get acceptingSessionCreations() {
    return this.configuration.acceptingSessionCreations;
  }
  private set acceptingSessionCreations(
    value: SessionManagerConfiguration["acceptingSessionCreations"],
  ) {
    this.configuration.acceptingSessionCreations = value;
  }
  private get observerSessions() {
    return this.configuration.observerSessions;
  }
  private set observerSessions(value: SessionManagerConfiguration["observerSessions"]) {
    this.configuration.observerSessions = value;
  }
  private get activeSessionExecutionChecker() {
    return this.configuration.activeSessionExecutionChecker;
  }
  private set activeSessionExecutionChecker(
    value: SessionManagerConfiguration["activeSessionExecutionChecker"],
  ) {
    this.configuration.activeSessionExecutionChecker = value;
  }
  private get livenessOwnerCallInFlightReader() {
    return this.configuration.livenessOwnerCallInFlightReader;
  }
  private set livenessOwnerCallInFlightReader(
    value: SessionManagerConfiguration["livenessOwnerCallInFlightReader"],
  ) {
    this.configuration.livenessOwnerCallInFlightReader = value;
  }
  private get ownerConnectedAtReader() {
    return this.configuration.ownerConnectedAtReader;
  }
  private set ownerConnectedAtReader(value: SessionManagerConfiguration["ownerConnectedAtReader"]) {
    this.configuration.ownerConnectedAtReader = value;
  }
  private get sessionExecutionDeadlineLookup() {
    return this.configuration.sessionExecutionDeadlineLookup;
  }
  private set sessionExecutionDeadlineLookup(
    value: SessionManagerConfiguration["sessionExecutionDeadlineLookup"],
  ) {
    this.configuration.sessionExecutionDeadlineLookup = value;
  }
  private get expiryReleaseExecutionCanceller() {
    return this.configuration.expiryReleaseExecutionCanceller;
  }
  private set expiryReleaseExecutionCanceller(
    value: SessionManagerConfiguration["expiryReleaseExecutionCanceller"],
  ) {
    this.configuration.expiryReleaseExecutionCanceller = value;
  }
  private get deviceAcquisitionExecutionCanceller() {
    return this.configuration.deviceAcquisitionExecutionCanceller;
  }
  private set deviceAcquisitionExecutionCanceller(
    value: SessionManagerConfiguration["deviceAcquisitionExecutionCanceller"],
  ) {
    this.configuration.deviceAcquisitionExecutionCanceller = value;
  }
  private get recoveryExpiryReleaseHandler() {
    return this.configuration.recoveryExpiryReleaseHandler;
  }
  private set recoveryExpiryReleaseHandler(
    value: SessionManagerConfiguration["recoveryExpiryReleaseHandler"],
  ) {
    this.configuration.recoveryExpiryReleaseHandler = value;
  }
  private get managedExecutionRecoveryListener() {
    return this.configuration.managedExecutionRecoveryListener;
  }
  private set managedExecutionRecoveryListener(
    value: SessionManagerConfiguration["managedExecutionRecoveryListener"],
  ) {
    this.configuration.managedExecutionRecoveryListener = value;
  }
  private get lateRehydrationListener() {
    return this.configuration.lateRehydrationListener;
  }
  private set lateRehydrationListener(
    value: SessionManagerConfiguration["lateRehydrationListener"],
  ) {
    this.configuration.lateRehydrationListener = value;
  }
  private get releaseDeviceHold() {
    return this.configuration.releaseDeviceHold;
  }
  private set releaseDeviceHold(value: SessionManagerConfiguration["releaseDeviceHold"]) {
    this.configuration.releaseDeviceHold = value;
  }
  private readonly wiring = this.createCollaboratorHost();
  private readonly queries = new SessionQueries(this.wiring.host, {
    getAllSessions: () => this.getAllSessions(),
    getAssignedDevices: () => this.getAssignedDevices(),
  });
  private readonly cleanup = this.createCleanup();
  private createCleanup(): SessionManagerCleanup {
    const manager = this;
    return new SessionManagerCleanup(this.wiring.host, {
      get CLEANUP_INTERVAL_MS() {
        return manager.CLEANUP_INTERVAL_MS;
      },
      cleanupExpiredSessions: () => this.cleanupExpiredSessions(),
      get rehydrationFollowUpTimer() {
        return manager.rehydrationFollowUpTimer;
      },
      set rehydrationFollowUpTimer(value) {
        manager.rehydrationFollowUpTimer = value;
      },
    });
  }

  private createCollaboratorHost(): SessionManagerWiring {
    const dependencies = {
      stateRestore: () => this.stateRestore,
      timer: () => this.timer,
      acceptingSessionCreations: () => this.acceptingSessionCreations,
      deviceSessionRepository: () => this.deviceSessionRepository,
      recoveredIntents: () => this.recoveredIntents,
      getBarrier: () => this.getBarrier?.bind(this),
      sessionSlots: () => this.sessionSlots,
      daemonSessionId: () => this.daemonSessionId,
      activeSessionExecutionChecker: () => this.activeSessionExecutionChecker?.bind(this),
      sessions: () => this.sessions,
      superseded: () => this.superseded,
      liveDaemonSessionIds: () => this.liveDaemonSessionIds?.bind(this),
      SESSION_TIMEOUT_MS: () => this.SESSION_TIMEOUT_MS,
      lateRehydrationListener: () => this.lateRehydrationListener,
      slotShadowProbe: () => this.slotShadowProbe,
      deviceHealth: () => this.deviceHealth,
      persistedRowGenerations: () => this.persistedRowGenerations,
      releaseRowGenerations: () => this.releaseRowGenerations,
      finalizedSessionReleases: () => this.finalizedSessionReleases,
      supersededRowReassertRetries: () => this.supersededRowReassertRetries,
      rowWriter: () => this.rowWriter,
      forcedStuckRelease: () => this.forcedStuckRelease,
      restartReleasePersistence: () => this.restartReleasePersistence,
      restartRecoveryActivityAt: () => this.restartRecoveryActivityAt,
      stallProbe: () => this.stallProbe?.bind(this),
      livenessOwnerCallInFlightReader: () => this.livenessOwnerCallInFlightReader,
      liveness: () => this.liveness,
      sessionExecutionDeadlineLookup: () => this.sessionExecutionDeadlineLookup?.bind(this),
      expiryReleaseExecutionCanceller: () => this.expiryReleaseExecutionCanceller?.bind(this),
      recoveryExpiryReleaseHandler: () => this.recoveryExpiryReleaseHandler,
      releaseDeviceHold: () => this.releaseDeviceHold,
      planLabels: () => this.planLabels,
      observerSessions: () => this.observerSessions,
      deviceSessionMap: () => this.deviceSessionMap,
      releaseRowSessions: () => this.releaseRowSessions,
      replacedRestoreGenerations: () => this.replacedRestoreGenerations,
      volatileTerminalReleaseIntents: () => this.volatileTerminalReleaseIntents,
      retiredCreationRows: () => this.retiredCreationRows,
      terminalReleaseJournal: () => this.terminalReleaseJournal,
      leaseExpiry: () => this.wiring.leaseExpiry,
      sessionSetupPromises: () => this.sessionSetupPromises,
      deviceCleanupQuarantine: () => this.deviceCleanupQuarantine,
      releaseCallbacks: () => this.releaseCallbacks,
      sessionDeviceReboundEmitter: () => this.sessionDeviceReboundEmitter,
      deviceOwnershipCallbacks: () => this.deviceOwnershipCallbacks,
      createdCallbacks: () => this.createdCallbacks,
      deviceUnboundCallbacks: () => this.deviceUnboundCallbacks,
      managedExecutionRecoveryListener: () => this.managedExecutionRecoveryListener?.bind(this),
      managedExecutionRecoveries: () => this.managedExecutionRecoveries,
      deferredAcquisitionCancellations: () => this.deferredAcquisitionCancellations,
      deviceAcquisitionExecutionCanceller: () =>
        this.deviceAcquisitionExecutionCanceller.bind(this),
      ownerConnectedAtReader: () => this.ownerConnectedAtReader,
      identityReplacementFences: () => this.identityReplacementFences,
      activeRestoreControllers: () => this.activeRestoreControllers,
    };
    const wiring = new SessionManagerWiring(
      {
        expireIfDue: (...args) => this.expireIfDue(...args),
        finishReleaseForcedBeforeStart: (...args) => this.finishReleaseForcedBeforeStart(...args),
        liftTerminalFence: (...args) => this.liftTerminalFence(...args),
        retireRestorations: (...args) => this.retireRestorations(...args),
        withReleaseReason: (...args) => this.withReleaseReason(...args),
        persistAndPublishSession: (...args) => this.persistAndPublishSession(...args),
        isSessionExpired: (...args) => this.isSessionExpired(...args),
        recordSessionActivity: (...args) => this.recordSessionActivity(...args),
        getSessionForNewExecution: (...args) => this.getSessionForNewExecution(...args),
        refuseControlCallOnLapsedOwnerLease: (...args) =>
          this.refuseControlCallOnLapsedOwnerLease(...args),
        peekTerminalAnswerForEndedSession: (...args) =>
          this.peekTerminalAnswerForEndedSession(...args),
        releaseSessionPastIdleDeadline: (...args) => this.releaseSessionPastIdleDeadline(...args),
        liveBaseOfDerivedId: (...args) => this.liveBaseOfDerivedId(...args),
        retryPendingTerminalReleasesNow: (...args) => this.retryPendingTerminalReleasesNow(...args),
        getPendingDeviceCleanup: (...args) => this.getPendingDeviceCleanup(...args),
        armPendingDeviceCleanupCaps: (...args) => this.armPendingDeviceCleanupCaps(...args),
        cancelExecutionsOverriddenByExpiry: (...args) =>
          this.cancelExecutionsOverriddenByExpiry(...args),
        getSession: (...args) => this.getSession(...args),
        getTerminalReleaseSnapshot: (...args) => this.getTerminalReleaseSnapshot(...args),
        waitForSessionSetup: (...args) => this.waitForSessionSetup(...args),
        restoreIncarnationIsCurrent: (...args) => this.restoreIncarnationIsCurrent(...args),
        waitForIdentityReplacement: (...args) => this.waitForIdentityReplacement(...args),
        isTerminalReleaseRetryCurrent: (...args) => this.isTerminalReleaseRetryCurrent(...args),
        retryTerminalReleaseWrite: (...args) => this.retryTerminalReleaseWrite(...args),
        dispatchDeviceRestore: (...args) => this.dispatchDeviceRestore(...args),
        sessionNow: (...args) => this.sessionNow(...args),
        isSessionBeingRecreated: (...args) => this.isSessionBeingRecreated(...args),
        sessionClockToWall: (...args) => this.sessionClockToWall(...args),
        persistSessionRelease: (...args) => this.persistSessionRelease(...args),
        recoverPersistedRow: (...args) => this.recoverPersistedRow(...args),
        recoveredRowOwner: (...args) => this.recoveredRowOwner(...args),
        recoveryLivenessFromPersisted: (...args) => this.recoveryLivenessFromPersisted(...args),
        applyRecoveredTerminalReleaseIntents: (...args) =>
          this.applyRecoveredTerminalReleaseIntents(...args),
        createSession: (...args) => this.createSession(...args),
        rebindSession: (...args) => this.rebindSession(...args),
        flushDeferredRebindCleanups: (...args) => this.flushDeferredRebindCleanups(...args),
        trackReleaseDrainWrite: (...args) => this.trackReleaseDrainWrite(...args),
        getSessionForDevice: (...args) => this.getSessionForDevice(...args),
        trackPendingTeardownCleanup: (...args) => this.trackPendingTeardownCleanup(...args),
        registerPendingDeviceCleanup: (...args) => this.registerPendingDeviceCleanup(...args),
        isCurrentSession: (...args) => this.isCurrentSession(...args),
        persistSession: (...args) => this.persistSession(...args),
        scheduleTerminalReleaseRetry: (...args) => this.scheduleTerminalReleaseRetry(...args),
        recordPendingNonTerminalRelease: (...args) => this.recordPendingNonTerminalRelease(...args),
        getLegacyLifecycleView: (...args) => this.getLegacyLifecycleView(...args),
        isAdmittedForAutomation: (...args) => this.isAdmittedForAutomation(...args),
        cancelExecutionsCutByRelease: (...args) => this.cancelExecutionsCutByRelease(...args),
        releaseSessionForReason: (...args) => this.releaseSessionForReason(...args),
        releaseSession: (...args) => this.releaseSession(...args),
        deviceHeldForLateRead: (...args) => this.deviceHeldForLateRead(...args),
        unlessBaseEnded: (...args) => this.unlessBaseEnded(...args),
        wallToSessionClock: (...args) => this.wallToSessionClock(...args),
        peekSession: (...args) => this.peekSession(...args),
        judgedLeaseHeartbeat: (...args) => this.judgedLeaseHeartbeat(...args),
        ownershipSessionUuid: (...args) => this.ownershipSessionUuid(...args),
        getBaseSessionOfDerivedLabel: (...args) => this.getBaseSessionOfDerivedLabel(...args),
        getReleasingSession: (...args) => this.getReleasingSession(...args),
        findSession: (...args) => this.findSession(...args),
        updateSessionCache: (...args) => this.updateSessionCache(...args),
        getDeviceReadiness: (...args) => this.getDeviceReadiness(...args),
        invalidateAutomationReadiness: (...args) => this.invalidateAutomationReadiness(...args),
        getBiometricEnrollment: (...args) => this.getBiometricEnrollment(...args),
        getNetworkCondition: (...args) => this.getNetworkCondition(...args),
        recordRestartRecoveryActivity: (...args) => this.recordRestartRecoveryActivity(...args),
        getOrCreateSession: (...args) => this.getOrCreateSession(...args),
        terminalizeExpiredPersistedSession: (...args) =>
          this.terminalizeExpiredPersistedSession(...args),
      },
      dependencies,
    );
    return wiring;
  }
  private sessions: Map<string, Session> = new Map();
  private deviceSessionMap: Map<string, string> = new Map();
  private get rehydrationFollowUpTimer(): NodeJS.Timeout | null {
    return this.wiring.rehydration.rehydrationFollowUpTimer;
  }
  private set rehydrationFollowUpTimer(value: NodeJS.Timeout | null) {
    this.wiring.rehydration.rehydrationFollowUpTimer = value;
  }

  private timer: Timer;
  /** The clock every session timestamp is stamped and judged with (#11080); see {@link sessionNow}. */
  private readonly sessionClock: SteadyWallClock;
  private sessionDeviceReboundEmitter: SessionDeviceReboundEmitter | undefined;
  private releaseCallbacks: Types.SessionReleaseCallback[] = [];
  private readonly restartReleasePersistence = new WeakMap<
    Types.SessionReleaseSnapshot,
    PromiseWithResolvers<void>
  >();
  private readonly planLabels = new PlanLabelRegistry({
    hasSession: (sessionId) => this.sessions.has(sessionId),
  });
  private createdCallbacks: Types.SessionCreatedCallback[] = [];
  private deviceUnboundCallbacks: Types.SessionDeviceUnboundCallback[] = [];
  private readonly deviceOwnershipCallbacks = new Set<
    (deviceId: string, frameInvalidation: "generation-only" | "full") => void
  >();
  private rowWriter: SessionRowWriter;
  /** Crash-safe sidecar of terminal releases whose row write has not landed (#10959). */
  private terminalReleaseJournal: TerminalReleaseJournal = new NoopTerminalReleaseJournal();
  private readonly volatileTerminalReleaseIntents = new Map<string, string>();
  /** Finalized release state retained only while its exact Session identity is referenced. */
  private readonly finalizedSessionReleases: WeakMap<Session, Lifecycle.ReleaseReasonState> =
    new WeakMap();
  /** The liveness owner lease and policy changes; its claim mutex serializes one session incarnation (#11797). */
  private readonly liveness: SessionLivenessController;
  private readonly recoveredIntents: RecoveredTerminalReleaseIntents;
  private readonly forcedStuckRelease: ForcedStuckRelease;
  private get persistedRowGenerations(): WeakMap<Session, number> {
    return this.wiring.activityPersistence.persistedRowGenerations;
  }

  private get retiredCreationRows(): WeakSet<Session> {
    return this.wiring.creation.retiredCreationRows;
  }

  private get releaseRowGenerations(): WeakMap<Types.SessionReleaseSnapshot, number> {
    return this.wiring.releasePersistence.releaseRowGenerations;
  }

  private get releaseRowSessions(): WeakMap<Types.SessionReleaseSnapshot, WeakRef<Session>> {
    return this.wiring.releasePersistence.releaseRowSessions;
  }

  /** Setup work that can modify device state after a session has been assigned. */
  private readonly sessionSetupPromises: Set<{
    session: Session;
    promise: Promise<void>;
  }> = new Set();
  /**
   * Device work that outlived its bounded release phase. The pool keeps the device assigned until
   * this settles, so no replacement session can race a late setup or keep-awake restore.
   */
  private readonly deviceCleanupQuarantine: DeviceCleanupQuarantine;
  private readonly sessionSlots: Lifecycle.SessionLifecycleSlots = new SessionSlots({
    rowPending: { pending: (uuid) => this.rowWriter.pending(uuid) },
    onFinalizedIdentityCollected: (uuid) => this.slotShadowProbe.transitionGuard.forget(uuid),
  });
  private get restartRecoveryActivityAt(): Map<string, number> {
    return this.wiring.persistedAdmission.restartRecoveryActivityAt;
  }

  /** Row policy of an owed superseded-row rewrite; the writer's ledger schedules it (#11799). */
  private readonly supersededRowReassertRetries: Reasserts.OwedSupersededRowReassertCallbacks = {
    retry: (entry) => this.wiring.supersededRows.retryOwedSupersededRowReassert(entry),
    retryDuringDrain: (entry) =>
      this.wiring.supersededRows.retryOwedSupersededRowReassertDuringDrain(entry),
  };
  private deviceSessionRepository: Rows.DeviceSessionPersistence;
  private readonly getBarrier: () => DbWriteBarrier;
  private readonly stateRestore: SessionDeviceStateRestore;

  /** Retry delays for a live row's rewrite after an overlapping row write (#11557). */
  setSupersededRowReassertBackoff(backoff: BackoffPolicy): void {
    this.superseded.setBackoff(backoff);
  }

  /** Superseded-row rewrite state, held by the row writer (#11799 W3). */
  private get superseded(): Reasserts.SupersededRowReasserts {
    return this.rowWriter.superseded;
  }

  private recoveredRowOwner(): string | null {
    return this.configuration.recoveredRowOwner();
  }

  /**
   * Record the name a client registered for an existing device session (#10671). Diagnostic
   * only: it feeds `holderKind` and never changes ownership, liveness or deadlines.
   */
  recordSessionClientName(sessionId: string, clientName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientName = clientName;
    }
  }
  private get deviceHealth() {
    return this.wiring.restoreHealth.deviceHealth;
  }
  private set deviceHealth(value: DeviceRestoreHealth["deviceHealth"]) {
    this.wiring.restoreHealth.deviceHealth = value;
  }

  private get identityReplacementFences() {
    return this.wiring.restoreHealth.identityReplacementFences;
  }

  private get replacedRestoreGenerations(): Map<string, number> {
    return this.wiring.restoreHealth.replacedRestoreGenerations;
  }

  private get activeRestoreControllers(): Map<string, Set<AbortController>> {
    return this.wiring.restoreHealth.activeRestoreControllers;
  }

  private waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean> {
    return this.wiring.restoreHealth.waitForIdentityReplacement(deviceId, generation);
  }
  private dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation = this.replacedRestoreGenerations.get(deviceId) ?? 0,
    teardownStep?: number,
  ): Promise<void> {
    return this.wiring.recoveryPublication.dispatchDeviceRestore(
      deviceId,
      restore,
      generation,
      teardownStep,
    );
  }

  private restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean {
    return this.wiring.restoreHealth.restoreIncarnationIsCurrent(target);
  }

  private clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void {
    return this.wiring.restoreHealth.clearRestoreHealth(target, reason);
  }

  private abandonRestore(
    target: { deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs: number = budgets.NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  ): void {
    return this.wiring.restoreHealth.abandonRestore(target, reason, restore, restoreTimeoutMs);
  }
  // Session ids whose acquisition cancellation waits for the pool to commit the create (#10905):
  // a create can still be refused or rolled back after publish. Value: the device it published.
  private readonly deferredAcquisitionCancellations = new Map<string, string | undefined>();

  // Idle window (heartbeats, no tool call): 2 minutes from the end of the last
  // tool call, env-overridable (see `./wire/sessionLivenessWindows`).
  private readonly SESSION_TIMEOUT_MS = livenessWindows.getSessionIdleTimeoutMs();

  // Cleanup interval: every 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  static readonly DEFAULT_HEARTBEAT_TIMEOUT_MS =
    livenessWindows.DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS;

  constructor(
    timer: Timer = defaultTimer,
    deviceSessionRepository: Rows.DeviceSessionPersistence = new DeviceSessionRepository({ timer }),
    options: Types.SessionManagerOptions = {},
  ) {
    super();

    const construction = new SessionManagerConstruction(this.wiring.host, {
      trackSessionSetup: (...args) => this.trackSessionSetup(...args),
      clearRestoreHealth: (...args) => this.clearRestoreHealth(...args),
      abandonRestore: (...args) => this.abandonRestore(...args),
      trackPendingDeviceCleanup: (...args) => this.trackPendingDeviceCleanup(...args),
      livenessOwnerView: (...args) => this.livenessOwnerView(...args),
      hasUnissuedActivity: (...args) => this.hasUnissuedActivity(...args),
      getBarrier: () => this.getBarrier(),
      setJournal: (journal) => {
        this.terminalReleaseJournal = journal;
      },
    });

    this.timer = timer;
    this.sessionDeviceReboundEmitter = options.sessionDeviceReboundEmitter;
    this.sessionClock = new SteadyWallClock(timer);
    this.deviceCleanupQuarantine = construction.createDeviceCleanupQuarantine(timer);
    // Rows are read by other processes on their own session clocks: stamps cross as wall ms (#11162).
    this.deviceSessionRepository = onSessionClock(deviceSessionRepository, {
      toWall: (sessionClockMs) => this.sessionClockToWall(sessionClockMs),
      toSessionClock: (wallMs) => this.wallToSessionClock(wallMs),
    });
    this.rowWriter = SerializedSessionRowWriter.create({
      persistence: this.deviceSessionRepository,
      timer,
      backoff: budgets.DEFAULT_TERMINAL_RELEASE_RETRY_BACKOFF,
      logger,
      timeoutMs: budgets.SESSION_RELEASE_PERSIST_TIMEOUT_MS,
      timeoutError: SessionReleasePersistTimeoutError,
    });
    this.getBarrier = options.barrier ?? getDbWriteBarrier;

    this.stateRestore = construction.createStateRestore(timer, options);
    this.recoveredIntents = construction.createRecoveredIntents(timer);
    this.forcedStuckRelease = construction.createForcedStuckRelease(timer);
    this.liveness = construction.createLiveness();

    // Start periodic cleanup of expired sessions
    this.startCleanupTimer();
  }

  /** Inject before creating sessions or scheduling release writes. */
  setRowWriter(writer: SessionRowWriter): void {
    this.rowWriter = writer;
  }

  /** Reuse the injected Timer for fake-clock readiness, retry and backoff waits (#7541). */
  getTimer(): Timer {
    return this.timer;
  }

  /**
   * An instant on the session clock as wall-clock epoch ms, for reporting to other processes
   * (#11105): wall now + (instant - session now). Differs from the stamp only after a wall step.
   * This is the exact frame conversion that persisted stamps cross with (paired with
   * {@link wallToSessionClock}); values shown to a client use {@link sessionClockToReportedWall}.
   */
  sessionClockToWall(sessionClockMs: number): number {
    return this.timer.now() + (sessionClockMs - this.sessionNow());
  }

  /**
   * A wall-clock epoch ms instant (a persisted stamp, another process's report) on the session
   * clock: the inverse of {@link sessionClockToWall} (#11162).
   */
  wallToSessionClock(wallMs: number): number {
    return this.sessionNow() + (wallMs - this.timer.now());
  }

  /** Wait for the device work that outlived release, without blocking shutdown indefinitely. */
  async drainPendingDeviceCleanups(timeoutMs: number): Promise<boolean> {
    this.flushDeferredRebindCleanups();
    return await this.deviceCleanupQuarantine.drain(timeoutMs);
  }

  private armPendingDeviceCleanupCaps(deviceId: string): void {
    this.deviceCleanupQuarantine.armCaps(deviceId);
  }

  /**
   * A release forced while it waited to start (#10963): the device may already belong to the next
   * owner, so no teardown may touch it. The force itself persists the fence it raised (#11058).
   */
  private async finishReleaseForcedBeforeStart(session: Session): Promise<null> {
    this.sessionSlots.unmarkReleasing(session);
    return null;
  }
  private readonly managedExecutionRecoveries = new Map<string, PromiseWithResolvers<void>>();

  private persistAndPublishSession(
    session: Session,
    creation?: Lifecycle.PendingSessionCreation,
    claimedRow?: Lifecycle.ClaimedCreationRow,
    signal?: AbortSignal,
  ): Promise<Session> {
    return this.wiring.creation.persistAndPublishSession(session, creation, claimedRow, signal);
  }

  private recordRestartRecoveryActivity(sessionId: string): void {
    return this.wiring.persistedAdmission.recordRestartRecoveryActivity(sessionId);
  }

  private terminalizeExpiredPersistedSession(
    persisted: DeviceSession | undefined,
    onlyIfOwnedByDaemon?: string,
  ): Promise<DeviceSession | undefined> {
    return this.wiring.persistedAdmission.terminalizeExpiredPersistedSession(
      persisted,
      onlyIfOwnedByDaemon,
    );
  }

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    return this.expireIfDue(sessionId, false);
  }
  private expireIfDue(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: Types.SessionExecutionMetadata,
    releaseExpired = true,
  ): Session | null {
    return this.wiring.leaseExpiry.expireIfDue(
      sessionId,
      expireDespiteActiveExecution,
      execution,
      releaseExpired,
    );
  }

  private releaseSessionPastIdleDeadline(sessionId: string, callerExecutionId?: string): void {
    return this.wiring.leaseExpiry.releaseSessionPastIdleDeadline(sessionId, callerExecutionId);
  }
  private recoverPersistedRow(
    sessionId: string,
    devicePool: Types.SessionDeviceAssigner,
    platform: Platform | undefined,
    recovery: Lifecycle.PersistedSessionRecovery & { persisted?: DeviceSession },
  ): Promise<Session> {
    return this.wiring.recoveryPublication.recoverPersistedRow(
      sessionId,
      devicePool,
      platform,
      recovery,
    );
  }

  private reserveDevicesForRehydration(
    persistedSessions: readonly DeviceSession[],
    devicePool: Types.SessionDeviceAssigner,
    deadlineAt: number,
  ): Promise<void> {
    return this.wiring.rehydration.reserveDevicesForRehydration(
      persistedSessions,
      devicePool,
      deadlineAt,
    );
  }

  private releaseRehydrationReservation(
    sessionId: string,
    devicePool: Types.SessionDeviceAssigner,
  ): void {
    return this.wiring.rehydration.releaseRehydrationReservation(sessionId, devicePool);
  }

  private readonly slotShadowProbe = new SessionSlotShadowProbe(
    () => this.getLegacyLifecycleView(),
    undefined,
    logger,
    (uuid) => this.sessionSlots.notifySettled(uuid),
  );
  setSlotShadowProbeMode(mode: SlotShadowProbeMode): void {
    this.slotShadowProbe.mode = mode;
  }

  private releaseSessionForReason(
    sessionId: string,
    releaseReason: string,
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    return this.wiring.releaseRequests.releaseSessionForReason(sessionId, releaseReason, request);
  }

  private trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void {
    this.deviceCleanupQuarantine.trackTeardown(deviceId, cleanups);
  }
  private withReleaseReason(
    snapshot: Types.SessionReleaseSnapshot,
    releaseReason: string,
    session?: Session,
  ): Types.SessionReleaseSnapshot {
    return this.wiring.releaseCommit.withReleaseReason(snapshot, releaseReason, session);
  }
  private persistSessionRelease(
    snapshot: Types.SessionReleaseSnapshot,
    retryPending: boolean = false,
    statementConditions?: Rows.MarkReleasedOptions,
  ): Promise<boolean> {
    return this.wiring.releaseWrite.persistSessionRelease(
      snapshot,
      retryPending,
      statementConditions,
    );
  }

  private liftTerminalFence(
    uuid: string,
    resolved?: Pick<Types.SessionReleaseSnapshot, "releaseReason">,
    retainFence = false,
    afterDelete?: () => void,
  ): void {
    return this.wiring.releasePersistence.liftTerminalFence(
      uuid,
      resolved,
      retainFence,
      afterDelete,
    );
  }

  private scheduleTerminalReleaseRetry(snapshot: Types.SessionReleaseSnapshot): void {
    return this.wiring.releasePersistence.scheduleTerminalReleaseRetry(snapshot);
  }

  private trackReleaseDrainWrite(write: Promise<void>): void {
    return this.wiring.releasePersistence.trackReleaseDrainWrite(write);
  }

  private isTerminalReleaseRetryCurrent(snapshot: Types.SessionReleaseSnapshot): boolean {
    return this.wiring.releasePersistence.isTerminalReleaseRetryCurrent(snapshot);
  }

  private retryTerminalReleaseWrite(entry: ReleaseRowRetry): Promise<void> {
    return this.wiring.releasePersistence.retryTerminalReleaseWrite(entry);
  }

  private retriedReleaseWritePrecondition(
    snapshot: Types.SessionReleaseSnapshot,
  ): Promise<Rows.MarkReleasedOptions> {
    return this.wiring.releasePersistence.retriedReleaseWritePrecondition(snapshot);
  }

  private retryPendingTerminalReleasesNow(): Promise<void>[] {
    return this.wiring.releasePersistence.retryPendingTerminalReleasesNow();
  }

  private isSessionBeingRecreated(sessionId: string): boolean {
    return this.wiring.releasePersistence.isSessionBeingRecreated(sessionId);
  }

  private recordPendingNonTerminalRelease(snapshot: Types.SessionReleaseSnapshot): void {
    return this.wiring.releasePersistence.recordPendingNonTerminalRelease(snapshot);
  }
  private waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase: "release" | "rebind" = "release",
  ): Promise<{ pending: Promise<void> | null }> {
    return this.wiring.bookkeeping.waitForSessionSetup(sessionId, setups, phase);
  }

  /**
   * Retire every restore queue the cause applies to: removal retires all kinds; a VM restore
   * (incarnation bump) retires the kinds whose policy says so, today the clock only (#11794).
   * No retries may target a replacement device.
   */
  retireRestorations(deviceId: string, cause: "removal" | "incarnation-bump"): void {
    for (const queue of [
      this.stateRestore.clockRestores,
      this.stateRestore.rotationRestores,
      this.stateRestore.screenReaderRestores,
    ]) {
      if (cause === "removal" || queue.policy.retiredOnIncarnationBump) {
        queue.retire(deviceId);
      }
    }
  }

  private trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void {
    this.deviceCleanupQuarantine.track(deviceId, cleanups);
  }
  updateSessionCache(sessionId: string, updates: Partial<Types.SessionCacheData>): void {
    return this.wiring.cache.updateSessionCache(sessionId, updates);
  }

  setLastHierarchy(sessionId: string, hierarchy: ViewHierarchyResult): void {
    return this.wiring.cache.setLastHierarchy(sessionId, hierarchy);
  }

  /**
   * Cache the keep-awake state applied for a session in the typed top-level
   * `keepScreenAwake` slot (issue #2973). `ToolExecutionContext` writes it once at
   * session setup; `restoreKeepScreenAwake` reads the same slot on release. Both
   * go through this typed slot rather than an untyped `customData` cast, so a
   * writer/reader type drift is a compile error (the #2917 bug class).
   */
  setKeepScreenAwake(sessionId: string, state: KeepScreenAwakeState): void {
    this.updateSessionCache(sessionId, { keepScreenAwake: state });
  }

  invalidateAutomationReadinessForDevice(deviceId: string, reason: string): void {
    return this.wiring.cache.invalidateAutomationReadinessForDevice(deviceId, reason);
  }

  resetDeviceReadinessForDevice(deviceId: string): void {
    return this.wiring.cache.resetDeviceReadinessForDevice(deviceId);
  }

  /**
   * Cache the device-label → session map for a multi-device session in the typed
   * top-level `deviceLabels` slot (issue #2973). Written by `registerDeviceLabelMap`
   * and read on the `device:`-label routing hot path (`resolveDeviceLabelSession`).
   */
  setDeviceLabels(sessionId: string, labels: Types.DeviceLabelMap): void {
    if (this.findSession(sessionId)) {
      this.planLabels.indexDerivedLabels(sessionId, labels);
    }
    this.updateSessionCache(sessionId, { deviceLabels: labels });
  }

  private liveBaseOfDerivedId(sessionId: string): string | undefined {
    return this.wiring.planLabelsLifecycle.liveBaseOfDerivedId(sessionId);
  }

  getSessionCache(sessionId: string): Types.SessionCacheData | null {
    return this.wiring.cache.getSessionCache(sessionId);
  }

  /**
   * The live session under `sessionId` for a lookup that only judges: unlike {@link getSession},
   * an expired session the scan has not reached is reported gone and is not released here.
   */
  peekSession(sessionId: string): Session | null {
    return this.unlessBaseEnded(this.expireIfDue(sessionId, false, undefined, false));
  }
  private unlessBaseEnded(session: Session | null): Session | null {
    return this.wiring.admission.unlessBaseEnded(session);
  }

  private livenessOwnerView(session: Session): LivenessOwnerView {
    return this.wiring.leaseExpiry.livenessOwnerView(session);
  }
  private refuseControlCallOnLapsedOwnerLease(
    session: Session,
    access: Types.SessionAccess,
    execution: Types.SessionExecutionMetadata | undefined,
    unnamedCallerExecutionId: string | undefined,
  ): Promise<void> {
    return this.wiring.admission.refuseControlCallOnLapsedOwnerLease(
      session,
      access,
      execution,
      unnamedCallerExecutionId,
    );
  }

  private isSessionExpired(session: Session): boolean {
    return this.wiring.leaseExpiry.isSessionExpired(session);
  }

  private cancelExecutionsOverriddenByExpiry(
    session: Session,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.wiring.leaseExpiry.cancelExecutionsOverriddenByExpiry(
      session,
      releaseReason,
      excludeExecutionId,
    );
  }

  private isSessionExpiredForNewExecution(
    session: Session,
    execution?: Lifecycle.SessionClockExecution,
  ): boolean {
    return this.wiring.leaseExpiry.isSessionExpiredForNewExecution(session, execution);
  }

  private isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: Lifecycle.SessionClockExecution | undefined,
    hold: "any" | "timely-control" | "recovery" = "any",
  ): boolean {
    return this.wiring.leaseExpiry.isLateExecutionWhileEarlierWorkIsActive(
      session,
      execution,
      hold,
    );
  }
  private startCleanupTimer(): void {
    this.cleanup.startCleanupTimer();
  }

  /**
   * Stop cleanup timer (called on daemon shutdown)
   */
  /** @internal Typed view of private state for unit tests; not part of the public API. */
  get testHooks() {
    return { sessions: this.sessions, wiring: this.wiring } as const;
  }

  private persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: Rows.UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void> {
    return this.wiring.activityPersistence.persistSession(
      session,
      incarnation,
      upsertOptions,
      upsertSettled,
    );
  }

  private recordPersistedRowGeneration(incarnation: Session, rowGeneration: number | void): void {
    return this.wiring.activityPersistence.recordPersistedRowGeneration(incarnation, rowGeneration);
  }

  protected recoveryLivenessFromPersisted(persisted: DeviceSession): Types.SessionRecoveryLiveness {
    return this.wiring.recovery.recoveryLivenessFromPersisted(persisted);
  }

  private recordSessionActivity(session: Session): Promise<void> {
    return this.wiring.activityPersistence.recordSessionActivity(session);
  }

  private persistSessionActivity(
    session: Session,
    update: Rows.DeviceSessionActivityUpdate,
  ): Promise<void> {
    return this.wiring.activityPersistence.persistSessionActivity(session, update);
  }

  private hasUnissuedActivity(session: Session): boolean {
    return this.wiring.activityPersistence.hasUnissuedActivity(session);
  }
  recordHeartbeat(sessionId: string): void {
    this.liveness.recordHeartbeat(sessionId);
  }

  claimLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<Types.LivenessClaimOutcome> {
    return this.liveness.claimLivenessOwnership(sessionId, ownerToken);
  }

  releaseLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<Types.LivenessReleaseOutcome> {
    return this.liveness.releaseLivenessOwnership(sessionId, ownerToken);
  }

  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.liveness.hasLivenessOwnership(sessionId, ownerToken);
  }

  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return this.liveness.claimUnownedLivenessOwnership(sessionId, ownerToken);
  }

  bindAcquiredLivenessOwnerToken(sessionId: string, ownerToken: string): boolean {
    return this.liveness.bindAcquiredLivenessOwnerToken(sessionId, ownerToken);
  }

  adoptCliLivenessPolicy(sessionId: string, requestedIdleTimeoutMs?: number): boolean {
    return this.liveness.adoptCliLivenessPolicy(sessionId, requestedIdleTimeoutMs);
  }

  adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number } = {},
  ): Promise<Session> {
    return this.liveness.adoptManagedExecutionLivenessPolicy(sessionId, options);
  }

  restoreHeartbeatLivenessPolicy(sessionId: string): boolean {
    return this.liveness.restoreHeartbeatLivenessPolicy(sessionId);
  }
}
