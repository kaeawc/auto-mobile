import { createSessionManagerCollaboratorHost } from "./host";
import {
  SessionManagerCollaboratorActions,
  SessionManagerPersistenceCollaboratorActions,
  SessionManagerCollaboratorHost,
} from "./host";
import { DeviceRestoreHealth } from "./restoreHealth";
import { PersistedSessionAdmission } from "./persistedAdmission";
import { SessionRecovery } from "./recovery";
import { SessionRehydration } from "./rehydration";
import { SessionRebinding } from "./rebinding";
import { SupersededSessionRows } from "./supersededRows";
import { SessionReleasePersistence } from "./releasePersistence";
import { SessionActivityPersistence } from "./activityPersistence";
import { SessionLeaseExpiry } from "./leaseExpiry";
import { SessionCache } from "./cache";
import { SessionAcquisition } from "./acquisition";
import { SessionReleaseRequests } from "./releaseRequests";
import { SessionPlanLabels } from "./planLabelsLifecycle";
import { SessionCreation } from "./creation";
import { SessionReleaseCommit } from "./releaseCommit";
import { SessionCreationGuard } from "./creationGuard";
import { SessionAdmission } from "./admission";
import { SessionBookkeeping } from "./bookkeeping";
import { SessionCallbacks } from "./callbacks";
import { SessionActivityClocks } from "./activityClocks";
import { SessionRecoveryPublication } from "./recoveryPublication";
import { SessionReleaseWrite } from "./releaseWrite";

type SessionManagerDependencyReaders = {
  [
    Key in keyof Omit<SessionManagerCollaboratorHost, keyof SessionManagerCollaboratorActions>
  ]: () => SessionManagerCollaboratorHost[Key];
};

export type SessionManagerWiringFacade = Pick<
  SessionManagerCollaboratorActions,
  | "expireIfDue"
  | "finishReleaseForcedBeforeStart"
  | "liftTerminalFence"
  | "retireRestorations"
  | "withReleaseReason"
  | "persistAndPublishSession"
  | "isSessionExpired"
  | "recordSessionActivity"
  | "getSessionForNewExecution"
  | "refuseControlCallOnLapsedOwnerLease"
  | "peekTerminalAnswerForEndedSession"
  | "releaseSessionPastIdleDeadline"
  | "liveBaseOfDerivedId"
  | "retryPendingTerminalReleasesNow"
  | "getPendingDeviceCleanup"
  | "armPendingDeviceCleanupCaps"
  | "cancelExecutionsOverriddenByExpiry"
  | "getSession"
  | "getTerminalReleaseSnapshot"
  | "waitForSessionSetup"
  | "restoreIncarnationIsCurrent"
  | "waitForIdentityReplacement"
  | "isTerminalReleaseRetryCurrent"
  | "retryTerminalReleaseWrite"
  | "dispatchDeviceRestore"
  | "sessionNow"
  | "isSessionBeingRecreated"
  | "sessionClockToWall"
  | "persistSessionRelease"
  | "recoverPersistedRow"
  | "recoveredRowOwner"
  | "recoveryLivenessFromPersisted"
  | "applyRecoveredTerminalReleaseIntents"
  | "createSession"
  | "rebindSession"
  | "flushDeferredRebindCleanups"
  | "trackReleaseDrainWrite"
  | "getSessionForDevice"
  | "trackPendingTeardownCleanup"
  | "registerPendingDeviceCleanup"
  | "isCurrentSession"
  | "persistSession"
  | "scheduleTerminalReleaseRetry"
  | "recordPendingNonTerminalRelease"
  | "getLegacyLifecycleView"
  | "isAdmittedForAutomation"
  | "cancelExecutionsCutByRelease"
  | "releaseSessionForReason"
  | "releaseSession"
  | "deviceHeldForLateRead"
  | "unlessBaseEnded"
  | "wallToSessionClock"
  | "peekSession"
  | "judgedLeaseHeartbeat"
  | "ownershipSessionUuid"
  | "getBaseSessionOfDerivedLabel"
  | "getReleasingSession"
  | "findSession"
  | "updateSessionCache"
  | "getDeviceReadiness"
  | "invalidateAutomationReadiness"
  | "getBiometricEnrollment"
  | "getNetworkCondition"
  | "recordRestartRecoveryActivity"
  | "getOrCreateSession"
  | "terminalizeExpiredPersistedSession"
>;

/** Stable call-throughs resolve the facade and collaborators anew, preserving patched test seams. */
export class SessionManagerWiring {
  readonly host: SessionManagerCollaboratorHost;
  readonly restoreHealth: DeviceRestoreHealth;
  readonly persistedAdmission: PersistedSessionAdmission;
  readonly recovery: SessionRecovery;
  readonly rehydration: SessionRehydration;
  readonly rebinding: SessionRebinding;
  readonly supersededRows: SupersededSessionRows;
  readonly releasePersistence: SessionReleasePersistence;
  readonly activityPersistence: SessionActivityPersistence;
  readonly leaseExpiry: SessionLeaseExpiry;
  readonly cache: SessionCache;
  readonly acquisition: SessionAcquisition;
  readonly releaseRequests: SessionReleaseRequests;
  readonly planLabelsLifecycle: SessionPlanLabels;
  readonly creation: SessionCreation;
  readonly releaseCommit: SessionReleaseCommit;
  readonly creationGuard: SessionCreationGuard;
  readonly admission: SessionAdmission;
  readonly bookkeeping: SessionBookkeeping;
  readonly callbacks: SessionCallbacks;
  readonly activityClocks: SessionActivityClocks;
  readonly recoveryPublication: SessionRecoveryPublication;
  readonly releaseWrite: SessionReleaseWrite;
  constructor(
    private readonly facade: SessionManagerWiringFacade,
    private readonly dependencies: SessionManagerDependencyReaders,
  ) {
    this.host = createSessionManagerCollaboratorHost(
      this.createCollaboratorActions(),
      dependencies,
    );
    this.restoreHealth = new DeviceRestoreHealth(this.host);
    this.persistedAdmission = new PersistedSessionAdmission(this.host);
    this.recovery = new SessionRecovery(this.host);
    this.rehydration = new SessionRehydration(this.host);
    this.rebinding = new SessionRebinding(this.host);
    this.supersededRows = new SupersededSessionRows(this.host);
    this.releasePersistence = new SessionReleasePersistence(this.host);
    this.activityPersistence = new SessionActivityPersistence(this.host);
    this.leaseExpiry = new SessionLeaseExpiry(this.host);
    this.cache = new SessionCache(this.host);
    this.acquisition = new SessionAcquisition(this.host);
    this.releaseRequests = new SessionReleaseRequests(this.host);
    this.planLabelsLifecycle = new SessionPlanLabels(this.host);
    this.creation = new SessionCreation(this.host);
    this.releaseCommit = new SessionReleaseCommit(this.host);
    this.creationGuard = new SessionCreationGuard(this.host);
    this.admission = new SessionAdmission(this.host);
    this.bookkeeping = new SessionBookkeeping(this.host);
    this.callbacks = new SessionCallbacks(this.host);
    this.activityClocks = new SessionActivityClocks(this.host);
    this.recoveryPublication = new SessionRecoveryPublication(this.host);
    this.releaseWrite = new SessionReleaseWrite(this.host);
  }

  createCollaboratorActions(): SessionManagerCollaboratorActions {
    return {
      ...this.createPersistenceCollaboratorActions(),
      refusePlanLabelSessionOutsideItsRun: (...args) =>
        this.planLabelsLifecycle.refusePlanLabelSessionOutsideItsRun(...args),
      expireIfDue: (...args) => this.facade.expireIfDue(...args),
      markIdentityReplacedRelease: (...args) =>
        this.restoreHealth.markIdentityReplacedRelease(...args),
      createReleaseReasonState: (...args) => this.releaseCommit.createReleaseReasonState(...args),
      judgeOwnerLeaseForRelease: (...args) => this.leaseExpiry.judgeOwnerLeaseForRelease(...args),
      finishReleaseForcedBeforeStart: (...args) =>
        this.facade.finishReleaseForcedBeforeStart(...args),
      releaseSessionInternal: (request) => this.releaseCommit.releaseSessionInternal(request),
      finishIdentityReplacedRelease: (...args) =>
        this.restoreHealth.finishIdentityReplacedRelease(...args),
      releaseFinalizedSession: (...args) => this.releaseCommit.releaseFinalizedSession(...args),
      persistTerminalReleaseIfNeeded: (...args) =>
        this.releasePersistence.persistTerminalReleaseIfNeeded(...args),
      isLiveDaemonSession: (...args) => this.recovery.isLiveDaemonSession(...args),
      liftTerminalFence: (...args) => this.facade.liftTerminalFence(...args),
      endedBaseOfLabel: (...args) => this.admission.endedBaseOfLabel(...args),
      rejectCreationAfterShutdownFence: (...args) =>
        this.creationGuard.rejectCreationAfterShutdownFence(...args),
      assertTerminalReleaseAdmission: (...args) =>
        this.admission.assertTerminalReleaseAdmission(...args),
      invalidateFinalizedSessionIdentity: (...args) =>
        this.releaseCommit.invalidateFinalizedSessionIdentity(...args),
      cancelSessionlessUseOnAcquisition: (...args) =>
        this.callbacks.cancelSessionlessUseOnAcquisition(...args),
      notifySessionCreated: (...args) => this.callbacks.notifySessionCreated(...args),
      creationRowRollbackSnapshot: (...args) =>
        this.creationGuard.creationRowRollbackSnapshot(...args),
      retireAbandonedCreation: (...args) => this.creationGuard.retireAbandonedCreation(...args),
      revokeSupersededIdentityReplacement: (...args) =>
        this.restoreHealth.revokeSupersededIdentityReplacement(...args),
      abandonSupersededRelease: (...args) => this.releaseCommit.abandonSupersededRelease(...args),
      releaseHeartbeatTimeoutMs: (...args) => this.releaseCommit.releaseHeartbeatTimeoutMs(...args),
      fenceTerminalRelease: (...args) => this.releasePersistence.fenceTerminalRelease(...args),
      persistTerminalReleaseWithinDeadline: (...args) =>
        this.releaseCommit.persistTerminalReleaseWithinDeadline(...args),
      commitReleaseRemoval: (...args) => this.releaseCommit.commitReleaseRemoval(...args),
      commitReplacedDeviceTeardown: (...args) =>
        this.releaseCommit.commitReplacedDeviceTeardown(...args),
      completeReleasePersistence: (...args) =>
        this.releaseCommit.completeReleasePersistence(...args),
      recordFinalizedSessionRelease: (...args) =>
        this.releaseCommit.recordFinalizedSessionRelease(...args),
      finishCommittedRelease: (...args) => this.releaseCommit.finishCommittedRelease(...args),
      removeSession: (...args) => this.activityClocks.removeSession(...args),
      dropReplacedDeviceRestoreState: (...args) =>
        this.releaseCommit.dropReplacedDeviceRestoreState(...args),
      retireRestorations: (...args) => this.facade.retireRestorations(...args),
      withReleaseReason: (...args) => this.facade.withReleaseReason(...args),
      persistTerminalReleaseWithUpgrade: (...args) =>
        this.releaseCommit.persistTerminalReleaseWithUpgrade(...args),
      liftPlanLabelFenceForMint: (...args) =>
        this.planLabelsLifecycle.liftPlanLabelFenceForMint(...args),
      withinCreateDeadline: (...args) => this.creation.withinCreateDeadline(...args),
      creatorSourceForCreation: (...args) =>
        this.planLabelsLifecycle.creatorSourceForCreation(...args),
      recoverySessionFields: (...args) => this.recovery.recoverySessionFields(...args),
      notifyManagedExecutionRecovery: (...args) =>
        this.callbacks.notifyManagedExecutionRecovery(...args),
      persistAndPublishSession: (...args) => this.facade.persistAndPublishSession(...args),
      claimedIncarnation: (...args) => this.creationGuard.claimedIncarnation(...args),
      rollBackCancelledClientChosenCreation: (...args) =>
        this.creationGuard.rollBackCancelledClientChosenCreation(...args),
      persistRejectedCreationRow: (...args) =>
        this.creationGuard.persistRejectedCreationRow(...args),
      persistCreationRollback: (...args) => this.creation.persistCreationRollback(...args),
      isSessionExpired: (...args) => this.facade.isSessionExpired(...args),
      recordSessionActivity: (...args) => this.facade.recordSessionActivity(...args),
      resolveSessionAcquisitionOptions: (...args) =>
        this.acquisition.resolveSessionAcquisitionOptions(...args),
      getSessionForNewExecution: (...args) => this.facade.getSessionForNewExecution(...args),
      assertSessionNotSuspect: (...args) => this.leaseExpiry.assertSessionNotSuspect(...args),
      refuseControlCallOnLapsedOwnerLease: (...args) =>
        this.facade.refuseControlCallOnLapsedOwnerLease(...args),
      refuseLabelCallOnLapsedBaseLease: (...args) =>
        this.admission.refuseLabelCallOnLapsedBaseLease(...args),
      refreshExistingSessionForAccess: (...args) =>
        this.admission.refreshExistingSessionForAccess(...args),
      refuseLabelOfEndedBase: (...args) => this.admission.refuseLabelOfEndedBase(...args),
      startOrJoinUnseenAssignment: (...args) =>
        this.acquisition.startOrJoinUnseenAssignment(...args),
      preFenceIdleReleaseReason: (...args) => this.admission.preFenceIdleReleaseReason(...args),
      expiredReleaseOfUnheldRow: (...args) => this.admission.expiredReleaseOfUnheldRow(...args),
      peekTerminalAnswerForEndedSession: (...args) =>
        this.facade.peekTerminalAnswerForEndedSession(...args),
      expiredReleaseFromPersisted: (...args) =>
        this.persistedAdmission.expiredReleaseFromPersisted(...args),
      sessionEndReason: (...args) => this.admission.sessionEndReason(...args),
      expiredSessionReleaseReason: (...args) =>
        this.leaseExpiry.expiredSessionReleaseReason(...args),
      releaseSessionPastIdleDeadline: (...args) =>
        this.facade.releaseSessionPastIdleDeadline(...args),
      liveBaseOfDerivedId: (...args) => this.facade.liveBaseOfDerivedId(...args),
      canStartSessionSetup: (...args) => this.bookkeeping.canStartSessionSetup(...args),
      clearSessionSetup: (...args) => this.bookkeeping.clearSessionSetup(...args),
      retryPendingTerminalReleasesNow: (...args) =>
        this.facade.retryPendingTerminalReleasesNow(...args),
      settleReleaseDrain: (...args) => this.bookkeeping.settleReleaseDrain(...args),
      getPendingDeviceCleanup: (...args) => this.facade.getPendingDeviceCleanup(...args),
      armPendingDeviceCleanupCaps: (...args) => this.facade.armPendingDeviceCleanupCaps(...args),
      forgiveMintBoundClaimLease: (...args) => this.leaseExpiry.forgiveMintBoundClaimLease(...args),
      cancelExecutionsOverriddenByExpiry: (...args) =>
        this.facade.cancelExecutionsOverriddenByExpiry(...args),
      recoveryTargetFromPersisted: (...args) => this.recovery.recoveryTargetFromPersisted(...args),
      assignUnseenSessionToDevicePool: (...args) =>
        this.recovery.assignUnseenSessionToDevicePool(...args),
      getSession: (...args) => this.facade.getSession(...args),
      settleManagedExecutionRecovery: (...args) =>
        this.callbacks.settleManagedExecutionRecovery(...args),
      rehydrationSkipReason: (...args) => this.rehydration.rehydrationSkipReason(...args),
      registerRehydrationRecovery: (...args) =>
        this.rehydration.registerRehydrationRecovery(...args),
      getTerminalReleaseSnapshot: (...args) => this.facade.getTerminalReleaseSnapshot(...args),
      waitForSessionSetup: (...args) => this.facade.waitForSessionSetup(...args),
      createReboundSession: (...args) => this.rebinding.createReboundSession(...args),
      restoreReleasedRowAfterReassert: (...args) =>
        this.supersededRows.restoreReleasedRowAfterReassert(...args),
      restoreIncarnationIsCurrent: (...args) => this.facade.restoreIncarnationIsCurrent(...args),
      waitForIdentityReplacement: (...args) => this.facade.waitForIdentityReplacement(...args),
      notifySessionDeviceUnbound: (...args) => this.callbacks.notifySessionDeviceUnbound(...args),
      restoreRebindOverrides: (...args) => this.rebinding.restoreRebindOverrides(...args),
      deferRebindOverrides: (...args) => this.rebinding.deferRebindOverrides(...args),
      releaseWritePrecondition: (...args) =>
        this.releasePersistence.releaseWritePrecondition(...args),
      recordTerminalReleaseIntent: (...args) => this.releaseWrite.recordTerminalIntent(...args),
      issueReleaseRow: (...args) => this.releasePersistence.issueReleaseRow(...args),
      releaseRowFallback: (...args) => this.releasePersistence.releaseRowFallback(...args),
      trackLateReleaseWrite: (...args) => this.releasePersistence.trackLateReleaseWrite(...args),
      confirmReleaseWrite: (...args) => this.releasePersistence.confirmReleaseWrite(...args),
      handleReleaseWriteFailure: (...args) =>
        this.releasePersistence.handleReleaseWriteFailure(...args),
    };
  }
  createPersistenceCollaboratorActions(): SessionManagerPersistenceCollaboratorActions {
    return {
      isTerminalReleaseRetryCurrent: (...args) =>
        this.facade.isTerminalReleaseRetryCurrent(...args),
      retryTerminalReleaseWrite: (...args) => this.facade.retryTerminalReleaseWrite(...args),
      dropReleaseRetry: (...args) => this.releasePersistence.dropReleaseRetry(...args),
      refuseLabelMintOutsidePlanAllocation: (...args) =>
        this.admission.refuseLabelMintOutsidePlanAllocation(...args),
      rejectRefusedRebind: (...args) => this.recoveryPublication.rejectRefusedRebind(...args),
      readSessionRow: (sessionId) =>
        this.dependencies.deviceSessionRepository().getSession(sessionId),
      dispatchDeviceRestore: (...args) => this.facade.dispatchDeviceRestore(...args),
      sessionNow: (...args) => this.facade.sessionNow(...args),
      isRowOwnedByLivePeer: (...args) => this.releaseRequests.isRowOwnedByLivePeer(...args),
      isSessionBeingRecreated: (...args) => this.facade.isSessionBeingRecreated(...args),
      sessionClockToWall: (...args) => this.facade.sessionClockToWall(...args),
      rowWriteLivePeerDaemonSessionIds: (...args) =>
        this.supersededRows.rowWriteLivePeerDaemonSessionIds(...args),
      releaseSnapshotFromPersisted: (...args) =>
        this.recoveryPublication.releaseSnapshotFromPersisted(...args),
      persistSessionRelease: (...args) => this.facade.persistSessionRelease(...args),
      notifySessionRelease: (...args) => this.callbacks.notifySessionRelease(...args),
      isLapsedUnownedRestartRecovery: (...args) =>
        this.acquisition.isLapsedUnownedRestartRecovery(...args),
      admitPersistedSession: (...args) => this.acquisition.admitPersistedSession(...args),
      isReissuablePersistedSession: (...args) =>
        this.persistedAdmission.isReissuablePersistedSession(...args),
      recoverPersistedRow: (...args) => this.facade.recoverPersistedRow(...args),
      readPersistedSession: (...args) => this.persistedAdmission.readPersistedSession(...args),
      unlessBeingReplaced: (...args) => this.persistedAdmission.unlessBeingReplaced(...args),
      terminalReleaseFromPersisted: (...args) =>
        this.persistedAdmission.terminalReleaseFromPersisted(...args),
      recoveredRowOwner: (...args) => this.facade.recoveredRowOwner(...args),
      isNameReissueOnlyRow: (...args) => this.persistedAdmission.isNameReissueOnlyRow(...args),
      terminalizePersistedRecoveryFailure: (...args) =>
        this.recoveryPublication.terminalizePersistedRecoveryFailure(...args),
      recoveryLivenessFromPersisted: (...args) =>
        this.facade.recoveryLivenessFromPersisted(...args),
      newSharedAssignment: (...args) => this.acquisition.newSharedAssignment(...args),
      recoverPersistedSession: (...args) => this.recovery.recoverPersistedSession(...args),
      waitForSharedAssignment: (...args) => this.acquisition.waitForSharedAssignment(...args),
      applyRecoveredTerminalReleaseIntents: (...args) =>
        this.facade.applyRecoveredTerminalReleaseIntents(...args),
      listRecoverableSessionsBeforeDeadline: (...args) =>
        this.recoveryPublication.listRecoverableSessionsBeforeDeadline(...args),
      rehydratePersistedRow: (...args) => this.recoveryPublication.rehydratePersistedRow(...args),
      isRecoverablePersistedSession: (...args) =>
        this.persistedAdmission.isRecoverablePersistedSession(...args),
      assertTerminalRebindAdmission: (...args) =>
        this.admission.assertTerminalRebindAdmission(...args),
      createSession: (...args) => this.facade.createSession(...args),
      notifyDeviceOwnershipChange: (...args) => this.callbacks.notifyDeviceOwnershipChange(...args),
      rebindSession: (...args) => this.facade.rebindSession(...args),
      flushDeferredRebindCleanups: (...args) => this.facade.flushDeferredRebindCleanups(...args),
      persistAndPublishRebind: (...args) =>
        this.recoveryPublication.persistAndPublishRebind(...args),
      endSessionTerminallyReleasedInRow: (...args) =>
        this.activityPersistence.endSessionTerminallyReleasedInRow(...args),
      trackReleaseDrainWrite: (...args) => this.facade.trackReleaseDrainWrite(...args),
      getSessionForDevice: (...args) => this.facade.getSessionForDevice(...args),
      trackPendingTeardownCleanup: (...args) => this.facade.trackPendingTeardownCleanup(...args),
      registerPendingDeviceCleanup: (...args) => this.facade.registerPendingDeviceCleanup(...args),
      isCurrentSession: (...args) => this.facade.isCurrentSession(...args),
      persistSession: (...args) => this.facade.persistSession(...args),
      awaitInFlightOwnRowWrites: (...args) =>
        this.activityPersistence.awaitInFlightOwnRowWrites(...args),
      scheduleTerminalReleaseRetry: (...args) => this.facade.scheduleTerminalReleaseRetry(...args),
      captureReleaseRowGeneration: (...args) =>
        this.releasePersistence.captureReleaseRowGeneration(...args),
      recordPendingNonTerminalRelease: (...args) =>
        this.facade.recordPendingNonTerminalRelease(...args),
      retryRefusedRowWrite: (...args) => this.supersededRows.retryRefusedRowWrite(...args),
      retryNonTerminalRowAfterRelease: (...args) =>
        this.supersededRows.retryNonTerminalRowAfterRelease(...args),
      reassertSupersededLiveRow: (...args) =>
        this.supersededRows.reassertSupersededLiveRow(...args),
      retryTerminalRowAfterRelease: (...args) =>
        this.supersededRows.retryTerminalRowAfterRelease(...args),
      waitOutRecreationOf: (...args) => this.supersededRows.waitOutRecreationOf(...args),
      getLegacyLifecycleView: (...args) => this.facade.getLegacyLifecycleView(...args),
      isAdmittedForAutomation: (...args) => this.facade.isAdmittedForAutomation(...args),
      guardedRowRewriteOptions: (...args) => this.supersededRows.guardedRowRewriteOptions(...args),
      isRebindUnderWay: (...args) => this.supersededRows.isRebindUnderWay(...args),
      oweSupersededRowReassert: (...args) => this.supersededRows.oweSupersededRowReassert(...args),
      restoreNonTerminalRowAfterReassert: (...args) =>
        this.supersededRows.restoreNonTerminalRowAfterReassert(...args),
      reassertOwedLiveRowForActivity: (...args) =>
        this.supersededRows.reassertOwedLiveRowForActivity(...args),
      getPersistedTerminalRelease: (...args) =>
        this.persistedAdmission.getPersistedTerminalRelease(...args),
      cancelExecutionsCutByRelease: (...args) => this.facade.cancelExecutionsCutByRelease(...args),
      releaseSessionForReason: (...args) => this.facade.releaseSessionForReason(...args),
      releaseSession: (...args) => this.facade.releaseSession(...args),
      deviceHeldForLateRead: (...args) => this.facade.deviceHeldForLateRead(...args),
      unlessBaseEnded: (...args) => this.facade.unlessBaseEnded(...args),
      wallToSessionClock: (...args) => this.facade.wallToSessionClock(...args),
      peekSession: (...args) => this.facade.peekSession(...args),
      judgedLeaseHeartbeat: (...args) => this.facade.judgedLeaseHeartbeat(...args),
      ownershipSessionUuid: (...args) => this.facade.ownershipSessionUuid(...args),
      getBaseSessionOfDerivedLabel: (...args) => this.facade.getBaseSessionOfDerivedLabel(...args),
      getReleasingSession: (...args) => this.facade.getReleasingSession(...args),
      upgradeReleaseReason: (...args) => this.releaseCommit.upgradeReleaseReason(...args),
      terminalReleaseAsOfNow: (...args) => this.admission.terminalReleaseAsOfNow(...args),
      findSession: (...args) => this.facade.findSession(...args),
      updateSessionCache: (...args) => this.facade.updateSessionCache(...args),
      getDeviceReadiness: (...args) => this.facade.getDeviceReadiness(...args),
      invalidateAutomationReadiness: (...args) =>
        this.facade.invalidateAutomationReadiness(...args),
      getBiometricEnrollment: (...args) => this.facade.getBiometricEnrollment(...args),
      getNetworkCondition: (...args) => this.facade.getNetworkCondition(...args),
      reclaimAndRefreshExistingSession: (...args) =>
        this.admission.reclaimAndRefreshExistingSession(...args),
      recordRestartRecoveryActivity: (...args) =>
        this.facade.recordRestartRecoveryActivity(...args),
      getOrCreateSession: (...args) => this.facade.getOrCreateSession(...args),
      observeSessionForRead: (...args) => this.leaseExpiry.observeSessionForRead(...args),
      unadmittedSessionError: (...args) => this.persistedAdmission.unadmittedSessionError(...args),
      terminalizeExpiredPersistedSession: (...args) =>
        this.facade.terminalizeExpiredPersistedSession(...args),
    };
  }
}
