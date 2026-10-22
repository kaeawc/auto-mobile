export const SESSIONLESS_DEVICE_ACQUIRED_REMEDY =
  "another session acquired it while this call was in flight, so the call was cancelled. " +
  "Acquire the device (setActiveDevice) and retry with that session's sessionUuid, or wait for " +
  "the holder to release it.";

export interface ActiveExecution {
  id: string;
  toolName: string;
  sessionId?: string;
  transportSessionId?: string;
  sessionUuid?: string;
  resolvedAutolockSessionUuid?: string;
  /** Captured when an untargeted device call starts, until routing finishes. */
  provisionalAutolockSessionUuid?: string;
  deviceIds?: Set<string>;
  /** When the call started, on the tracker's wall clock. */
  startTime: number;
  /**
   * {@link startTime} on the session clock, by the offset in force when the call started (#11290):
   * session stamps such as the idle deadline are judged against this, so a later wall-clock step
   * cannot move the call's start across them.
   */
  sessionClockStartTime: number;
  abortController: AbortController;
  /**
   * The reason this execution was cancelled, recorded synchronously at cancellation time for
   * device-disconnected cancellations. This is the tracker's own authoritative record of *why*
   * it aborted — consumers should read it instead of `abortController.signal.reason`, whose
   * observability is unreliable on some runtimes under load (macOS CI Bun flake, issue #3909).
   */
  cancelReason?: Error;
  /** Client cancellation only removes this call's admission liveness, not its release veto. */
  requestCancelled?: boolean;
  /**
   * Devices this execution's session has left (a `setActiveDevice` rebind), with the rebind
   * reason. Binding the execution to one of them is refused (#9958).
   */
  revokedDeviceBindings?: Map<string, Error>;
  /**
   * The call only reads device inventory (`listDevices {sessionUuid}` and friends). Such a call is
   * admitted without refreshing the session's activity, so its end does not count as session use
   * either: a poller must not keep a dead owner's session alive.
   */
  readOnlySessionAccess?: boolean;
  /**
   * The call passed session admission (#10824). A call refused at admission (a suspect or expired
   * session, a non-holder) still ends, and its end must not restart the session's idle or liveness
   * clocks: only an admitted call is session use.
   */
  sessionAdmitted?: boolean;
  /**
   * The call was a device read (`deviceReadOnly` for its args): watching, which is not use of the
   * session it ran under (#10964, #10974).
   */
  deviceReadCall?: boolean;
  /**
   * A device-aware control step ran under this execution (#11322 review): its own tool, or a
   * nested one. It is use of the session whatever else the execution did, so the execution is
   * never a read again.
   */
  deviceControlCall?: boolean;
  /**
   * Reads the request's current absolute deadline (live: progress may extend it), on the
   * tracker's clock. Undefined when the call was admitted without a deadline (#10712).
   */
  readDeadlineMs?: () => number | undefined;
  /**
   * Session clock minus wall clock when the deadline was last stamped (#11105): a wall-clock
   * step after that moves the wall deadline's meaning but not the offset recorded here, so the
   * deadline can be read on the session clock without the step. Re-captured on every progress
   * extension, which restamps the deadline with the then-current wall clock (#11123).
   */
  sessionClockOffsetMs?: number;
  /** Stops following the deadline's progress extensions; run when the execution ends. */
  unsubscribeDeadlineExtensions?: () => void;
  /**
   * Devices this call was admitted to drive without a session, because no session held them
   * (#10829). Acquisition cancels control calls or only a read's readiness; reads then watch.
   */
  sessionlessDeviceUse?: Set<string>;
  sessionlessControlUse?: Set<string>;
  sessionlessReadReadiness?: Map<string, Set<AbortController>>;
}

/**
 * What the session manager needs to know about a tracked call to judge it against a session's
 * stamps: its id and its start on both clocks (#11290). Every producer of that metadata builds
 * it here, so none can hand over a wall-clock start alone.
 */
export function sessionExecutionMetadataOf(execution: ActiveExecution): {
  executionId: string;
  startTime: number;
  sessionClockStartTime: number;
} {
  return {
    executionId: execution.id,
    startTime: execution.startTime,
    sessionClockStartTime: execution.sessionClockStartTime,
  };
}

/** How a session-bearing execution ended: whether it was ever admitted under its session. */
export interface SessionExecutionEnd {
  admitted: boolean;
  toolName: string;
}

export type SessionExecutionEndListener = (
  sessionUuids: readonly string[],
  end: SessionExecutionEnd,
) => void;

export type ExecutionScope = "session" | "global";

export interface ExecutionScopeOptions {
  scope: ExecutionScope;
  sessionId?: string;
  sessionUuid?: string;
}

export interface ExecutionCancellationOptions {
  /** Restrict a device cancellation to the owning kind of operation (e.g. executePlan). */
  onlyToolName?: string;
  /**
   * Keeps the control-plane operation that triggered a device shutdown alive
   * while cancelling the device-bound work that must fail fast.
   */
  excludeExecutionId?: string;
  /**
   * Restricts the cancellation to executions that belong to this device session
   * (explicit, resolved-autolock or still-provisional autolock membership), so
   * another session's or a sessionless call on the same device is left alone.
   */
  onlySessionUuid?: string;
  /**
   * Executions that pass {@link onlySessionUuid} whatever session they were recorded under
   * (#14443): ingress records a label-routed executePlan under its derived session (base:B),
   * while plan-time loss names its owner (base) and the captured invocation ids.
   */
  includeExecutionIds?: readonly string[];
}

export type ExecutionCancellationReason = string | Error;

export interface ActiveExecutionQuery {
  onlyToolName?: string;
  startedAtOrBefore?: number;
  /** Bound the captured session-clock start rather than its wall-clock counterpart (#11290). */
  sessionClockStartedAtOrBefore?: number;
  /** Admission only: count non-aborted work within its deadline or its undated allowance. */
  liveOnSessionClock?: { at: number; undatedForMs: number };
  excludeExecutionId?: string;
  /** Same session filter as {@link ExecutionCancellationOptions.onlySessionUuid}. */
  onlySessionUuid?: string;
  /**
   * Count control calls only (#11322): a read (an inventory read or a device read) watches the
   * session, it is not use of it and never counts as its owner's liveness.
   */
  excludeReads?: boolean;
}

/** A call that only watches: an inventory read or a device read (#10964, #11107). */
export function isReadExecution(execution: ActiveExecution): boolean {
  return (
    execution.deviceControlCall !== true &&
    (execution.readOnlySessionAccess === true || execution.deviceReadCall === true)
  );
}

/**
 * An execution's request deadline, unbounded when it has none. On the session clock a finite wall
 * deadline moves by the offset it was stamped under; infinity stays infinite.
 */
export function executionDeadlineMs(execution: ActiveExecution, onSessionClock?: boolean): number {
  const wallDeadline = execution.readDeadlineMs?.() ?? Number.POSITIVE_INFINITY;
  return onSessionClock ? wallDeadline + (execution.sessionClockOffsetMs ?? 0) : wallDeadline;
}

/** Admission liveness uses the captured deadline clock, never a later wall-clock offset. */
function isLiveOnSessionClock(
  execution: ActiveExecution | undefined,
  live: NonNullable<ActiveExecutionQuery["liveOnSessionClock"]>,
): boolean {
  if (
    execution === undefined ||
    execution.requestCancelled === true ||
    execution.abortController.signal.aborted
  ) {
    return false;
  }
  const deadline = executionDeadlineMs(execution, true);
  const liveUntil = Number.isFinite(deadline)
    ? deadline
    : execution.sessionClockStartTime + live.undatedForMs;
  return live.at <= liveUntil;
}

/** Whether `query` leaves this execution out by id, session-clock start, liveness or as a read. */
export function isExcludedByQuery(
  executionId: string,
  execution: ActiveExecution | undefined,
  query: ActiveExecutionQuery | undefined,
): boolean {
  if (query === undefined) {
    return false;
  }
  if (executionId === query.excludeExecutionId) {
    return true;
  }
  if (
    query.sessionClockStartedAtOrBefore !== undefined &&
    (execution === undefined ||
      execution.sessionClockStartTime > query.sessionClockStartedAtOrBefore)
  ) {
    return true;
  }
  if (query.liveOnSessionClock && !isLiveOnSessionClock(execution, query.liveOnSessionClock)) {
    return true;
  }
  return query.excludeReads === true && execution !== undefined && isReadExecution(execution);
}

/** Whether `query` filters nothing, so any tracked execution answers it. */
export function isUnfilteredQuery(query: ActiveExecutionQuery | undefined): boolean {
  if (query === undefined) {
    return true;
  }
  return (
    query.startedAtOrBefore === undefined &&
    query.sessionClockStartedAtOrBefore === undefined &&
    query.liveOnSessionClock === undefined &&
    query.excludeExecutionId === undefined &&
    query.onlyToolName === undefined &&
    query.onlySessionUuid === undefined &&
    !query.excludeReads
  );
}

export type DaemonRestartAdmission = "accepted" | "active_operations" | "restart_pending";

export interface ActiveProvisionDeviceQuery {
  hasActiveProvisionDeviceOperation(): boolean;
}

export interface AutolockSessionResolver {
  autolockSessionForMcpSession(mcpSessionId: string): string | undefined;
}

export type DaemonMaintenanceAdmission =
  | "accepted"
  | "active_operations"
  | "active_sessions"
  | "maintenance_pending";

/**
 * Session clock minus wall clock. An execution's start passes `wallNowMs`, the tracker's own
 * reading of that start, so a provider can subtract it instead of reading a wall clock again.
 * A harness that runs the session clock on a fake timer under this wall-clock tracker must: a
 * second read can land on the next millisecond, which dates the execution 1 ms early, on or before
 * an idle deadline the call arrived after (#11576). A deadline is stamped by its caller, so no
 * reading is passed for it.
 */
export type SessionClockOffsetProvider = (wallNowMs?: number) => number;
