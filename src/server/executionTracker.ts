import { isDeviceLossCancellationReason } from "../daemon/emulatorLossIncident";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { errorMessage } from "../utils/describeUnknownError";
import { ActionableError } from "../models/ActionableError";
import {
  deviceLostErrorFromCancellationReason,
  isDeviceLostError,
  rememberDeviceLossAbort,
} from "./deviceLossOutcome";
import { DaemonRestartPendingError } from "../daemon/daemonRestartAdmission";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";

const SESSIONLESS_DEVICE_ACQUIRED_REMEDY =
  "another session acquired it while this call was in flight, so the call was cancelled. " +
  "Acquire the device (setActiveDevice) and retry with that session's sessionUuid, or wait for " +
  "the holder to release it.";

interface ActiveExecution {
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
   * (#10829). A session that acquires one of them cancels the call: it may not keep driving the
   * new holder's device.
   */
  sessionlessDeviceUse?: Set<string>;
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
}

export type ExecutionCancellationReason = string | Error;

export interface ActiveExecutionQuery {
  onlyToolName?: string;
  startedAtOrBefore?: number;
  excludeExecutionId?: string;
  /** Same session filter as {@link ExecutionCancellationOptions.onlySessionUuid}. */
  onlySessionUuid?: string;
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

export class ExecutionTracker {
  private executions = new Map<string, ActiveExecution>();
  private sessionExecutions = new Map<string, Set<string>>();
  private deviceExecutions = new Map<string, Set<string>>();
  /** Last time a tool execution bound to or finished on each device (#10497). */
  private deviceLastActivityAt = new Map<string, number>();
  private sessionUuidExecutions = new Map<string, Set<string>>();
  private autolockSessionExecutions = new Map<string, Set<string>>();
  private executionEndListeners = new Set<() => void>();
  private sessionExecutionEndListeners = new Set<SessionExecutionEndListener>();
  private timer: Timer;
  private idGenerator: IdGenerator;
  private daemonRestartPrepared = false;
  private daemonMaintenancePrepared = false;
  private activeProvisionDeviceQuery?: ActiveProvisionDeviceQuery;
  private autolockSessionResolver?: AutolockSessionResolver;
  private sessionClockOffsetProvider: () => number = () => 0;

  constructor(timer: Timer = defaultTimer, idGenerator: IdGenerator = defaultIdGenerator) {
    this.timer = timer;
    this.idGenerator = idGenerator;
  }

  /**
   * Where the session clock stands relative to this tracker's wall clock (session minus wall),
   * read when an execution starts (#11290) and when its deadline is recorded (#11105).
   */
  setSessionClockOffsetProvider(provider: () => number): void {
    this.sessionClockOffsetProvider = provider;
  }

  setActiveProvisionDeviceQuery(query: ActiveProvisionDeviceQuery): void {
    this.activeProvisionDeviceQuery = query;
  }

  setAutolockSessionResolver(resolver: AutolockSessionResolver): void {
    this.autolockSessionResolver = resolver;
  }

  startExecution(
    toolName: string,
    sessionId?: string,
    sessionUuid?: string,
    transportSessionId?: string,
    unresolvedAutolockMcpSessionId?: string,
  ): ActiveExecution {
    if (this.isDaemonRestartPrepared() || this.isDaemonMaintenancePrepared()) {
      throw new DaemonRestartPendingError();
    }
    const id = this.idGenerator.next();
    const startTime = this.timer.now();
    const execution: ActiveExecution = {
      id,
      toolName,
      sessionId,
      transportSessionId,
      sessionUuid,
      provisionalAutolockSessionUuid: unresolvedAutolockMcpSessionId
        ? this.autolockSessionResolver?.autolockSessionForMcpSession(unresolvedAutolockMcpSessionId)
        : undefined,
      startTime,
      sessionClockStartTime: startTime + this.sessionClockOffsetProvider(),
      abortController: new AbortController(),
    };

    this.executions.set(id, execution);

    if (sessionId) {
      this.registerSessionExecution(sessionId, id);
    }

    if (transportSessionId && transportSessionId !== sessionId) {
      this.registerSessionExecution(transportSessionId, id);
    }

    if (sessionUuid) {
      const sessionSet = this.sessionUuidExecutions.get(sessionUuid) ?? new Set();
      sessionSet.add(id);
      this.sessionUuidExecutions.set(sessionUuid, sessionSet);
    }

    return execution;
  }

  /**
   * Atomically elects one automatic-restart owner when no tool operation is
   * active. The owner initiates shutdown before acknowledging this preparation,
   * so the fence remains until shutdown or an explicit admission rollback.
   */
  prepareForDaemonRestart(): DaemonRestartAdmission {
    return this.prepareForDaemonRestartAdmission(false);
  }

  /**
   * Transitions an already-authorized maintenance fence into restart preparation.
   * The caller must validate the maintenance capability before invoking this path.
   */
  prepareForAdmittedDaemonRestart(): DaemonRestartAdmission {
    if (!this.daemonMaintenancePrepared) {
      return "restart_pending";
    }
    return this.prepareForDaemonRestartAdmission(true);
  }

  private prepareForDaemonRestartAdmission(maintenanceAdmitted: boolean): DaemonRestartAdmission {
    if (this.daemonRestartPrepared) {
      return "restart_pending";
    }
    if (this.daemonMaintenancePrepared && !maintenanceAdmitted) {
      return "restart_pending";
    }
    if (
      this.executions.size > 0 ||
      this.activeProvisionDeviceQuery?.hasActiveProvisionDeviceOperation()
    ) {
      return "active_operations";
    }
    this.daemonRestartPrepared = true;
    return "accepted";
  }

  clearDaemonRestartPreparation(): void {
    this.daemonRestartPrepared = false;
  }

  /**
   * Atomically fences new tool work for an explicit maintenance operation.
   * Callers pass the daemon's current session count in the same synchronous
   * turn as this check, so a new tool cannot start between the idle proof and
   * the fence becoming visible to startExecution().
   */
  prepareForDaemonMaintenance(activeSessions: number): DaemonMaintenanceAdmission {
    if (this.daemonMaintenancePrepared) {
      return "maintenance_pending";
    }
    if (activeSessions > 0) {
      return "active_sessions";
    }
    if (this.executions.size > 0 || this.daemonRestartPrepared) {
      return "active_operations";
    }
    this.daemonMaintenancePrepared = true;
    return "accepted";
  }

  clearDaemonMaintenancePreparation(): void {
    this.daemonMaintenancePrepared = false;
  }

  private isDaemonRestartPrepared(): boolean {
    return this.daemonRestartPrepared;
  }

  private isDaemonMaintenancePrepared(): boolean {
    return this.daemonMaintenancePrepared;
  }

  endExecution(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }

    this.executions.delete(executionId);
    execution.unsubscribeDeadlineExtensions?.();
    this.unregisterDeviceExecutions(executionId, execution.deviceIds);

    if (execution.sessionId) {
      this.unregisterSessionExecution(execution.sessionId, executionId);
    }

    if (execution.transportSessionId && execution.transportSessionId !== execution.sessionId) {
      this.unregisterSessionExecution(execution.transportSessionId, executionId);
    }

    if (execution.sessionUuid) {
      const sessionSet = this.sessionUuidExecutions.get(execution.sessionUuid);
      sessionSet?.delete(executionId);
      if (sessionSet?.size === 0) {
        this.sessionUuidExecutions.delete(execution.sessionUuid);
      }
    }

    if (execution.resolvedAutolockSessionUuid) {
      this.unregisterAutolockSessionExecution(execution.resolvedAutolockSessionUuid, executionId);
    }
    this.notifySessionExecutionEnded(execution);
    for (const listener of this.executionEndListeners) {
      listener();
    }
  }

  /**
   * Observe the end of every tool execution that belonged to a device session, with the session
   * UUIDs it ran under (explicit, resolved-autolock and provisional-autolock). The daemon restarts a
   * session's idle window from here, so idleness counts from the end of the last call, not its
   * start — but only for an admitted call (`end.admitted`, #10824): a call refused at admission is
   * reported so deferred releases it vetoed can re-arm, and must not count as use. Returns the
   * unsubscribe function.
   */
  onSessionExecutionEnded(listener: SessionExecutionEndListener): () => void {
    this.sessionExecutionEndListeners.add(listener);
    return () => {
      this.sessionExecutionEndListeners.delete(listener);
    };
  }

  /**
   * When a running execution started, on the session clock (#11290); undefined once it has ended
   * or for an id this tracker never issued.
   */
  getSessionClockStartTime(executionId: string): number | undefined {
    return this.executions.get(executionId)?.sessionClockStartTime;
  }

  /**
   * Record where to read this execution's request deadline, so a release vetoed by the call is
   * bounded by the call's own deadline rather than a flat ceiling (#10712).
   * `subscribeExtensions` reports each progress extension, which restamps the deadline with the
   * wall clock of that moment, so the session-clock offset is captured again then (#11123).
   */
  setExecutionDeadline(
    executionId: string,
    readDeadlineMs: () => number | undefined,
    subscribeExtensions?: (onExtended: () => void) => (() => void) | undefined,
  ): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.readDeadlineMs = readDeadlineMs;
      execution.sessionClockOffsetMs = this.sessionClockOffsetProvider();
      execution.unsubscribeDeadlineExtensions?.();
      execution.unsubscribeDeadlineExtensions = subscribeExtensions?.(() => {
        execution.sessionClockOffsetMs = this.sessionClockOffsetProvider();
      });
    }
  }

  /**
   * The latest request deadline among the executions running under this device session
   * (explicit, resolved-autolock and provisional-autolock membership). `Number.POSITIVE_INFINITY`
   * when any of them has no deadline, undefined when none is running.
   */
  getLatestSessionExecutionDeadlineMs(
    sessionUuid: string,
    options: { onSessionClock?: boolean } = {},
  ): number | undefined {
    const executionIds = new Set([
      ...(this.sessionUuidExecutions.get(sessionUuid) ?? []),
      ...(this.autolockSessionExecutions.get(sessionUuid) ?? []),
      ...this.unresolvedAutolockExecutionIds(sessionUuid),
    ]);
    const deadlines = [...executionIds].flatMap((executionId) => {
      const execution = this.executions.get(executionId);
      if (!execution) {
        return [];
      }
      const deadline = execution.readDeadlineMs?.() ?? Number.POSITIVE_INFINITY;
      // Infinity stays infinite; a finite wall deadline moves by the offset it was stamped under.
      return [options.onSessionClock ? deadline + (execution.sessionClockOffsetMs ?? 0) : deadline];
    });
    return deadlines.length === 0 ? undefined : Math.max(...deadlines);
  }

  /**
   * Mark an execution as admitted under its session (#10824). Set once the call's session admission
   * (or, for `input/*`, its ownership checks) passed; only an admitted execution's end is use.
   */
  markSessionAdmitted(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.sessionAdmitted = true;
    }
  }

  /**
   * Record that a sessionless call passed the ownership check for `deviceId` while no session held
   * it, and will now drive it (#10829). Watching calls are not recorded: they stay allowed on a held
   * device.
   */
  markSessionlessDeviceUse(executionId: string, deviceId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.sessionlessDeviceUse ??= new Set();
      execution.sessionlessDeviceUse.add(deviceId);
    }
  }

  /** Drop a mark when the call's readiness settled on another device than it was admitted to. */
  unmarkSessionlessDeviceUse(executionId: string, deviceId: string): void {
    this.executions.get(executionId)?.sessionlessDeviceUse?.delete(deviceId);
  }

  /**
   * A session just acquired `deviceId`: abort every sessionless call admitted to drive it while it
   * was free, synchronously, with the same typed ownership refusal a new sessionless call gets
   * (#10829). `excludeExecutionId` spares the call performing the acquisition. Returns the count.
   */
  cancelSessionlessDeviceUse(
    deviceId: string,
    options: { excludeExecutionId?: string } = {},
  ): number {
    let cancelled = 0;
    for (const execution of this.executions.values()) {
      if (
        execution.id === options.excludeExecutionId ||
        !execution.sessionlessDeviceUse?.has(deviceId) ||
        execution.abortController.signal.aborted
      ) {
        continue;
      }
      this.abortExecution(
        execution,
        new InputDeviceOwnedError(
          execution.toolName,
          deviceId,
          undefined,
          SESSIONLESS_DEVICE_ACQUIRED_REMEDY,
        ),
      );
      cancelled++;
      logger.info(
        `[ExecutionTracker] Cancelled sessionless execution ${execution.id} on ${deviceId}: a session acquired the device (tool=${execution.toolName})`,
      );
    }
    return cancelled;
  }

  /** Mark an execution as a device read (`deviceReadOnly`), which does not use its session. */
  markDeviceReadCall(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.deviceReadCall = true;
    }
  }

  /**
   * The session a running execution was admitted under and used (#10974): its explicit session or
   * the one routing resolved for it (autolock, or the holder of a `deviceId`-only call). Undefined
   * for a call not admitted under a session, a device read, or an inventory read.
   */
  getAdmittedSessionUse(executionId: string): string | undefined {
    const execution = this.executions.get(executionId);
    if (
      !execution?.sessionAdmitted ||
      execution.deviceReadCall ||
      execution.readOnlySessionAccess
    ) {
      return undefined;
    }
    return execution.sessionUuid ?? execution.resolvedAutolockSessionUuid;
  }

  /** Mark an execution as a read-only inventory call, whose end is not session use. */
  markReadOnlySessionAccess(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.readOnlySessionAccess = true;
    }
  }

  private notifySessionExecutionEnded(execution: ActiveExecution): void {
    if (execution.readOnlySessionAccess) {
      return;
    }
    const sessionUuids = [
      ...new Set(
        [
          execution.sessionUuid,
          execution.resolvedAutolockSessionUuid,
          execution.provisionalAutolockSessionUuid,
        ].filter((uuid): uuid is string => typeof uuid === "string" && uuid.length > 0),
      ),
    ];
    if (sessionUuids.length === 0) {
      return;
    }
    for (const listener of this.sessionExecutionEndListeners) {
      try {
        listener(sessionUuids, { admitted: execution.sessionAdmitted === true });
      } catch (error) {
        // A listener's failure must not stop the remaining listeners or the execution's teardown.
        logger.warn(
          `[ExecutionTracker] Session execution-end listener failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** Number of currently admitted tool executions, for fail-closed host maintenance checks. */
  getActiveExecutionCount(): number {
    return this.executions.size;
  }

  /**
   * Number of in-flight executions on one device session, counted the same way
   * {@link hasActiveDeviceSessionExecutions} judges activity: explicit session UUID,
   * resolved autolock, and still-unresolved autolock executions (#10671).
   */
  getActiveDeviceSessionExecutionCount(sessionUuid: string): number {
    return new Set([
      ...(this.sessionUuidExecutions.get(sessionUuid) ?? []),
      ...(this.autolockSessionExecutions.get(sessionUuid) ?? []),
      ...this.unresolvedAutolockExecutionIds(sessionUuid),
    ]).size;
  }

  /**
   * @param reason Why the Streamable HTTP session (or equivalent) ended — logged for diagnostics.
   */
  async cancelSessionExecutions(
    sessionId: string,
    reason: ExecutionCancellationReason = "unspecified",
  ): Promise<number> {
    return this.cancelExecutionsForKey(sessionId, this.sessionExecutions, "sessionId", reason);
  }

  async cancelToolExecutions(
    toolName: string,
    reason: ExecutionCancellationReason = "unspecified",
  ): Promise<number> {
    const executionIds = Array.from(this.executions.values())
      .filter((execution) => execution.toolName === toolName)
      .map((execution) => execution.id);
    return this.cancelExecutionIds(executionIds, "toolName", toolName, reason);
  }

  async waitForToolExecutionsToEnd(toolName: string, timeoutMs: number): Promise<boolean> {
    if (!this.hasActiveToolExecutionGlobal(toolName)) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const timeout: { handle?: NodeJS.Timeout } = {};
      const finish = (drained: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.executionEndListeners.delete(check);
        if (timeout.handle !== undefined) {
          this.timer.clearTimeout(timeout.handle);
        }
        resolve(drained);
      };
      const check = (): void => {
        if (!this.hasActiveToolExecutionGlobal(toolName)) {
          finish(true);
        }
      };
      this.executionEndListeners.add(check);
      timeout.handle = this.timer.setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  async cancelSessionUuidExecutions(
    sessionUuid: string,
    reason: string = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    return this.cancelExecutionsForKey(
      sessionUuid,
      this.sessionUuidExecutions,
      "sessionUuid",
      reason,
      options,
    );
  }

  /**
   * Bind at admission, including sessionless calls and multi-device fan-out.
   *
   * Throws the recorded rebind error when a `setActiveDevice` rebind already
   * revoked this execution's session from `deviceId` (#9958): a call admitted
   * before the rebind but not yet bound to the old device is absent from the
   * device index, so the rebind cancel could not abort it, and binding now
   * would drive a device the session has left. Other aborts (device loss,
   * kill, ANR) never refuse a bind, so their cleanup paths are unaffected.
   */
  bindDeviceExecution(executionId: string, deviceId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }
    const revocation = execution.revokedDeviceBindings?.get(deviceId);
    if (revocation) {
      throw new ActionableError(revocation.message, { cause: revocation });
    }
    execution.deviceIds ??= new Set();
    execution.deviceIds.add(deviceId);
    const deviceSet = this.deviceExecutions.get(deviceId) ?? new Set<string>();
    deviceSet.add(executionId);
    this.deviceExecutions.set(deviceId, deviceSet);
    this.deviceLastActivityAt.set(deviceId, this.timer.now());
  }

  /** Number of in-flight tool executions bound to `deviceId`. */
  getActiveDeviceExecutionCount(deviceId: string): number {
    return this.deviceExecutions.get(deviceId)?.size ?? 0;
  }

  /** Time since the last tool execution bound to or ended on `deviceId`; null when none has. */
  getDeviceIdleForMs(deviceId: string): number | null {
    const lastActivityAt = this.deviceLastActivityAt.get(deviceId);
    return lastActivityAt === undefined ? null : Math.max(0, this.timer.now() - lastActivityAt);
  }

  async cancelDeviceExecutions(
    deviceId: string,
    reason: ExecutionCancellationReason = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    if (options.onlySessionUuid !== undefined) {
      this.revokeSessionDeviceBindings(deviceId, reason, options);
    }
    return this.cancelExecutionIds(
      this.deviceExecutions.get(deviceId),
      "deviceId",
      deviceId,
      reason,
      options,
    );
  }

  /**
   * A session-scoped device cancel means the session has left `deviceId`. Every
   * live execution of that session — bound to the device or still racing toward
   * it — may no longer bind to it, so a call admitted but not yet bound cannot
   * slip past the cancel (#9958).
   */
  private revokeSessionDeviceBindings(
    deviceId: string,
    reason: ExecutionCancellationReason,
    options: ExecutionCancellationOptions,
  ): void {
    const revocation = reason instanceof Error ? reason : new ActionableError(reason);
    for (const execution of this.executions.values()) {
      if (
        execution.id !== options.excludeExecutionId &&
        (options.onlyToolName === undefined || execution.toolName === options.onlyToolName) &&
        // Tool-scoped loss cancels only work already bound to this device. A
        // session rebind (no tool filter) still fences unresolved calls too.
        (options.onlyToolName === undefined || execution.deviceIds?.has(deviceId)) &&
        this.belongsToSessionFilter(execution, options.onlySessionUuid)
      ) {
        execution.revokedDeviceBindings ??= new Map();
        execution.revokedDeviceBindings.set(deviceId, revocation);
      }
    }
  }

  hasActiveDeviceExecutions(deviceId: string, query?: ActiveExecutionQuery): boolean {
    return this.hasActiveExecutionsForKey(this.deviceExecutions, deviceId, query);
  }

  async waitForDeviceExecutionsToEnd(
    deviceId: string,
    timeoutMs: number,
    query?: ActiveExecutionQuery,
  ): Promise<boolean> {
    return this.waitForExecutionsToEnd(
      () => this.hasActiveDeviceExecutions(deviceId, query),
      timeoutMs,
    );
  }

  /**
   * Cancels both explicit and implicit work bound to a concrete device session.
   * Unresolved implicit calls retain their start-time autolock mapping until
   * routing binds them to the selected session.
   */
  async cancelDeviceSessionExecutions(
    sessionUuid: string,
    reason: string = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    const executionIds = new Set<string>([
      ...(this.sessionUuidExecutions.get(sessionUuid) ?? []),
      ...(this.autolockSessionExecutions.get(sessionUuid) ?? []),
      ...this.unresolvedAutolockExecutionIds(sessionUuid),
    ]);
    return this.cancelExecutionIds(executionIds, "deviceSessionUuid", sessionUuid, reason, options);
  }

  /**
   * `query` is the same exemption the cancel above accepts: an execution that
   * was deliberately NOT cancelled is not going to end here, so waiting on it
   * would spend the whole drain budget and log a false timeout
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  async waitForDeviceSessionExecutionsToEnd(
    sessionUuid: string,
    timeoutMs: number,
    query?: ActiveExecutionQuery,
  ): Promise<boolean> {
    return this.waitForExecutionsToEnd(
      () => this.hasActiveDeviceSessionExecutions(sessionUuid, query),
      timeoutMs,
    );
  }

  private async waitForExecutionsToEnd(
    hasActive: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!hasActive()) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const timeout: { handle?: NodeJS.Timeout } = {};
      const finish = (drained: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.executionEndListeners.delete(check);
        if (timeout.handle !== undefined) {
          this.timer.clearTimeout(timeout.handle);
        }
        resolve(drained);
      };
      const check = (): void => {
        if (!hasActive()) {
          finish(true);
        }
      };
      this.executionEndListeners.add(check);
      timeout.handle = this.timer.setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  /** Explicit or implicit (autolock) work still running for a device session (#11177 drain). */
  hasActiveDeviceSessionExecutions(sessionUuid: string, query?: ActiveExecutionQuery): boolean {
    return (
      this.hasActiveSessionUuidExecutions(sessionUuid, query) ||
      this.hasActiveAutolockSessionExecutions(sessionUuid, query)
    );
  }

  hasActiveSessionUuidExecutions(sessionUuid: string, query?: ActiveExecutionQuery): boolean {
    return this.hasActiveExecutionsForKey(this.sessionUuidExecutions, sessionUuid, query);
  }

  hasActiveSessionExecutions(sessionId: string, query?: ActiveExecutionQuery): boolean {
    return this.hasActiveExecutionsForKey(this.sessionExecutions, sessionId, query);
  }

  /**
   * Records the concrete autolock UUID selected after an implicit MCP call begins.
   * This association must not follow later changes to the MCP-session routing map.
   */
  setResolvedAutolockSessionUuid(executionId: string, sessionUuid?: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }
    const provisionalSessionUuid = execution.provisionalAutolockSessionUuid;
    execution.provisionalAutolockSessionUuid = undefined;
    if (execution.resolvedAutolockSessionUuid === sessionUuid) {
      if (provisionalSessionUuid && provisionalSessionUuid !== sessionUuid) {
        for (const listener of this.executionEndListeners) {
          listener();
        }
      }
      return;
    }
    if (execution.resolvedAutolockSessionUuid) {
      this.unregisterAutolockSessionExecution(execution.resolvedAutolockSessionUuid, executionId);
    }
    execution.resolvedAutolockSessionUuid = sessionUuid;
    if (sessionUuid) {
      const executions = this.autolockSessionExecutions.get(sessionUuid) ?? new Set<string>();
      executions.add(executionId);
      this.autolockSessionExecutions.set(sessionUuid, executions);
    }
    for (const listener of this.executionEndListeners) {
      listener();
    }
  }

  hasActiveAutolockSessionExecutions(sessionUuid: string, query?: ActiveExecutionQuery): boolean {
    return (
      this.hasActiveExecutionsForKey(this.autolockSessionExecutions, sessionUuid, query) ||
      this.unresolvedAutolockExecutionIds(sessionUuid).some((executionId) => {
        const execution = this.executions.get(executionId);
        return (
          executionId !== query?.excludeExecutionId &&
          (query?.onlyToolName === undefined || execution?.toolName === query.onlyToolName) &&
          (query?.startedAtOrBefore === undefined ||
            (execution !== undefined && execution.startTime <= query.startedAtOrBefore))
        );
      })
    );
  }

  private unresolvedAutolockExecutionIds(sessionUuid: string): string[] {
    const executionIds: string[] = [];
    for (const execution of this.executions.values()) {
      if (execution.provisionalAutolockSessionUuid === sessionUuid) {
        executionIds.push(execution.id);
      }
    }
    return executionIds;
  }

  hasActiveToolExecution(toolName: string, options: ExecutionScopeOptions): boolean {
    if (options.scope === "global") {
      return this.hasActiveToolExecutionGlobal(toolName);
    }

    if (options.sessionUuid) {
      return this.hasActiveToolExecutionForKey(
        toolName,
        this.sessionUuidExecutions,
        options.sessionUuid,
      );
    }

    if (options.sessionId) {
      return this.hasActiveToolExecutionForKey(toolName, this.sessionExecutions, options.sessionId);
    }

    return this.hasActiveToolExecutionGlobal(toolName);
  }

  private hasActiveToolExecutionGlobal(toolName: string): boolean {
    for (const execution of this.executions.values()) {
      if (execution.toolName === toolName) {
        return true;
      }
    }
    return false;
  }

  private unregisterDeviceExecutions(executionId: string, deviceIds?: Set<string>): void {
    for (const deviceId of deviceIds ?? []) {
      this.deviceLastActivityAt.set(deviceId, this.timer.now());
      const deviceSet = this.deviceExecutions.get(deviceId);
      deviceSet?.delete(executionId);
      if (deviceSet?.size === 0) {
        this.deviceExecutions.delete(deviceId);
      }
    }
  }

  private registerSessionExecution(sessionId: string, executionId: string): void {
    const sessionSet = this.sessionExecutions.get(sessionId) ?? new Set<string>();
    sessionSet.add(executionId);
    this.sessionExecutions.set(sessionId, sessionSet);
  }

  private unregisterSessionExecution(sessionId: string, executionId: string): void {
    const sessionSet = this.sessionExecutions.get(sessionId);
    sessionSet?.delete(executionId);
    if (sessionSet?.size === 0) {
      this.sessionExecutions.delete(sessionId);
    }
  }

  private unregisterAutolockSessionExecution(sessionUuid: string, executionId: string): void {
    const executions = this.autolockSessionExecutions.get(sessionUuid);
    executions?.delete(executionId);
    if (executions?.size === 0) {
      this.autolockSessionExecutions.delete(sessionUuid);
    }
  }

  private hasActiveExecutionsForKey(
    executionMap: Map<string, Set<string>>,
    key: string,
    query?: ActiveExecutionQuery,
  ): boolean {
    const executions = executionMap.get(key);
    if (!executions || executions.size === 0) {
      return false;
    }
    if (
      query?.startedAtOrBefore === undefined &&
      query?.excludeExecutionId === undefined &&
      query?.onlyToolName === undefined &&
      query?.onlySessionUuid === undefined
    ) {
      return true;
    }
    return Array.from(executions).some((executionId) => {
      const execution = this.executions.get(executionId);
      return (
        execution !== undefined &&
        executionId !== query?.excludeExecutionId &&
        (query?.onlyToolName === undefined || execution.toolName === query.onlyToolName) &&
        this.belongsToSessionFilter(execution, query?.onlySessionUuid) &&
        (query?.startedAtOrBefore === undefined || execution.startTime <= query.startedAtOrBefore)
      );
    });
  }

  private belongsToSessionFilter(execution: ActiveExecution, sessionUuid?: string): boolean {
    return (
      sessionUuid === undefined ||
      execution.sessionUuid === sessionUuid ||
      execution.resolvedAutolockSessionUuid === sessionUuid ||
      execution.provisionalAutolockSessionUuid === sessionUuid
    );
  }

  private hasActiveToolExecutionForKey(
    toolName: string,
    executionMap: Map<string, Set<string>>,
    key: string,
  ): boolean {
    const executions = executionMap.get(key);
    if (!executions || executions.size === 0) {
      return false;
    }

    for (const executionId of executions) {
      const execution = this.executions.get(executionId);
      if (execution?.toolName === toolName) {
        return true;
      }
    }

    return false;
  }

  private async cancelExecutionsForKey(
    key: string,
    executionMap: Map<string, Set<string>>,
    label: "sessionId" | "sessionUuid",
    cancelReason: ExecutionCancellationReason = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    return this.cancelExecutionIds(executionMap.get(key), label, key, cancelReason, options);
  }

  private async cancelExecutionIds(
    executionIds: Iterable<string> | undefined,
    label: "sessionId" | "sessionUuid" | "deviceSessionUuid" | "deviceId" | "toolName",
    key: string,
    cancelReason: ExecutionCancellationReason = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    if (!executionIds) {
      return 0;
    }

    let cancelled = 0;
    for (const executionId of executionIds) {
      const execution = this.executions.get(executionId);
      if (!execution) {
        continue;
      }
      if (
        execution.id === options.excludeExecutionId ||
        (options.onlyToolName !== undefined && execution.toolName !== options.onlyToolName) ||
        !this.belongsToSessionFilter(execution, options.onlySessionUuid)
      ) {
        continue;
      }
      this.abortExecution(execution, cancelReason);
      cancelled++;
      logger.info(
        `[ExecutionTracker] Cancelled execution ${executionId} for ${label}=${key} (tool=${execution.toolName}, reason=${errorMessage(cancelReason)})`,
      );
    }

    return cancelled;
  }

  private abortExecution(
    execution: ActiveExecution,
    cancelReason: ExecutionCancellationReason,
  ): void {
    if (isDeviceLossCancellationReason(cancelReason)) {
      // Record the reason on the execution *before* aborting, so the tracker's own
      // authoritative `cancelReason` is set synchronously with the counted cancellation
      // regardless of how the runtime surfaces `signal.reason` (issue #3909). The same
      // Error instance is passed to abort() so consumers reading the signal still match.
      const reasonError =
        deviceLostErrorFromCancellationReason(cancelReason) ?? new Error(cancelReason);
      execution.cancelReason = reasonError;
      if (isDeviceLostError(reasonError)) {
        rememberDeviceLossAbort(execution.abortController.signal, reasonError);
      }
      execution.abortController.abort(reasonError);
    } else if (cancelReason instanceof Error) {
      execution.cancelReason = cancelReason;
      execution.abortController.abort(cancelReason);
    } else {
      execution.abortController.abort();
    }
  }
}

export const executionTracker = new ExecutionTracker();
