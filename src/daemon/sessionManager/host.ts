import type { SessionAcquisitionHost } from "./acquisition";
import type { SessionActivityPersistenceHost } from "./activityPersistence";
import type { SessionCacheHost } from "./cache";
import type { SessionCreationHost } from "./creation";
import type { SessionLeaseExpiryHost } from "./leaseExpiry";
import type { PersistedSessionAdmissionHost } from "./persistedAdmission";
import type { SessionPlanLabelsHost } from "./planLabelsLifecycle";
import type { SessionRebindingHost } from "./rebinding";
import type { SessionRecoveryHost } from "./recovery";
import type { SessionRehydrationHost } from "./rehydration";
import type { SessionReleasePersistenceHost } from "./releasePersistence";
import type { SessionReleaseRequestsHost } from "./releaseRequests";
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
  SessionCreationHost;

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
>;
