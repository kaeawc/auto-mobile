import type { SessionAcquisitionHost } from "./acquisition";
import type { SessionActivityClocksHost } from "./activityClocks";
import type { SessionActivityPersistenceHost } from "./activityPersistence";
import type { SessionAdmissionHost } from "./admission";
import type { SessionBookkeepingHost } from "./bookkeeping";
import type { SessionCacheHost } from "./cache";
import type { SessionCallbacksHost } from "./callbacks";
import type { SessionCreationHost } from "./creation";
import type { SessionCreationGuardHost } from "./creationGuard";
import type { SessionLeaseExpiryHost } from "./leaseExpiry";
import type { PersistedSessionAdmissionHost } from "./persistedAdmission";
import type { SessionPlanLabelsHost } from "./planLabelsLifecycle";
import type { SessionRebindingHost } from "./rebinding";
import type { SessionRecoveryHost } from "./recovery";
import type { SessionRecoveryPublicationHost } from "./recoveryPublication";
import type { SessionRehydrationHost } from "./rehydration";
import type { SessionReleaseCommitHost } from "./releaseCommit";
import type { SessionReleasePersistenceHost } from "./releasePersistence";
import type { SessionReleaseRequestsHost } from "./releaseRequests";
import type { SessionReleaseWriteHost } from "./releaseWrite";
import type { DeviceRestoreHealthHost } from "./restoreHealth";
import type { SupersededSessionRowsHost } from "./supersededRows";

/** Capabilities wired once; every collaborator receives only its own narrow host view. */
export type SessionManagerCollaboratorHost = DeviceRestoreHealthHost &
  PersistedSessionAdmissionHost &
  SessionRecoveryHost &
  SessionRehydrationHost &
  SessionRebindingHost &
  SupersededSessionRowsHost &
  SessionReleasePersistenceHost &
  SessionActivityPersistenceHost &
  SessionLeaseExpiryHost &
  SessionCacheHost &
  SessionAcquisitionHost &
  SessionReleaseRequestsHost &
  SessionPlanLabelsHost &
  SessionCreationHost &
  SessionReleaseCommitHost &
  SessionCreationGuardHost &
  SessionAdmissionHost &
  SessionBookkeepingHost &
  SessionCallbacksHost &
  SessionActivityClocksHost &
  SessionRecoveryPublicationHost &
  SessionReleaseWriteHost;

/** Stable call-throughs are separate from the live dependency getters. */
export type SessionManagerCollaboratorActions = Pick<
  SessionManagerCollaboratorHost,
  | "rejectRefusedRebind"
  | "refuseLabelMintOutsidePlanAllocation"
  | "isTerminalReleaseRetryCurrent"
  | "retryTerminalReleaseWrite"
  | "dropReleaseRetry"
  | "readSessionRow"
  | "dispatchDeviceRestore"
  | "sessionNow"
  | "isRowOwnedByLivePeer"
  | "isSessionBeingRecreated"
  | "sessionClockToWall"
  | "rowWriteLivePeerDaemonSessionIds"
  | "releaseSnapshotFromPersisted"
  | "persistSessionRelease"
  | "notifySessionRelease"
  | "isLapsedUnownedRestartRecovery"
  | "admitPersistedSession"
  | "isReissuablePersistedSession"
  | "recoverPersistedRow"
  | "readPersistedSession"
  | "unlessBeingReplaced"
  | "terminalReleaseFromPersisted"
  | "recoveredRowOwner"
  | "isNameReissueOnlyRow"
  | "terminalizePersistedRecoveryFailure"
  | "recoveryLivenessFromPersisted"
  | "newSharedAssignment"
  | "recoverPersistedSession"
  | "waitForSharedAssignment"
  | "applyRecoveredTerminalReleaseIntents"
  | "listRecoverableSessionsBeforeDeadline"
  | "rehydratePersistedRow"
  | "isRecoverablePersistedSession"
  | "assertTerminalRebindAdmission"
  | "createSession"
  | "notifyDeviceOwnershipChange"
  | "rebindSession"
  | "flushDeferredRebindCleanups"
  | "persistAndPublishRebind"
  | "endSessionTerminallyReleasedInRow"
  | "trackReleaseDrainWrite"
  | "getSessionForDevice"
  | "trackPendingTeardownCleanup"
  | "registerPendingDeviceCleanup"
  | "isCurrentSession"
  | "persistSession"
  | "awaitInFlightOwnRowWrites"
  | "scheduleTerminalReleaseRetry"
  | "captureReleaseRowGeneration"
  | "recordPendingNonTerminalRelease"
  | "retryRefusedRowWrite"
  | "retryNonTerminalRowAfterRelease"
  | "reassertSupersededLiveRow"
  | "restoreNonTerminalRowOverSupersededRelease"
  | "retryTerminalRowAfterRelease"
  | "waitOutRecreationOf"
  | "replaceSupersededReleaseRow"
  | "getLegacyLifecycleView"
  | "isAdmittedForAutomation"
  | "guardedRowRewriteOptions"
  | "isRebindUnderWay"
  | "oweSupersededRowReassert"
  | "restoreNonTerminalRowAfterReassert"
  | "reassertOwedLiveRowForActivity"
  | "getPersistedTerminalRelease"
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
  | "upgradeReleaseReason"
  | "terminalReleaseAsOfNow"
  | "findSession"
  | "updateSessionCache"
  | "getDeviceReadiness"
  | "invalidateAutomationReadiness"
  | "getBiometricEnrollment"
  | "getNetworkCondition"
  | "reclaimAndRefreshExistingSession"
  | "recordRestartRecoveryActivity"
  | "getOrCreateSession"
  | "observeSessionForRead"
  | "unadmittedSessionError"
  | "terminalizeExpiredPersistedSession"
  | "refusePlanLabelSessionOutsideItsRun"
  | "expireIfDue"
  | "markIdentityReplacedRelease"
  | "createReleaseReasonState"
  | "judgeOwnerLeaseForRelease"
  | "finishReleaseForcedBeforeStart"
  | "releaseSessionInternal"
  | "finishIdentityReplacedRelease"
  | "releaseFinalizedSession"
  | "persistTerminalReleaseIfNeeded"
  | "isLiveDaemonSession"
  | "liftTerminalFence"
  | "endedBaseOfLabel"
  | "rejectCreationAfterShutdownFence"
  | "assertTerminalReleaseAdmission"
  | "invalidateFinalizedSessionIdentity"
  | "cancelSessionlessUseOnAcquisition"
  | "notifySessionCreated"
  | "creationRowRollbackSnapshot"
  | "retireAbandonedCreation"
  | "revokeSupersededIdentityReplacement"
  | "abandonSupersededRelease"
  | "releaseHeartbeatTimeoutMs"
  | "persistTerminalReleaseWithinDeadline"
  | "abandonReleaseSupersededAfterPersist"
  | "commitReleaseRemoval"
  | "commitReplacedDeviceTeardown"
  | "restoreNonTerminalRowOverSupersededReleaseLater"
  | "completeReleasePersistence"
  | "recordFinalizedSessionRelease"
  | "finishCommittedRelease"
  | "removeSession"
  | "dropReplacedDeviceRestoreState"
  | "retireRestorations"
  | "withReleaseReason"
  | "persistTerminalReleaseWithUpgrade"
  | "liftPlanLabelFenceForMint"
  | "withinCreateDeadline"
  | "creatorSourceForCreation"
  | "recoverySessionFields"
  | "notifyManagedExecutionRecovery"
  | "persistAndPublishSession"
  | "claimedIncarnation"
  | "rollBackCancelledClientChosenCreation"
  | "persistRejectedCreationRow"
  | "persistCreationRollback"
  | "isSessionExpired"
  | "recordSessionActivity"
  | "resolveSessionAcquisitionOptions"
  | "getSessionForNewExecution"
  | "assertSessionNotSuspect"
  | "refuseControlCallOnLapsedOwnerLease"
  | "refuseLabelCallOnLapsedBaseLease"
  | "refreshExistingSessionForAccess"
  | "refuseLabelOfEndedBase"
  | "startOrJoinUnseenAssignment"
  | "preFenceIdleReleaseReason"
  | "expiredReleaseOfUnheldRow"
  | "peekTerminalAnswerForEndedSession"
  | "expiredReleaseFromPersisted"
  | "sessionEndReason"
  | "expiredSessionReleaseReason"
  | "releaseSessionPastIdleDeadline"
  | "liveBaseOfDerivedId"
  | "canStartSessionSetup"
  | "clearSessionSetup"
  | "retryPendingTerminalReleasesNow"
  | "settleReleaseDrain"
  | "getPendingDeviceCleanup"
  | "armPendingDeviceCleanupCaps"
  | "forgiveMintBoundClaimLease"
  | "cancelExecutionsOverriddenByExpiry"
  | "recoveryTargetFromPersisted"
  | "assignUnseenSessionToDevicePool"
  | "getSession"
  | "settleManagedExecutionRecovery"
  | "rehydrationSkipReason"
  | "registerRehydrationRecovery"
  | "getTerminalReleaseSnapshot"
  | "waitForSessionSetup"
  | "createReboundSession"
  | "restoreReleasedRowAfterReassert"
  | "restoreIncarnationIsCurrent"
  | "waitForIdentityReplacement"
  | "notifySessionDeviceUnbound"
  | "restoreRebindOverrides"
  | "deferRebindOverrides"
  | "releaseWritePrecondition"
  | "issueReleaseRow"
  | "releaseRowFallback"
  | "trackLateReleaseWrite"
  | "confirmReleaseWrite"
  | "handleReleaseWriteFailure"
>;

export type SessionManagerPersistenceCollaboratorActions = Pick<
  SessionManagerCollaboratorActions,
  | "isTerminalReleaseRetryCurrent"
  | "retryTerminalReleaseWrite"
  | "dropReleaseRetry"
  | "refuseLabelMintOutsidePlanAllocation"
  | "rejectRefusedRebind"
  | "readSessionRow"
  | "dispatchDeviceRestore"
  | "sessionNow"
  | "isRowOwnedByLivePeer"
  | "isSessionBeingRecreated"
  | "sessionClockToWall"
  | "rowWriteLivePeerDaemonSessionIds"
  | "releaseSnapshotFromPersisted"
  | "persistSessionRelease"
  | "notifySessionRelease"
  | "isLapsedUnownedRestartRecovery"
  | "admitPersistedSession"
  | "isReissuablePersistedSession"
  | "recoverPersistedRow"
  | "readPersistedSession"
  | "unlessBeingReplaced"
  | "terminalReleaseFromPersisted"
  | "recoveredRowOwner"
  | "isNameReissueOnlyRow"
  | "terminalizePersistedRecoveryFailure"
  | "recoveryLivenessFromPersisted"
  | "newSharedAssignment"
  | "recoverPersistedSession"
  | "waitForSharedAssignment"
  | "applyRecoveredTerminalReleaseIntents"
  | "listRecoverableSessionsBeforeDeadline"
  | "rehydratePersistedRow"
  | "isRecoverablePersistedSession"
  | "assertTerminalRebindAdmission"
  | "createSession"
  | "notifyDeviceOwnershipChange"
  | "rebindSession"
  | "flushDeferredRebindCleanups"
  | "persistAndPublishRebind"
  | "endSessionTerminallyReleasedInRow"
  | "trackReleaseDrainWrite"
  | "getSessionForDevice"
  | "trackPendingTeardownCleanup"
  | "registerPendingDeviceCleanup"
  | "isCurrentSession"
  | "persistSession"
  | "awaitInFlightOwnRowWrites"
  | "scheduleTerminalReleaseRetry"
  | "captureReleaseRowGeneration"
  | "recordPendingNonTerminalRelease"
  | "retryRefusedRowWrite"
  | "retryNonTerminalRowAfterRelease"
  | "reassertSupersededLiveRow"
  | "restoreNonTerminalRowOverSupersededRelease"
  | "retryTerminalRowAfterRelease"
  | "waitOutRecreationOf"
  | "replaceSupersededReleaseRow"
  | "getLegacyLifecycleView"
  | "isAdmittedForAutomation"
  | "guardedRowRewriteOptions"
  | "isRebindUnderWay"
  | "oweSupersededRowReassert"
  | "restoreNonTerminalRowAfterReassert"
  | "reassertOwedLiveRowForActivity"
  | "getPersistedTerminalRelease"
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
  | "upgradeReleaseReason"
  | "terminalReleaseAsOfNow"
  | "findSession"
  | "updateSessionCache"
  | "getDeviceReadiness"
  | "invalidateAutomationReadiness"
  | "getBiometricEnrollment"
  | "getNetworkCondition"
  | "reclaimAndRefreshExistingSession"
  | "recordRestartRecoveryActivity"
  | "getOrCreateSession"
  | "observeSessionForRead"
  | "unadmittedSessionError"
  | "terminalizeExpiredPersistedSession"
>;

/** Exhaustive readers keep late injections and instance patches live without copying dependencies. */
type SessionManagerDependencyReaders = {
  [
    Key in keyof Omit<SessionManagerCollaboratorHost, keyof SessionManagerCollaboratorActions>
  ]: () => SessionManagerCollaboratorHost[Key];
};

export function createSessionManagerCollaboratorHost(
  actions: SessionManagerCollaboratorActions,
  dependencies: SessionManagerDependencyReaders,
): SessionManagerCollaboratorHost {
  const descriptors = Object.fromEntries(
    Object.entries(dependencies).map(([name, get]) => [
      name,
      { get, enumerable: true, configurable: true },
    ]),
  );
  // The mapped reader type supplies every dependency; actions supply every remaining capability.
  return Object.defineProperties({ ...actions }, descriptors) as SessionManagerCollaboratorHost;
}
