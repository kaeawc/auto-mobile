export type {
  ActiveSessionExecutionChecker,
  ActiveSessionExecutionQuery,
  DeviceAcquisitionExecutionCanceller,
  ExpiryReleaseExecutionCanceller,
  SessionExecutionDeadlineLookup,
  SessionExecutionMetadata,
} from "./executionTypes";

export type {
  RehydrationDeviceReservation,
  RehydrationSummary,
  SessionDeviceAssigner,
  SessionRecoveryFailureReason,
  SessionRecoveryForeignOwner,
  SessionRecoveryLiveness,
  SessionRecoveryTarget,
} from "./recoveryTypes";

export { releaseWasForced } from "./releaseTypes";

export type {
  ConditionalSessionRelease,
  RecoveryExpiryReleaseHandler,
  ReleaseCommitFence,
  ReleaseDeviceHold,
  SessionDeviceUnboundCallback,
  SessionReleaseCallback,
  SessionReleaseOperation,
  SessionReleaseOptions,
  SessionReleaseSnapshot,
  SessionReleaseStage,
} from "./releaseTypes";

export type {
  BiometricEnrollmentRestorer,
  BiometricEnrollmentSessionState,
  ClockRestorer,
  ClockSessionState,
  DeviceStateRestorerFactories,
  KeepScreenAwakeRestorer,
  NetworkConditionRestorer,
  NetworkConditionSessionState,
  ReleaseTeardownStage,
  RotationRestorer,
  RotationSessionState,
  ScreenReaderRestorer,
  ScreenReaderSessionState,
  SessionManagerOptions,
} from "./restorerTypes";

export {
  ANONYMOUS_ACQUISITION_SESSION_SOURCE,
  BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS,
  CLOCK_RESTORE_TIMEOUT_MS,
  DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS,
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  getDefaultPreFirstHeartbeatGraceMs,
  getDefaultSessionHeartbeatTimeoutMs,
  getSessionReleaseCleanupWorstCaseMs,
  getSessionReleaseStuckDeadlineMs,
  isAnonymousAcquisitionSession,
  KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS,
  NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS,
  NETWORK_CONDITION_RESTORE_TIMEOUT_MS,
  PLAN_AUTO_RELEASE_REASON,
  PLAN_LABEL_SESSION_SOURCE,
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  SESSION_CREATION_TIMEOUT_REASON,
  SESSION_REHYDRATION_CONCURRENCY,
  SESSION_REHYDRATION_DEADLINE_MS,
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SESSION_RELEASE_STUCK_DEADLINE_MS,
  SESSION_RELEASE_STUCK_MARGIN_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  SESSION_SETUP_DRAIN_TIMEOUT_MS,
} from "./sessionConstants";

export type {
  CreateSessionOptions,
  DeviceLabelMap,
  HeldDeviceSession,
  LivenessClaimOutcome,
  LivenessReleaseOutcome,
  PreCliLivenessSnapshot,
  RebindSessionOptions,
  Session,
  SessionAccess,
  SessionCacheData,
  SessionCreatedCallback,
  SessionLivenessPolicy,
} from "./sessionTypes";

export * from "../releaseErrors";

export { SessionActivityPersistenceError } from "./SessionActivityPersistenceError";

export {
  DaemonSessionCreationRejectedError,
  SessionHeldByRecoveryError,
  SessionRebindingError,
  SessionSuspectError,
  SessionTerminalReleaseInProgressError,
  TerminalSessionError,
} from "../sessionErrors";

export { SessionRecoveryIdentityLossError } from "./SessionRecoveryIdentityLossError";

export {
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
} from "../../models/deviceAcquisitionRefusals";
export { SessionNoLongerOwnsDeviceError } from "../../models/sessionNoLongerOwnsDevice";

export type { AbandonablePendingDeviceCleanup } from "../deviceCleanupQuarantine";

// The superseded-row rewrite retry policy moved to the row writer's ledger (#11799 W3).
export { UnissuedSessionError } from "./UnissuedSessionError";

export { SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS } from "../supersededRowReasserts";

/**
 * The CLI idle-timeout contract lives in `./constants` so the CLI-side proxy can
 * resolve its own override without importing the daemon's session machinery
 * (issue #6870 review). Re-exported here for the daemon-side callers and tests
 * that have always read it from this module.
 */
export { DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS, getCliSessionIdleTimeoutMs } from "../wire/constants";
