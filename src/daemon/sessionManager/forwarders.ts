import {
  type IosAppNetworkRule,
  type IosAppNetworkRuleCommandContext,
} from "../../features/networkFilter/IosAppNetworkRuleClient";

import { type Platform } from "../../models";

import type { ObserveResult } from "../../models/ObserveResult";

import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";

import {
  type KeepAwakeRestoreReport,
  type KeepScreenAwakeState,
} from "../../utils/KeepScreenAwakeManager";

import { SteadyWallClock } from "../../utils/SystemTimer";
import { type OwnerConnectedAtReader } from "../connectedOwnerStallExcuse";

import {
  DeviceCleanupQuarantine,
  type AbandonablePendingDeviceCleanup,
} from "../deviceCleanupQuarantine";
import type { DeviceHealthMarkers, DeviceHealthReason } from "../deviceHealthMarkers";

import { type LivenessLeaseState, type LivenessOwnerHold } from "../livenessOwnerLease";
import type { ObserverSessionStore } from "../observerSessionRegistry";
import { type DeviceReadinessLevel } from "../readiness/DeviceReadiness";
import { type SessionReleaseReason } from "../releaseReasons";
import type { ReleaseSessionRequest } from "../releaseSessionRequest";

import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import { TerminalSessionError } from "../sessionErrors";
import { SessionLivenessController } from "../sessionLivenessLease";
import { SessionAcquisition } from "./acquisition";
import { SessionActivityClocks } from "./activityClocks";
import { SessionAdmission } from "./admission";
import { SessionBookkeeping } from "./bookkeeping";
import { SessionCache } from "./cache";
import { SessionCallbacks } from "./callbacks";
import { SessionCreationGuard } from "./creationGuard";
import { ForcedStuckRelease } from "./forcedStuckRelease";
import { type SessionAcquisitionOptions } from "./internalContracts";
import { SessionLeaseExpiry } from "./leaseExpiry";
import { PersistedSessionAdmission } from "./persistedAdmission";
import { SessionPlanLabels } from "./planLabelsLifecycle";
import { SessionRebinding } from "./rebinding";
import { RecoveredTerminalReleaseIntents } from "./recoveredTerminalReleaseIntents";

import { SessionRehydration } from "./rehydration";

import { SessionReleaseRequests } from "./releaseRequests";
import { DeviceRestoreHealth } from "./restoreHealth";

import { type SessionRowWriter } from "../sessionRowWriter";
import { type LegacyLifecycleView } from "../sessionSlots";
import { SessionSlotShadowProbe } from "../sessionSlotShadowProbe";
import { type StallForgivingLeases } from "../stallForgiveness";
import { type TerminalReleaseJournal } from "../terminalReleaseJournal";
import { SessionManagerCleanup } from "./cleanup";
import { SessionManagerConfiguration } from "./configuration";
import { SessionQueries } from "./queries";

import {
  type DeviceLabelMap,
  type BiometricEnrollmentSessionState,
  type NetworkConditionSessionState,
  type ClockSessionState,
  type RotationSessionState,
  type ScreenReaderSessionState,
  type HeldDeviceSession,
  type Session,
  type SessionReleaseSnapshot,
  type SessionReleaseCallback,
  type SessionCreatedCallback,
  type ReleaseDeviceHold,
  type SessionExecutionMetadata,
  type ActiveSessionExecutionChecker,
  type SessionExecutionDeadlineLookup,
  type ExpiryReleaseExecutionCanceller,
  type DeviceAcquisitionExecutionCanceller,
  type SessionDeviceUnboundCallback,
  type SessionReleaseStage,
  type SessionDeviceAssigner,
  type SessionAccess,
  type RehydrationSummary,
  type CreateSessionOptions,
  type RebindSessionOptions,
  type RecoveryExpiryReleaseHandler,
  type ConditionalSessionRelease,
} from "../sessionManager";

export interface SessionManagerForwardersHost {
  readonly rowWriter: SessionRowWriter;
  readonly configuration: SessionManagerConfiguration;
  readonly recoveredIntents: RecoveredTerminalReleaseIntents;
  readonly restoreHealth: DeviceRestoreHealth;
  readonly sessionClock: SteadyWallClock;
  readonly callbacks: SessionCallbacks;
  readonly deviceCleanupQuarantine: DeviceCleanupQuarantine;
  readonly bookkeeping: SessionBookkeeping;
  readonly forcedStuckRelease: ForcedStuckRelease;
  readonly activityClocks: SessionActivityClocks;
  readonly creationGuard: SessionCreationGuard;
  readonly persistedAdmission: PersistedSessionAdmission;
  readonly admission: SessionAdmission;
  readonly leaseExpiry: SessionLeaseExpiry;
  readonly acquisition: SessionAcquisition;
  readonly rehydration: SessionRehydration;
  readonly rebinding: SessionRebinding;
  readonly queries: SessionQueries;
  readonly slotShadowProbe: SessionSlotShadowProbe<Session>;
  readonly releaseRequests: SessionReleaseRequests;
  readonly stateRestore: SessionDeviceStateRestore;
  readonly cache: SessionCache;
  readonly planLabelsLifecycle: SessionPlanLabels;
  readonly liveness: SessionLivenessController;
  readonly cleanup: SessionManagerCleanup;
}
/** Prototype methods keep the public facade overridable while resolving collaborators live. */
export abstract class SessionManagerForwarders {
  protected abstract readonly forwardersHost: SessionManagerForwardersHost;
  /** Retry delays for terminal release writes that failed after their deadline (#10959). */
  setTerminalReleaseRetryBackoff(backoff: BackoffPolicy): void {
    this.forwardersHost.rowWriter.setRetryBackoff(backoff);
  }
  /** Throws unless the daemon attached every late collaborator (their defaults are silent no-ops). */
  assertDaemonCollaboratorsAttached(): void {
    this.forwardersHost.configuration.assertDaemonCollaboratorsAttached();
  }
  /** Attach the owning daemon's id; every later active-row write is stamped with it (#11114). */
  attachDaemonSessionId(daemonSessionId: string): void {
    this.forwardersHost.configuration.attachDaemonSessionId(daemonSessionId);
  }
  /**
   * Attach the live-daemon listing (the same one startup's stale-row sweep uses): a recoverable
   * row another live daemon has taken is not recovered here (#11200).
   */
  attachLiveDaemonSessionIds(provider: () => ReadonlySet<string>): void {
    this.forwardersHost.configuration.attachLiveDaemonSessionIds(provider);
  }
  /**
   * Attach the terminal release journal (#10959) and adopt the intents a previous daemon left
   * unconfirmed. From here those UUIDs read as terminally released; startup rehydration then
   * writes their rows ({@link applyRecoveredTerminalReleaseIntents}).
   */
  attachTerminalReleaseJournal(journal: TerminalReleaseJournal): void {
    this.forwardersHost.recoveredIntents.attachTerminalReleaseJournal(journal);
  }
  /**
   * Write the terminal row of every recovered intent whose row is not terminal yet, and drop the
   * intents whose rows already are. A write that fails keeps its intent (and the UUID fenced) for
   * the next startup.
   */
  applyRecoveredTerminalReleaseIntents(deadlineAt?: number): Promise<string[]> {
    return this.forwardersHost.recoveredIntents.applyRecoveredTerminalReleaseIntents(deadlineAt);
  }
  /** Optional daemon wiring; existing constructors and device-session lookups stay unchanged. */
  setObserverSessionRegistry(
    registry: Pick<ObserverSessionStore, "release"> &
      Partial<Pick<ObserverSessionStore, "list">> &
      Partial<StallForgivingLeases>,
  ): void {
    this.forwardersHost.configuration.setObserverSessionRegistry(registry);
  }

  getDeviceHealthRecovery(
    deviceId: string,
    incarnation: number,
    reason: DeviceHealthReason,
  ): { recovering: boolean; retryAfterMs?: number } {
    return this.forwardersHost.restoreHealth.getDeviceHealthRecovery(deviceId, incarnation, reason);
  }

  setDeviceHealthMarkers(
    markers: DeviceHealthMarkers,
    incarnation: (deviceId: string) => number | undefined,
    canRecover: (deviceId: string) => boolean,
    backoff: BackoffPolicy = exponentialBackoff({ initialDelayMs: 1000 }),
  ): void {
    return this.forwardersHost.restoreHealth.setDeviceHealthMarkers(
      markers,
      incarnation,
      canRecover,
      backoff,
    );
  }

  markDeviceNeedsAppCleanup(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey?: string,
    sessionId?: string,
  ): void {
    return this.forwardersHost.restoreHealth.markDeviceNeedsAppCleanup(
      deviceId,
      retry,
      retryTimeoutMs,
      retryKey,
      sessionId,
    );
  }

  markDeviceNeedsRecorderTeardown(
    deviceId: string,
    retry: () => Promise<void>,
    retryTimeoutMs: number,
    retryKey?: string,
    sessionId?: string,
  ): () => void {
    return this.forwardersHost.restoreHealth.markDeviceNeedsRecorderTeardown(
      deviceId,
      retry,
      retryTimeoutMs,
      retryKey,
      sessionId,
    );
  }

  setRecoveryExpiryReleaseHandler(handler: RecoveryExpiryReleaseHandler): void {
    this.forwardersHost.configuration.setRecoveryExpiryReleaseHandler(handler);
  }
  /**
   * The current time on the clock every session timestamp (lease, idle, creation, release) is
   * stamped and judged with (#11080): wall-anchored, but advancing with the monotonic clock plus
   * measured host sleep, so a wall-clock step neither extends nor cuts a lease or an idle window.
   * Anything compared with a session timestamp must read this rather than `getTimer().now()`.
   */
  sessionNow(): number {
    return this.forwardersHost.sessionClock.now();
  }
  /**
   * An instant on the session clock as wall-clock epoch ms for a REPORT only (#11368): a fixed
   * instant reads back the same value on every query, where {@link sessionClockToWall} re-derives
   * it against the wall clock each time and jitters by a few ms. Never stored or judged.
   */
  sessionClockToReportedWall(sessionClockMs: number): number {
    return this.forwardersHost.sessionClock.toWall(sessionClockMs);
  }

  onSessionRelease(callback: SessionReleaseCallback): void {
    return this.forwardersHost.callbacks.onSessionRelease(callback);
  }

  onDeviceOwnershipChange(
    callback: (deviceId: string, frameInvalidation: "generation-only" | "full") => void,
  ): () => void {
    return this.forwardersHost.callbacks.onDeviceOwnershipChange(callback);
  }

  onSessionCreated(callback: SessionCreatedCallback): void {
    return this.forwardersHost.callbacks.onSessionCreated(callback);
  }
  /** Return outstanding post-release device work, if the device must stay quarantined. */
  getPendingDeviceCleanup(deviceId: string, ownGate?: Promise<void>): Promise<void> | null {
    return this.forwardersHost.deviceCleanupQuarantine.get(deviceId, ownGate);
  }
  /**
   * Quarantine a device until externally-dispatched session work settles.
   *
   * Callers must register the promise synchronously after dispatching work so
   * a concurrent session release observes the cleanup before returning the
   * device to the pool.
   */
  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    /** Numeric caps are trusted; only listener descriptors are manager-capped. */
    bound?: number | AbandonablePendingDeviceCleanup,
  ): void {
    this.forwardersHost.deviceCleanupQuarantine.register(deviceId, cleanup, bound);
  }

  getDeviceCleanupRetryAfterMs(deviceId: string): number {
    return this.forwardersHost.bookkeeping.getDeviceCleanupRetryAfterMs(deviceId);
  }
  /**
   * Like {@link registerPendingDeviceCleanup}, for work the current acquirer triggered on its own
   * device. While that session holds the device the work does not make
   * {@link hasDeviceCleanupInProgress} true (the holder's own reuse must not be refused); if the
   * holder releases first, the still-running work quarantines the device for the next acquirer.
   */
  registerAcquisitionDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    /** The cleanup's own cap, when it has one: it bounds the retry hint a refused bind gets. */
    capMs?: number,
  ): void {
    this.forwardersHost.deviceCleanupQuarantine.registerAcquisition(deviceId, cleanup, capMs);
  }

  hasDeviceCleanupInProgress(deviceId: string): boolean {
    return this.forwardersHost.bookkeeping.hasDeviceCleanupInProgress(deviceId);
  }

  getIdleReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return this.forwardersHost.bookkeeping.getIdleReleasesInProgress();
  }

  getNonTerminalReleasesInProgress(): {
    sessionId: string;
    startedAtMs: number;
    session: Session;
  }[] {
    return this.forwardersHost.bookkeeping.getNonTerminalReleasesInProgress();
  }

  getTerminalReleasesInProgress(): { sessionId: string; startedAtMs: number }[] {
    return this.forwardersHost.bookkeeping.getTerminalReleasesInProgress();
  }

  isReleaseInProgress(sessionId: string, startedAtMs: number): boolean {
    return this.forwardersHost.bookkeeping.isReleaseInProgress(sessionId, startedAtMs);
  }

  getReleaseStuckAtMs(sessionId: string): number | undefined {
    return this.forwardersHost.bookkeeping.getReleaseStuckAtMs(sessionId);
  }
  /**
   * Force a release that is stuck past the heartbeat monitor's deadline (#10963). The session is
   * released with the reason the stuck release carries (#11361): fenced terminally when that
   * reason is terminal (so its UUID never routes again), left recoverable or re-issuable when it
   * is not. Either way it is removed from the device maps, and its
   * device is quarantined only until the stuck release settles or {@link SESSION_RELEASE_TEARDOWN_CAP_MS}
   * passes, whichever is first; the caller then returns the device to the pool. Returns the device
   * to release and the stage the release was stuck in, or undefined when no release of this
   * session is in flight (it settled meanwhile) or it was already forced.
   */
  forceStuckRelease(
    sessionId: string,
  ): { deviceId: string; stage: SessionReleaseStage | undefined } | undefined {
    return this.forwardersHost.forcedStuckRelease.forceStuckRelease(sessionId);
  }
  /**
   * Keep sessions assigned while their work is still running, even if their
   * idle timeout elapses. The daemon supplies the execution tracker; tests can
   * inject a deterministic checker.
   */
  setActiveSessionExecutionChecker(checker: ActiveSessionExecutionChecker): void {
    this.forwardersHost.configuration.setActiveSessionExecutionChecker(checker);
  }

  setLivenessOwnerCallInFlightReader(reader: ((ownerToken: string) => boolean) | undefined): void {
    this.forwardersHost.configuration.setLivenessOwnerCallInFlightReader(reader);
  }

  setOwnerConnectedAtReader(reader: OwnerConnectedAtReader | undefined): void {
    this.forwardersHost.configuration.setOwnerConnectedAtReader(reader);
  }

  restartMintBoundClaimLeases(ownerToken: string): void {
    return this.forwardersHost.activityClocks.restartMintBoundClaimLeases(ownerToken);
  }
  /**
   * Sibling of {@link setActiveSessionExecutionChecker}: how the idle sweep learns the request
   * deadline that bounds an in-flight execution's veto, so it judges the veto with the same
   * shared policy as the heartbeat and owner-disconnect paths (#10712, #10713).
   */
  setSessionExecutionDeadlineLookup(lookup: SessionExecutionDeadlineLookup): void {
    this.forwardersHost.configuration.setSessionExecutionDeadlineLookup(lookup);
  }
  /**
   * How a release aborts the executions it overrides once their veto has run out (#9839, #10820):
   * the idle-expiry releases, and the heartbeat reap and owner-disconnect release that share
   * {@link cancelExecutionsCutByRelease} with them (#11400). The daemon supplies the execution
   * tracker.
   */
  setExpiryReleaseExecutionCanceller(canceller: ExpiryReleaseExecutionCanceller): void {
    this.forwardersHost.configuration.setExpiryReleaseExecutionCanceller(canceller);
  }
  /**
   * How acquiring a device cancels the sessionless calls admitted on it while it was free (#10829).
   * The daemon supplies the execution tracker.
   */
  setDeviceAcquisitionExecutionCanceller(canceller: DeviceAcquisitionExecutionCanceller): void {
    this.forwardersHost.configuration.setDeviceAcquisitionExecutionCanceller(canceller);
  }

  deferDeviceAcquisitionCancellation(sessionId: string): void {
    return this.forwardersHost.callbacks.deferDeviceAcquisitionCancellation(sessionId);
  }

  settleDeviceAcquisitionCancellation(sessionId: string, committed: boolean): void {
    return this.forwardersHost.callbacks.settleDeviceAcquisitionCancellation(sessionId, committed);
  }

  onSessionDeviceUnbound(callback: SessionDeviceUnboundCallback): void {
    return this.forwardersHost.callbacks.onSessionDeviceUnbound(callback);
  }

  setManagedExecutionRecoveryListener(
    listener: (sessionId: string, recovered: Promise<unknown>) => void,
  ): void {
    this.forwardersHost.configuration.setManagedExecutionRecoveryListener(listener);
  }

  createSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: CreateSessionOptions = {},
  ): Promise<Session> {
    return this.forwardersHost.creationGuard.createSession(
      sessionId,
      assignedDevice,
      platform,
      options,
    );
  }
  /**
   * Fence new session publication before daemon shutdown snapshots active work.
   *
   * A control-socket handler can outlive the bounded quiesce wait while preparing
   * a device. Its eventual DevicePool binding still reaches createSession(), so
   * this synchronous fence makes that assignment roll back instead of publishing
   * a session after the shutdown release snapshot.
   */
  stopAcceptingSessionCreations(): void {
    this.forwardersHost.configuration.stopAcceptingSessionCreations();
  }
  /** False once daemon shutdown has fenced session creation; it never becomes true again. */
  isAcceptingSessionCreations(): boolean {
    return this.forwardersHost.configuration.isAcceptingSessionCreations();
  }

  onRestartRecoveryActivity(callback: (sessionId: string, atMs: number) => void): void {
    return this.forwardersHost.persistedAdmission.onRestartRecoveryActivity(callback);
  }

  isReleasedSessionInRestartRecoveryWindow(sessionId: string): Promise<boolean> {
    return this.forwardersHost.persistedAdmission.isReleasedSessionInRestartRecoveryWindow(
      sessionId,
    );
  }

  expireRestartRecoveryReservation(sessionId: string): Promise<number | undefined> {
    return this.forwardersHost.persistedAdmission.expireRestartRecoveryReservation(sessionId);
  }

  terminalizeDeviceRestartHandoffForStop(sessionId: string): Promise<boolean> {
    return this.forwardersHost.persistedAdmission.terminalizeDeviceRestartHandoffForStop(sessionId);
  }

  findSession(sessionId: string): Session | null {
    return this.forwardersHost.admission.findSession(sessionId);
  }

  getSessionForNewExecution(
    sessionId: string,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    return this.forwardersHost.admission.getSessionForNewExecution(sessionId, execution);
  }

  deviceHeldForLateRead(
    sessionId: string,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined {
    return this.forwardersHost.leaseExpiry.deviceHeldForLateRead(sessionId, execution);
  }

  getOrCreateSession(
    sessionId: string,
    devicePool?: SessionDeviceAssigner,
    platform?: Platform,
    execution?: SessionExecutionMetadata,
    // #6069: when true, a NEW session (no live in-memory session) may only be
    // minted for an id this daemon already issued — i.e. a persisted, non-terminal
    // row (live-during-restart recovery). This is set on the device-tool path so a
    // fabricated/never-issued sessionUuid can never be auto-assigned a pooled
    // device just because a device pool is in scope. Internal fresh mints
    // (device-label derived sessions) leave it false and keep minting.
    requireIssuedSession = false,
    accessOptions: SessionAccess | SessionAcquisitionOptions = "acquire",
  ): Promise<Session> {
    return this.forwardersHost.admission.getOrCreateSession(
      sessionId,
      devicePool,
      platform,
      execution,
      requireIssuedSession,
      accessOptions,
    );
  }

  admitIssuedSessionForAutomation(
    sessionId: string,
    execution?: SessionExecutionMetadata,
    options: { access?: SessionAccess; signal?: AbortSignal } = {},
  ): Promise<Session | undefined> {
    return this.forwardersHost.acquisition.admitIssuedSessionForAutomation(
      sessionId,
      execution,
      options,
    );
  }

  rehydratePersistedSessions(
    devicePool: SessionDeviceAssigner,
    options: { deadlineMs?: number; concurrency?: number; signal?: AbortSignal } = {},
  ): Promise<RehydrationSummary> {
    return this.forwardersHost.rehydration.rehydratePersistedSessions(devicePool, options);
  }
  /**
   * Notified with a session that finished rehydrating after the startup deadline (late row or
   * follow-up), so the daemon re-owns its broker binding like the startup batch (#11288).
   */
  setLateRehydrationListener(listener: (rehydrated: readonly string[]) => Promise<void>): void {
    this.forwardersHost.configuration.setLateRehydrationListener(listener);
  }

  rebindSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    options: RebindSessionOptions = {},
  ): Promise<Session> {
    return this.forwardersHost.rebinding.rebindSession(
      sessionId,
      assignedDevice,
      platform,
      options,
    );
  }

  rebindSessionForTerminalReleaseRecovery(
    session: Session,
    assignedDevice: string,
    platform: Platform,
  ): Promise<Session> {
    return this.forwardersHost.rebinding.rebindSessionForTerminalReleaseRecovery(
      session,
      assignedDevice,
      platform,
    );
  }

  flushDeferredRebindCleanups(filter: { sessionId?: string; deviceId?: string } = {}): void {
    return this.forwardersHost.rebinding.flushDeferredRebindCleanups(filter);
  }
  /**
   * Get device assigned to a session
   */
  getDeviceForSession(sessionId: string): string | null {
    return this.forwardersHost.queries.getDeviceForSession(sessionId);
  }
  /** Final reason for this exact identity, including releases joined during teardown. */
  getFinalizedReleaseReason(session: Session): string | undefined {
    return this.forwardersHost.queries.getFinalizedReleaseReason(session);
  }

  getReleasedSessionReason(sessionId: string): Promise<string | undefined> {
    return this.forwardersHost.admission.getReleasedSessionReason(sessionId);
  }

  getExpiredReleaseSnapshot(sessionId: string): Promise<SessionReleaseSnapshot | undefined> {
    return this.forwardersHost.admission.getExpiredReleaseSnapshot(sessionId);
  }

  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined {
    return this.forwardersHost.queries.getTerminalReleaseSnapshot(sessionId);
  }

  reserveSessionForTerminalRelease(session: Session, expectedDeviceId: string): () => void {
    return this.forwardersHost.admission.reserveSessionForTerminalRelease(
      session,
      expectedDeviceId,
    );
  }
  /**
   * Get session assigned to a device (reverse lookup)
   */
  getSessionForDevice(deviceId: string): string | null {
    return this.forwardersHost.queries.getSessionForDevice(deviceId);
  }
  /** The same holders as getSessionForDevice, including expired and releasing sessions. */
  getHeldDeviceSessions(): readonly HeldDeviceSession[] {
    return this.forwardersHost.queries.getHeldDeviceSessions();
  }
  /** Map membership, including fenced releases and any newer same-UUID incarnation. */
  hasSession(sessionId: string): boolean {
    return this.forwardersHost.queries.hasSession(sessionId);
  }
  /**
   * Whether this daemon holds `sessionId` as a live broker binding execution (#11275): present, on
   * the `managed-execution` policy and not being released. The stored idle deadline does not
   * decide managed liveness; a lapsed owner lease stays live until the heartbeat path actually
   * releases the session. A rehydrated session waiting for its proxy counts until released too.
   * Side-effect free apart from the stall probe every lookup runs.
   */
  isLiveManagedExecutionSession(sessionId: string): boolean {
    return this.forwardersHost.queries.isLiveManagedExecutionSession(sessionId);
  }
  /** Read-only shadow adapter; its maps reflect subsequent lifecycle mutations. */
  getLegacyLifecycleView(): LegacyLifecycleView<Session> {
    return this.forwardersHost.queries.getLegacyLifecycleView();
  }
  /** Explicit checks also cover retained older incarnations in agreement tests. */
  checkSlotShadowAgreement(uuid: string, event: string, identities: readonly Session[] = []): void {
    this.forwardersHost.slotShadowProbe.check(uuid, event, identities);
  }

  isCurrentSession(session: Session): boolean {
    return this.forwardersHost.queries.isCurrentSession(session);
  }

  isAdmittedForAutomation(session: Session): boolean {
    return this.forwardersHost.queries.isAdmittedForAutomation(session);
  }
  /** Read ownership without admission, expiry cleanup or the stall probe (release guard, #11920). */
  getSessionLivenessOwnerToken(sessionId: string): string | undefined {
    return this.forwardersHost.queries.getSessionLivenessOwnerToken(sessionId);
  }
  /** Resolve an admitted release even after ordinary session lookup hides its identity. */
  getReleasingSession(sessionId: string): Session | null {
    return this.forwardersHost.queries.getReleasingSession(sessionId);
  }
  /** Whether this is the newest published, releasing, or finalized incarnation for its UUID. */
  isLatestSessionIdentity(
    session: Session,
    options: { ignorePendingAssignment?: boolean } = {},
  ): boolean {
    return this.forwardersHost.queries.isLatestSessionIdentity(session, options);
  }

  releaseSession(
    sessionId: string,
    releaseReason: SessionReleaseReason = "explicit-release",
    request: ReleaseSessionRequest = {},
  ): Promise<string | null> {
    return this.forwardersHost.releaseRequests.releaseSession(sessionId, releaseReason, request);
  }
  /** Resolve ownership once per new release, before teardown or device-side release listeners. */
  setReleaseDeviceHold(resolver: (sessionId: string) => ReleaseDeviceHold | undefined): void {
    this.forwardersHost.configuration.setReleaseDeviceHold(resolver);
  }

  releaseSessionUnlessSuperseded(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    request: ReleaseSessionRequest = {},
  ): Promise<ConditionalSessionRelease> {
    return this.forwardersHost.releaseRequests.releaseSessionUnlessSuperseded(
      sessionId,
      releaseReason,
      request,
    );
  }

  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.forwardersHost.bookkeeping.trackSessionSetup(session, createSetup);
  }

  drainReleasePromises(
    timeoutMs: number,
    additionalReleases: ReadonlyArray<Promise<unknown>> = [],
  ): Promise<boolean> {
    return this.forwardersHost.bookkeeping.drainReleasePromises(timeoutMs, additionalReleases);
  }

  waitForSessionRelease(sessionId: string): Promise<void> {
    return this.forwardersHost.bookkeeping.waitForSessionRelease(sessionId);
  }

  waitForSessionReleaseWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.forwardersHost.bookkeeping.waitForSessionReleaseWithin(sessionId, timeoutMs);
  }

  beginIosAppNetworkRule(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    return this.forwardersHost.stateRestore.beginIosAppNetworkRule(session, target);
  }

  prepareIosAppNetworkReset(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    return this.forwardersHost.stateRestore.prepareIosAppNetworkReset(session, target);
  }

  confirmIosAppNetworkRule(session: Session, rule: IosAppNetworkRule): void {
    this.forwardersHost.stateRestore.confirmIosAppNetworkRule(session, rule);
  }

  finishIosAppNetworkReset(session: Session, rule: IosAppNetworkRule): void {
    this.forwardersHost.stateRestore.finishIosAppNetworkReset(session, rule);
  }
  /** The iOS rule whose lease this session is renewing, if any (diagnostics and tests). */
  activeIosAppNetworkLease(sessionId: string): IosAppNetworkRule | undefined {
    return this.forwardersHost.stateRestore.activeIosAppNetworkLease(sessionId);
  }
  /** Arm a per-condition network TTL; see {@link SessionDeviceStateRestore}. */
  scheduleNetworkConditionExpiry(
    session: Session,
    expiresInSeconds: number,
    generation?: number,
  ): void {
    this.forwardersHost.stateRestore.scheduleNetworkConditionExpiry(
      session,
      expiresInSeconds,
      generation,
    );
  }

  peekNetworkConditionExpiry(
    sessionId: string,
  ): { deadlineMs: number; generation: number } | undefined {
    return this.forwardersHost.stateRestore.peekNetworkConditionExpiry(sessionId);
  }

  rearmNetworkConditionExpiry(
    session: Session,
    snapshot: { deadlineMs: number; generation: number },
  ): void {
    this.forwardersHost.stateRestore.rearmNetworkConditionExpiry(session, snapshot);
  }

  cancelNetworkConditionExpiry(sessionId: string): void {
    this.forwardersHost.stateRestore.cancelNetworkConditionExpiry(sessionId);
  }

  setLastRenderedObservation(
    sessionId: string,
    observation: ObserveResult,
    displayRevision?: number,
  ): void {
    return this.forwardersHost.cache.setLastRenderedObservation(
      sessionId,
      observation,
      displayRevision,
    );
  }

  getLastActionMetadata(
    sessionId: string,
    deviceId: string,
  ): Readonly<Record<string, unknown>> | undefined {
    return this.forwardersHost.cache.getLastActionMetadata(sessionId, deviceId);
  }

  setLastActionMetadata(
    sessionId: string,
    deviceId: string,
    blocks: Record<string, unknown>,
  ): void {
    return this.forwardersHost.cache.setLastActionMetadata(sessionId, deviceId, blocks);
  }

  getLastRenderedObservation(sessionId: string): ObserveResult | undefined {
    return this.forwardersHost.cache.getLastRenderedObservation(sessionId);
  }

  setLastRenderedDisplayRevision(
    sessionId: string,
    revision: number,
    key?: string,
    generation?: number,
  ): void {
    return this.forwardersHost.cache.setLastRenderedDisplayRevision(
      sessionId,
      revision,
      key,
      generation,
    );
  }

  getLastRenderedDisplayGeneration(sessionId: string): number | undefined {
    return this.forwardersHost.cache.getLastRenderedDisplayGeneration(sessionId);
  }

  setDisplayPin(sessionId: string, pin: string | null): void {
    return this.forwardersHost.cache.setDisplayPin(sessionId, pin);
  }

  getDisplayPin(sessionId: string): string | undefined {
    return this.forwardersHost.cache.getDisplayPin(sessionId);
  }

  getLastRenderedDisplayKey(sessionId: string): string | undefined {
    return this.forwardersHost.cache.getLastRenderedDisplayKey(sessionId);
  }

  getLastRenderedDisplayRevision(sessionId: string): number | undefined {
    return this.forwardersHost.cache.getLastRenderedDisplayRevision(sessionId);
  }

  getKeepScreenAwake(sessionId: string): KeepScreenAwakeState | undefined {
    return this.forwardersHost.cache.getKeepScreenAwake(sessionId);
  }

  setDeviceReadiness(sessionId: string, level: DeviceReadinessLevel): void {
    return this.forwardersHost.cache.setDeviceReadiness(sessionId, level);
  }

  getDeviceReadiness(sessionId: string): DeviceReadinessLevel | undefined {
    return this.forwardersHost.cache.getDeviceReadiness(sessionId);
  }

  invalidateAutomationReadiness(sessionId: string, reason: string): void {
    return this.forwardersHost.cache.invalidateAutomationReadiness(sessionId, reason);
  }

  setClock(session: Session, state: ClockSessionState): void {
    return this.forwardersHost.cache.setClock(session, state);
  }

  getClock(sessionId: string): ClockSessionState | undefined {
    return this.forwardersHost.cache.getClock(sessionId);
  }

  getKeepAwakeRestoreReport(sessionId: string): KeepAwakeRestoreReport | undefined {
    return this.forwardersHost.cache.getKeepAwakeRestoreReport(sessionId);
  }

  trackClockSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.forwardersHost.cache.trackClockSessionSetup(session, createSetup);
  }

  runClockMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.forwardersHost.cache.runClockMutationExclusive(sessionId, fn);
  }

  setRotation(session: Session, state: RotationSessionState): void {
    return this.forwardersHost.cache.setRotation(session, state);
  }

  getRotation(sessionId: string): RotationSessionState | undefined {
    return this.forwardersHost.cache.getRotation(sessionId);
  }

  trackRotationSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.forwardersHost.cache.trackRotationSessionSetup(session, createSetup);
  }

  runRotationMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.forwardersHost.cache.runRotationMutationExclusive(sessionId, fn);
  }

  trackScreenReaderSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.forwardersHost.cache.trackScreenReaderSessionSetup(session, createSetup);
  }

  setScreenReader(session: Session, state: ScreenReaderSessionState): void {
    return this.forwardersHost.cache.setScreenReader(session, state);
  }

  getScreenReader(sessionId: string): ScreenReaderSessionState | undefined {
    return this.forwardersHost.cache.getScreenReader(sessionId);
  }

  runScreenReaderMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.forwardersHost.cache.runScreenReaderMutationExclusive(sessionId, fn);
  }

  setBiometricEnrollment(sessionId: string, state: BiometricEnrollmentSessionState): void {
    return this.forwardersHost.cache.setBiometricEnrollment(sessionId, state);
  }

  getBiometricEnrollment(sessionId: string): BiometricEnrollmentSessionState | undefined {
    return this.forwardersHost.cache.getBiometricEnrollment(sessionId);
  }

  setNetworkCondition(sessionId: string, state: NetworkConditionSessionState): void {
    return this.forwardersHost.cache.setNetworkCondition(sessionId, state);
  }

  bumpNetworkConditionGeneration(sessionId: string): number {
    return this.forwardersHost.cache.bumpNetworkConditionGeneration(sessionId);
  }

  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.forwardersHost.cache.runNetworkConditionMutationExclusive(sessionId, fn);
  }

  getNetworkCondition(sessionId: string): NetworkConditionSessionState | undefined {
    return this.forwardersHost.cache.getNetworkCondition(sessionId);
  }

  openPlanLabelMints(baseSessionId: string, labels: DeviceLabelMap): () => void {
    return this.forwardersHost.planLabelsLifecycle.openPlanLabelMints(baseSessionId, labels);
  }

  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined {
    return this.forwardersHost.planLabelsLifecycle.getBaseSessionOfDerivedLabel(sessionId);
  }

  isLiveSessionOfSamePlan(sessionId: string, otherSessionId: string): boolean {
    return this.forwardersHost.planLabelsLifecycle.isLiveSessionOfSamePlan(
      sessionId,
      otherSessionId,
    );
  }

  takeDerivedLabelSessions(baseSessionId: string, releaseReason?: string): string[] {
    return this.forwardersHost.planLabelsLifecycle.takeDerivedLabelSessions(
      baseSessionId,
      releaseReason,
    );
  }

  getDeviceLabels(sessionId: string): DeviceLabelMap | undefined {
    return this.forwardersHost.cache.getDeviceLabels(sessionId);
  }

  recordToolCallEnded(sessionId: string, end: { admitted: boolean } = { admitted: true }): void {
    return this.forwardersHost.activityClocks.recordToolCallEnded(sessionId, end);
  }

  terminalAnswerForEndedSession(
    sessionId: string,
    callerExecutionId?: string,
  ): TerminalSessionError | undefined {
    return this.forwardersHost.admission.terminalAnswerForEndedSession(
      sessionId,
      callerExecutionId,
    );
  }

  peekTerminalAnswerForEndedSession(sessionId: string): TerminalSessionError | undefined {
    return this.forwardersHost.admission.peekTerminalAnswerForEndedSession(sessionId);
  }

  ownershipSessionUuid(sessionId: string): string {
    return this.forwardersHost.leaseExpiry.ownershipSessionUuid(sessionId);
  }

  getOwnerLeaseHold(sessionId: string): LivenessOwnerHold | undefined {
    return this.forwardersHost.leaseExpiry.getOwnerLeaseHold(sessionId);
  }

  getSessionLeaseState(sessionId: string): LivenessLeaseState | undefined {
    return this.forwardersHost.leaseExpiry.getSessionLeaseState(sessionId);
  }

  ownerLeaseAwaitsReap(sessionId: string): boolean {
    return this.forwardersHost.leaseExpiry.ownerLeaseAwaitsReap(sessionId);
  }

  judgedLeaseHeartbeat(session: Session): number {
    return this.forwardersHost.leaseExpiry.judgedLeaseHeartbeat(session);
  }

  creditOwnerHeartbeatDuringRelease(sessionId: string, ownerToken: string): void {
    return this.forwardersHost.leaseExpiry.creditOwnerHeartbeatDuringRelease(sessionId, ownerToken);
  }
  /**
   * Register the detector that applies {@link forgiveDaemonStall} for a stall the monitor has not
   * yet noticed. Every expiry judgement (lookup, sweep) runs it first, so which timer fires first
   * after a stall or wake no longer decides the outcome. Pass undefined to detach.
   */
  setStallProbe(probe: (() => void) | undefined): void {
    this.forwardersHost.configuration.setStallProbe(probe);
  }

  startRehydratedOwnerWindows(): number {
    return this.forwardersHost.activityClocks.startRehydratedOwnerWindows();
  }

  forgiveDaemonStall(resumedAt: number, lostMs: number, sleptMs = 0, gapBeganAt?: number): number {
    return this.forwardersHost.activityClocks.forgiveDaemonStall(
      resumedAt,
      lostMs,
      sleptMs,
      gapBeganAt,
    );
  }

  clearSessionCache(sessionId: string, key?: string): void {
    return this.forwardersHost.cache.clearSessionCache(sessionId, key);
  }
  /**
   * Get count of active sessions
   */
  getActiveSessionCount(): number {
    return this.forwardersHost.queries.getActiveSessionCount();
  }
  /**
   * Get all active sessions
   */
  getAllSessions(): Session[] {
    return this.forwardersHost.queries.getAllSessions();
  }
  /** Snapshot every in-memory session, including expired entries awaiting cleanup. */
  getAllSessionIds(): string[] {
    return this.forwardersHost.queries.getAllSessionIds();
  }
  /**
   * Snapshot every session identity that is published or still completing
   * creation, assignment, rebind, or early-release work.
   */
  getAllKnownSessionIds(): string[] {
    return this.forwardersHost.queries.getAllKnownSessionIds();
  }
  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): Set<string> {
    return this.forwardersHost.queries.getAssignedDevices();
  }

  getIdleReleaseExecutionVeto(sessionId: string): { latestDeadlineMs?: number } | undefined {
    return this.forwardersHost.leaseExpiry.getIdleReleaseExecutionVeto(sessionId);
  }

  cancelExecutionsCutByRelease(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean {
    return this.forwardersHost.leaseExpiry.cancelExecutionsCutByRelease(
      sessionId,
      releaseReason,
      excludeExecutionId,
    );
  }

  cleanupExpiredSessions(): void {
    return this.forwardersHost.activityClocks.cleanupExpiredSessions();
  }

  stopCleanupTimer(): void {
    this.forwardersHost.cleanup.stopCleanupTimer();
  }
  /**
   * Get statistics for monitoring
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
    assignedDevices: number;
  } {
    return this.forwardersHost.queries.getStats();
  }
}
