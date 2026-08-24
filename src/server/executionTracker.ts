import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import {
  deviceLostErrorFromCancellationReason,
  isDeviceLostError,
  rememberDeviceLossAbort,
} from "./deviceLossOutcome";

interface ActiveExecution {
  id: string;
  toolName: string;
  sessionId?: string;
  transportSessionId?: string;
  sessionUuid?: string;
  resolvedAutolockSessionUuid?: string;
  startTime: number;
  abortController: AbortController;
  /**
   * The reason this execution was cancelled, recorded synchronously at cancellation time for
   * device-disconnected cancellations. This is the tracker's own authoritative record of *why*
   * it aborted — consumers should read it instead of `abortController.signal.reason`, whose
   * observability is unreliable on some runtimes under load (macOS CI Bun flake, issue #3909).
   */
  cancelReason?: Error;
}

export type ExecutionScope = "session" | "global";

export interface ExecutionScopeOptions {
  scope: ExecutionScope;
  sessionId?: string;
  sessionUuid?: string;
}

export interface ExecutionCancellationOptions {
  /**
   * Keeps the control-plane operation that triggered a device shutdown alive
   * while cancelling the device-bound work that must fail fast.
   */
  excludeExecutionId?: string;
}

export interface ActiveExecutionQuery {
  startedAtOrBefore?: number;
  excludeExecutionId?: string;
}

export class ExecutionTracker {
  private executions = new Map<string, ActiveExecution>();
  private sessionExecutions = new Map<string, Set<string>>();
  private sessionUuidExecutions = new Map<string, Set<string>>();
  private autolockSessionExecutions = new Map<string, Set<string>>();
  private executionEndListeners = new Set<() => void>();
  private timer: Timer;
  private idGenerator: IdGenerator;

  constructor(timer: Timer = defaultTimer, idGenerator: IdGenerator = defaultIdGenerator) {
    this.timer = timer;
    this.idGenerator = idGenerator;
  }

  startExecution(
    toolName: string,
    sessionId?: string,
    sessionUuid?: string,
    transportSessionId?: string,
  ): ActiveExecution {
    const id = this.idGenerator.next();
    const execution: ActiveExecution = {
      id,
      toolName,
      sessionId,
      transportSessionId,
      sessionUuid,
      startTime: this.timer.now(),
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

  endExecution(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return;
    }

    this.executions.delete(executionId);

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
    for (const listener of this.executionEndListeners) {
      listener();
    }
  }

  /**
   * @param reason Why the Streamable HTTP session (or equivalent) ended — logged for diagnostics.
   */
  async cancelSessionExecutions(
    sessionId: string,
    reason: string = "unspecified",
  ): Promise<number> {
    return this.cancelExecutionsForKey(sessionId, this.sessionExecutions, "sessionId", reason);
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
   * Cancels both explicit and implicit work bound to a concrete device session.
   * Implicit autolock calls are added to a separate index after routing resolves.
   */
  async cancelDeviceSessionExecutions(
    sessionUuid: string,
    reason: string = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    const executionIds = new Set<string>([
      ...(this.sessionUuidExecutions.get(sessionUuid) ?? []),
      ...(this.autolockSessionExecutions.get(sessionUuid) ?? []),
    ]);
    return this.cancelExecutionIds(executionIds, "deviceSessionUuid", sessionUuid, reason, options);
  }

  async waitForDeviceSessionExecutionsToEnd(
    sessionUuid: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.hasActiveDeviceSessionExecutions(sessionUuid)) {
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
        if (!this.hasActiveDeviceSessionExecutions(sessionUuid)) {
          finish(true);
        }
      };
      this.executionEndListeners.add(check);
      timeout.handle = this.timer.setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  private hasActiveDeviceSessionExecutions(sessionUuid: string): boolean {
    return (
      this.hasActiveSessionUuidExecutions(sessionUuid) ||
      this.hasActiveAutolockSessionExecutions(sessionUuid)
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
  setResolvedAutolockSessionUuid(executionId: string, sessionUuid: string): void {
    const execution = this.executions.get(executionId);
    if (!execution || execution.resolvedAutolockSessionUuid === sessionUuid) {
      return;
    }
    if (execution.resolvedAutolockSessionUuid) {
      this.unregisterAutolockSessionExecution(execution.resolvedAutolockSessionUuid, executionId);
    }
    execution.resolvedAutolockSessionUuid = sessionUuid;
    const executions = this.autolockSessionExecutions.get(sessionUuid) ?? new Set<string>();
    executions.add(executionId);
    this.autolockSessionExecutions.set(sessionUuid, executions);
  }

  hasActiveAutolockSessionExecutions(sessionUuid: string, query?: ActiveExecutionQuery): boolean {
    return this.hasActiveExecutionsForKey(this.autolockSessionExecutions, sessionUuid, query);
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
    if (query?.startedAtOrBefore === undefined && query?.excludeExecutionId === undefined) {
      return true;
    }
    return Array.from(executions).some((executionId) => {
      const execution = this.executions.get(executionId);
      return (
        execution !== undefined &&
        executionId !== query?.excludeExecutionId &&
        (query?.startedAtOrBefore === undefined || execution.startTime <= query.startedAtOrBefore)
      );
    });
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
    cancelReason: string = "unspecified",
    options: ExecutionCancellationOptions = {},
  ): Promise<number> {
    return this.cancelExecutionIds(executionMap.get(key), label, key, cancelReason, options);
  }

  private async cancelExecutionIds(
    executionIds: Iterable<string> | undefined,
    label: "sessionId" | "sessionUuid" | "deviceSessionUuid",
    key: string,
    cancelReason: string = "unspecified",
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
      if (execution.id === options.excludeExecutionId) {
        continue;
      }
      if (cancelReason.startsWith("device-disconnected:")) {
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
      } else {
        execution.abortController.abort();
      }
      cancelled++;
      logger.info(
        `[ExecutionTracker] Cancelled execution ${executionId} for ${label}=${key} (tool=${execution.toolName}, reason=${cancelReason})`,
      );
    }

    return cancelled;
  }
}

export const executionTracker = new ExecutionTracker();
