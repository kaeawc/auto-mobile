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
  sessionUuid?: string;
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
  excludeToolName?: string;
}

export class ExecutionTracker {
  private executions = new Map<string, ActiveExecution>();
  private sessionExecutions = new Map<string, Set<string>>();
  private sessionUuidExecutions = new Map<string, Set<string>>();
  private timer: Timer;
  private idGenerator: IdGenerator;

  constructor(timer: Timer = defaultTimer, idGenerator: IdGenerator = defaultIdGenerator) {
    this.timer = timer;
    this.idGenerator = idGenerator;
  }

  startExecution(
    toolName: string,
    sessionId?: string,
    sessionUuid?: string
  ): ActiveExecution {
    const id = this.idGenerator.next();
    const execution: ActiveExecution = {
      id,
      toolName,
      sessionId,
      sessionUuid,
      startTime: this.timer.now(),
      abortController: new AbortController()
    };

    this.executions.set(id, execution);

    if (sessionId) {
      const sessionSet = this.sessionExecutions.get(sessionId) ?? new Set();
      sessionSet.add(id);
      this.sessionExecutions.set(sessionId, sessionSet);
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
      const sessionSet = this.sessionExecutions.get(execution.sessionId);
      sessionSet?.delete(executionId);
      if (sessionSet?.size === 0) {
        this.sessionExecutions.delete(execution.sessionId);
      }
    }

    if (execution.sessionUuid) {
      const sessionSet = this.sessionUuidExecutions.get(execution.sessionUuid);
      sessionSet?.delete(executionId);
      if (sessionSet?.size === 0) {
        this.sessionUuidExecutions.delete(execution.sessionUuid);
      }
    }
  }

  /**
   * @param reason Why the Streamable HTTP session (or equivalent) ended — logged for diagnostics.
   */
  async cancelSessionExecutions(sessionId: string, reason: string = "unspecified"): Promise<number> {
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

  hasActiveSessionUuidExecutions(sessionUuid: string): boolean {
    const executions = this.sessionUuidExecutions.get(sessionUuid);
    return executions !== undefined && executions.size > 0;
  }

  hasActiveToolExecution(toolName: string, options: ExecutionScopeOptions): boolean {
    if (options.scope === "global") {
      return this.hasActiveToolExecutionGlobal(toolName);
    }

    if (options.sessionUuid) {
      return this.hasActiveToolExecutionForKey(toolName, this.sessionUuidExecutions, options.sessionUuid);
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

  private hasActiveToolExecutionForKey(
    toolName: string,
    executionMap: Map<string, Set<string>>,
    key: string
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
    const executions = executionMap.get(key);
    if (!executions || executions.size === 0) {
      return 0;
    }

    let cancelled = 0;
    for (const executionId of executions) {
      const execution = this.executions.get(executionId);
      if (!execution) {
        continue;
      }
      if (execution.toolName === options.excludeToolName) {
        continue;
      }
      if (cancelReason.startsWith("device-disconnected:")) {
        // Record the reason on the execution *before* aborting, so the tracker's own
        // authoritative `cancelReason` is set synchronously with the counted cancellation
        // regardless of how the runtime surfaces `signal.reason` (issue #3909). The same
        // Error instance is passed to abort() so consumers reading the signal still match.
        const reasonError = deviceLostErrorFromCancellationReason(cancelReason) ?? new Error(cancelReason);
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
        `[ExecutionTracker] Cancelled execution ${executionId} for ${label}=${key} (tool=${execution.toolName}, reason=${cancelReason})`
      );
    }

    return cancelled;
  }
}

export const executionTracker = new ExecutionTracker();
