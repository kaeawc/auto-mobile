export { subscribeRequestCancellation } from "./executionRequestCancellation";
import { isDeviceLossCancellationReason } from "./emulatorLossIncident";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { errorMessage } from "../utils/describeUnknownError";
import { ActionableError } from "../models/ActionableError";
import {
  deviceLostErrorFromCancellationReason,
  isDeviceLostError,
  rememberDeviceLossAbort,
} from "../utils/deviceLossOutcome";
import { DaemonRestartPendingError } from "./daemonRestartPending";
import { InputDeviceOwnedError } from "./inputDeviceOwnership";
import {
  SESSIONLESS_DEVICE_ACQUIRED_REMEDY,
  ActiveExecution,
  SessionExecutionEndListener,
  ExecutionScopeOptions,
  ExecutionCancellationOptions,
  ExecutionCancellationReason,
  ActiveExecutionQuery,
  isReadExecution,
  executionDeadlineMs,
  isExcludedByQuery,
  isUnfilteredQuery,
  DaemonRestartAdmission,
  ActiveProvisionDeviceQuery,
  AutolockSessionResolver,
  DaemonMaintenanceAdmission,
  SessionClockOffsetProvider,
} from "./executionTrackerQueries";
export {
  type ActiveExecution,
  sessionExecutionMetadataOf,
  type SessionExecutionEndListener,
  type ExecutionScopeOptions,
  type ExecutionCancellationOptions,
  type ExecutionCancellationReason,
  type ActiveExecutionQuery,
  type DaemonRestartAdmission,
  type ActiveProvisionDeviceQuery,
  type AutolockSessionResolver,
  type DaemonMaintenanceAdmission,
  type SessionClockOffsetProvider,
} from "./executionTrackerQueries";

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
  private sessionClockOffsetProvider: SessionClockOffsetProvider = () => 0;

  constructor(timer: Timer = defaultTimer, idGenerator: IdGenerator = defaultIdGenerator) {
    this.timer = timer;
    this.idGenerator = idGenerator;
  }

  /**
   * Where the session clock stands relative to this tracker's wall clock (session minus wall),
   * read when an execution starts (#11290) and when its deadline is recorded (#11105).
   */
  setSessionClockOffsetProvider(provider: SessionClockOffsetProvider): void {
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
      sessionClockStartTime: startTime + this.sessionClockOffsetProvider(startTime),
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
    options: { onSessionClock?: boolean; excludeReads?: boolean } = {},
  ): number | undefined {
    // Every lookup of a session past its idle deadline asks this (several per heartbeat and per
    // monitor scan while a call vetoes the release), so it reads each running execution once and
    // builds no collection.
    const explicit = this.sessionUuidExecutions.get(sessionUuid);
    const autolock = this.autolockSessionExecutions.get(sessionUuid);
    let latest: number | undefined;
    for (const execution of this.executions.values()) {
      const runsUnderSession =
        execution.provisionalAutolockSessionUuid === sessionUuid ||
        explicit?.has(execution.id) ||
        autolock?.has(execution.id);
      if (runsUnderSession && !(options.excludeReads && isReadExecution(execution))) {
        const deadline = executionDeadlineMs(execution, options.onSessionClock);
        latest = latest === undefined ? deadline : Math.max(latest, deadline);
      }
    }
    return latest;
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

  /** Withdraw admission when session creation was refused before publishing a session. */
  unmarkSessionAdmitted(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.sessionAdmitted = false;
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
      execution.sessionlessControlUse ??= new Set();
      execution.sessionlessControlUse.add(deviceId);
    }
  }

  /** Drop a mark when the call's readiness settled on another device than it was admitted to. */
  unmarkSessionlessDeviceUse(executionId: string, deviceId: string): void {
    const execution = this.executions.get(executionId);
    execution?.sessionlessControlUse?.delete(deviceId);
    if (!execution?.sessionlessReadReadiness?.has(deviceId)) {
      execution?.sessionlessDeviceUse?.delete(deviceId);
    }
  }

  /** Readiness cancellation leaves the read execution alive to watch the acquired device. */
  markSessionlessReadReadiness(
    executionId: string,
    deviceId: string,
    controller: AbortController,
  ): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }
    execution.sessionlessDeviceUse ??= new Set();
    execution.sessionlessDeviceUse.add(deviceId);
    execution.sessionlessReadReadiness ??= new Map();
    const controllers = execution.sessionlessReadReadiness.get(deviceId) ?? new Set();
    controllers.add(controller);
    execution.sessionlessReadReadiness.set(deviceId, controllers);
  }

  /** Removing a nested read's mark must preserve its outer control call's mark. */
  unmarkSessionlessReadReadiness(
    executionId: string,
    deviceId: string,
    controller: AbortController,
  ): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }
    const controllers = execution.sessionlessReadReadiness?.get(deviceId);
    controllers?.delete(controller);
    if (!controllers?.size) {
      execution.sessionlessReadReadiness?.delete(deviceId);
      if (!execution.sessionlessControlUse?.has(deviceId)) {
        execution.sessionlessDeviceUse?.delete(deviceId);
      }
    }
  }

  /**
   * A session acquired `deviceId`: cancel controls with the typed refusal (#10829), or only a
   * read's readiness so it can watch. `excludeExecutionId` spares the acquiring call. Returns
   * the number of executions cancelled.
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
      const reason = new InputDeviceOwnedError(
        execution.toolName,
        deviceId,
        undefined,
        SESSIONLESS_DEVICE_ACQUIRED_REMEDY,
      );
      if (execution.sessionlessControlUse?.has(deviceId)) {
        this.abortExecution(execution, reason);
      } else if (!this.cancelReadReadiness(execution, deviceId, reason)) {
        continue;
      }
      cancelled++;
      logger.info(
        `[ExecutionTracker] Cancelled sessionless execution ${execution.id} on ${deviceId}: a session acquired the device (tool=${execution.toolName})`,
      );
    }
    return cancelled;
  }

  private cancelReadReadiness(
    execution: ActiveExecution,
    deviceId: string,
    reason: Error,
  ): boolean {
    const controllers = [...(execution.sessionlessReadReadiness?.get(deviceId) ?? [])].filter(
      (controller) => !controller.signal.aborted,
    );
    for (const controller of controllers) {
      controller.abort(reason);
    }
    return controllers.length > 0;
  }

  /**
   * Mark an execution as a device read (`deviceReadOnly`), which does not use its session.
   *
   * `toolName` is the read being run. Nested device-aware calls (a plan's `observe` step, a
   * control tool's internal read) run under their outer call's execution, so only a read that IS
   * the execution's top-level call marks it: a nested read never downgrades the control call it
   * runs inside, which must keep vetoing its session's release (#5343, #11322 review).
   */
  markDeviceReadCall(executionId: string, toolName: string): void {
    const execution = this.executions.get(executionId);
    if (execution && execution.toolName === toolName && !execution.deviceControlCall) {
      execution.deviceReadCall = true;
    }
  }

  /**
   * Record that a device-aware control step ran under this execution, top-level or nested. A read
   * that goes on to perform one is a control call from then on.
   */
  markDeviceControlCall(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.deviceControlCall = true;
      execution.deviceReadCall = false;
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

  /** Record client cancellation without changing daemon-owned cancellation semantics. */
  markRequestCancelled(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.requestCancelled = true;
    }
  }

  private notifySessionExecutionEnded(execution: ActiveExecution): void {
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
    // An inventory read's end is reported like any other call's, because a call may end before
    // it was classified as a read, and a release deferred while it was still counted must be
    // retried (#11381). It is reported as not admitted, because it is not use.
    const admitted = execution.sessionAdmitted === true && !execution.readOnlySessionAccess;
    for (const listener of this.sessionExecutionEndListeners) {
      try {
        listener(sessionUuids, { admitted });
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
    return await this.waitUntilNoneActive(
      () => this.hasActiveToolExecutionGlobal(toolName),
      timeoutMs,
    );
  }

  /**
   * Wait until no execution keyed on `sessionId` (a transport session) is running: true once
   * drained, false at the timeout.
   */
  async waitForSessionExecutionsToEnd(sessionId: string, timeoutMs: number): Promise<boolean> {
    return await this.waitUntilNoneActive(
      () => this.hasActiveSessionExecutions(sessionId),
      timeoutMs,
    );
  }

  private async waitUntilNoneActive(isActive: () => boolean, timeoutMs: number): Promise<boolean> {
    if (!isActive()) {
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
        if (!isActive()) {
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
    reason: ExecutionCancellationReason = "unspecified",
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
   * Recorded session/device revocations refuse admission, including calls
   * admitted before a rebind but not yet in the device index (#9958).
   * Loss-monitor bookkeeping can skip a revoked binding without restoring it;
   * ordinary callers still receive the recorded error.
   */
  bindDeviceExecution(
    executionId: string,
    deviceId: string,
    options: { skipRevoked?: boolean } = {},
  ): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }
    const revocation = execution.revokedDeviceBindings?.get(deviceId);
    if (revocation) {
      // Loss monitoring may revisit a still-draining plan; admission stays strict.
      if (options.skipRevoked) {
        return;
      }
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
        this.isInCancellationScope(execution, options)
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
    reason: ExecutionCancellationReason = "unspecified",
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
          !isExcludedByQuery(executionId, execution, query) &&
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
    if (isUnfilteredQuery(query)) {
      return true;
    }
    return Array.from(executions).some((executionId) => {
      const execution = this.executions.get(executionId);
      return (
        execution !== undefined &&
        !isExcludedByQuery(executionId, execution, query) &&
        (query?.onlyToolName === undefined || execution.toolName === query.onlyToolName) &&
        this.belongsToSessionFilter(execution, query?.onlySessionUuid) &&
        (query?.startedAtOrBefore === undefined || execution.startTime <= query.startedAtOrBefore)
      );
    });
  }

  private isInCancellationScope(
    execution: ActiveExecution,
    options: ExecutionCancellationOptions,
  ): boolean {
    return (
      this.belongsToSessionFilter(execution, options.onlySessionUuid) ||
      options.includeExecutionIds?.includes(execution.id) === true
    );
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
        !this.isInCancellationScope(execution, options)
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
