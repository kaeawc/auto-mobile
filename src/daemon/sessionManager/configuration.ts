import { type OwnerConnectedAtReader } from "../connectedOwnerStallExcuse";
import { assertCollaboratorsAttached, UNATTACHED } from "../daemonAttachedCollaborators";
import type { ObserverSessionStore } from "../observerSessionRegistry";
import { type StallForgivingLeases } from "../stallForgiveness";
import type {
  ActiveSessionExecutionChecker,
  SessionExecutionDeadlineLookup,
  ExpiryReleaseExecutionCanceller,
  DeviceAcquisitionExecutionCanceller,
  ReleaseDeviceHold,
  RecoveryExpiryReleaseHandler,
} from "../sessionManager";
/** Late daemon attachments remain live, including callbacks replaced by unit tests. */
export class SessionManagerConfiguration {
  stallProbe: (() => void) | undefined;

  /**
   * The owning daemon's id, stamped on every persisted active row so a peer daemon sharing the
   * database can tell this daemon's live rows from a dead predecessor's (#11114).
   */
  daemonSessionId: string | undefined;

  liveDaemonSessionIds: (() => ReadonlySet<string>) | undefined;

  /** False once daemon shutdown fences acquisitions that outlive request quiescence. */
  acceptingSessionCreations = true;

  observerSessions?: Pick<ObserverSessionStore, "release"> &
    Partial<Pick<ObserverSessionStore, "list">> &
    Partial<StallForgivingLeases>;

  /** Throws unless the daemon attached every late collaborator (their defaults are silent no-ops). */
  assertDaemonCollaboratorsAttached(): void {
    assertCollaboratorsAttached("SessionManager", {
      daemonSessionId: this.daemonSessionId,
      activeSessionExecutionChecker: this.activeSessionExecutionChecker,
      sessionExecutionDeadlineLookup: this.sessionExecutionDeadlineLookup,
      expiryReleaseExecutionCanceller: this.expiryReleaseExecutionCanceller,
      deviceAcquisitionExecutionCanceller: this.deviceAcquisitionExecutionCanceller,
    });
  }

  /** Attach the owning daemon's id; every later active-row write is stamped with it (#11114). */
  attachDaemonSessionId(daemonSessionId: string): void {
    this.daemonSessionId = daemonSessionId;
  }

  /**
   * Attach the live-daemon listing (the same one startup's stale-row sweep uses): a recoverable
   * row another live daemon has taken is not recovered here (#11200).
   */
  attachLiveDaemonSessionIds(provider: () => ReadonlySet<string>): void {
    this.liveDaemonSessionIds = provider;
  }

  /** A recovered row's dead owner is replaced by this daemon (#11114). */
  recoveredRowOwner(): string | null {
    return this.daemonSessionId ?? null;
  }

  /** Optional daemon wiring; existing constructors and device-session lookups stay unchanged. */
  setObserverSessionRegistry(
    registry: Pick<ObserverSessionStore, "release"> &
      Partial<Pick<ObserverSessionStore, "list">> &
      Partial<StallForgivingLeases>,
  ): void {
    this.observerSessions = registry;
    // Observer leases are excused the same stalls and host sleep as owner leases (#11554).
    registry.setStallProbe?.(this.stallProbe);
  }

  activeSessionExecutionChecker: ActiveSessionExecutionChecker =
    UNATTACHED.activeSessionExecutionChecker;

  livenessOwnerCallInFlightReader?: (ownerToken: string) => boolean;

  ownerConnectedAtReader?: OwnerConnectedAtReader;

  // No lookup means no known deadline: the veto falls back to the unsettled-execution ceiling.
  sessionExecutionDeadlineLookup: SessionExecutionDeadlineLookup =
    UNATTACHED.sessionExecutionDeadlineLookup;

  // No canceller means nothing to abort: only the daemon tracks executions (#10820).
  expiryReleaseExecutionCanceller: ExpiryReleaseExecutionCanceller =
    UNATTACHED.expiryReleaseExecutionCanceller;

  deviceAcquisitionExecutionCanceller: DeviceAcquisitionExecutionCanceller =
    UNATTACHED.deviceAcquisitionExecutionCanceller;

  recoveryExpiryReleaseHandler?: RecoveryExpiryReleaseHandler;

  setRecoveryExpiryReleaseHandler(handler: RecoveryExpiryReleaseHandler): void {
    this.recoveryExpiryReleaseHandler = handler;
  }

  /**
   * Keep sessions assigned while their work is still running, even if their
   * idle timeout elapses. The daemon supplies the execution tracker; tests can
   * inject a deterministic checker.
   */
  setActiveSessionExecutionChecker(checker: ActiveSessionExecutionChecker): void {
    this.activeSessionExecutionChecker = checker;
  }

  setLivenessOwnerCallInFlightReader(reader: ((ownerToken: string) => boolean) | undefined): void {
    this.livenessOwnerCallInFlightReader = reader;
  }

  setOwnerConnectedAtReader(reader: OwnerConnectedAtReader | undefined): void {
    this.ownerConnectedAtReader = reader;
  }

  /**
   * Sibling of {@link setActiveSessionExecutionChecker}: how the idle sweep learns the request
   * deadline that bounds an in-flight execution's veto, so it judges the veto with the same
   * shared policy as the heartbeat and owner-disconnect paths (#10712, #10713).
   */
  setSessionExecutionDeadlineLookup(lookup: SessionExecutionDeadlineLookup): void {
    this.sessionExecutionDeadlineLookup = lookup;
  }

  /**
   * How a release aborts the executions it overrides once their veto has run out (#9839, #10820):
   * the idle-expiry releases, and the heartbeat reap and owner-disconnect release that share
   * {@link cancelExecutionsCutByRelease} with them (#11400). The daemon supplies the execution
   * tracker.
   */
  setExpiryReleaseExecutionCanceller(canceller: ExpiryReleaseExecutionCanceller): void {
    this.expiryReleaseExecutionCanceller = canceller;
  }

  /**
   * How acquiring a device cancels the sessionless calls admitted on it while it was free (#10829).
   * The daemon supplies the execution tracker.
   */
  setDeviceAcquisitionExecutionCanceller(canceller: DeviceAcquisitionExecutionCanceller): void {
    this.deviceAcquisitionExecutionCanceller = canceller;
  }

  managedExecutionRecoveryListener?: (sessionId: string, recovered: Promise<unknown>) => void;

  setManagedExecutionRecoveryListener(
    listener: (sessionId: string, recovered: Promise<unknown>) => void,
  ): void {
    this.managedExecutionRecoveryListener = listener;
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
    this.acceptingSessionCreations = false;
  }

  /** False once daemon shutdown has fenced session creation; it never becomes true again. */
  isAcceptingSessionCreations(): boolean {
    return this.acceptingSessionCreations;
  }

  lateRehydrationListener?: (rehydrated: readonly string[]) => Promise<void>;

  /**
   * Notified with a session that finished rehydrating after the startup deadline (late row or
   * follow-up), so the daemon re-owns its broker binding like the startup batch (#11288).
   */
  setLateRehydrationListener(listener: (rehydrated: readonly string[]) => Promise<void>): void {
    this.lateRehydrationListener = listener;
  }

  releaseDeviceHold?: (sessionId: string) => ReleaseDeviceHold | undefined;

  /** Resolve ownership once per new release, before teardown or device-side release listeners. */
  setReleaseDeviceHold(resolver: (sessionId: string) => ReleaseDeviceHold | undefined): void {
    this.releaseDeviceHold = resolver;
  }

  /**
   * Register the detector that applies {@link forgiveDaemonStall} for a stall the monitor has not
   * yet noticed. Every expiry judgement (lookup, sweep) runs it first, so which timer fires first
   * after a stall or wake no longer decides the outcome. Pass undefined to detach.
   */
  setStallProbe(probe: (() => void) | undefined): void {
    this.stallProbe = probe;
    // The observer registry judges its own expiries, so it runs the same detector first (#11554).
    this.observerSessions?.setStallProbe?.(probe);
  }
}
