import {
  isTerminalTaskStatus,
  type JsonObject,
  type McpTaskRecord,
  type McpTaskStore,
} from "../../db/mcpTaskRepository";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { toActionableError } from "../../models/ActionableError";
import { taskLookupError } from "./mcpTasksExtension";

/** Finished tasks stay readable for minutes (owner decision, 2026-10-18): 10 by default. */
export const DEFAULT_TASK_RETENTION_MS = 10 * 60 * 1000;
/** Suggested `tasks/get` interval. */
export const DEFAULT_TASK_POLL_INTERVAL_MS = 1_000;

export const TASK_INTERRUPTED_MESSAGE =
  "Task interrupted: the AutoMobile daemon stopped while the task was running. Run the tool again.";

const INTERNAL_ERROR = -32603;

export interface CreateTaskInput {
  /** The session key that owns the task; only it may read, update or cancel the task. */
  readonly ownerKey: string;
  readonly toolName: string;
  readonly pollIntervalMs?: number;
  readonly statusMessage?: string;
}

/**
 * A task this daemon instance is running. Its {@link signal} aborts on `tasks/cancel`; the
 * work settles it exactly once through {@link complete}, {@link fail} or {@link markCancelled}.
 */
export interface RunningTask {
  readonly taskId: string;
  readonly ownerKey: string;
  /** The record as created (durably stored before this handle exists). */
  readonly created: McpTaskRecord;
  readonly signal: AbortSignal;
  readonly cancelRequested: boolean;
  setStatusMessage(message: string): Promise<void>;
  /**
   * Moves the task to `input_required` with `requests` (keys unique over the task's life)
   * and resolves with the responses once `tasks/update` has answered every key.
   */
  requestInput(requests: JsonObject): Promise<JsonObject>;
  complete(result: JsonObject, statusMessage?: string): Promise<void>;
  fail(error: JsonObject, statusMessage?: string): Promise<void>;
  markCancelled(statusMessage?: string): Promise<void>;
}

/** The task lifecycle (#4668): creation, polling, input, cancellation and expiry. */
export interface TaskManager {
  create(input: CreateTaskInput): Promise<RunningTask>;
  /** The owner's task; throws the spec's `-32602` lookup error when unknown, foreign or expired. */
  get(ownerKey: string, taskId: string): Promise<McpTaskRecord>;
  /** Delivers responses to outstanding input requests; unknown or answered keys are ignored. */
  update(ownerKey: string, taskId: string, inputResponses: JsonObject): Promise<void>;
  /** Requests cooperative cancellation; a terminal task is left unchanged. */
  cancel(ownerKey: string, taskId: string): Promise<void>;
}

export interface TaskManagerDeps {
  readonly store: McpTaskStore;
  readonly timer?: Timer;
  readonly idGenerator?: IdGenerator;
  /** This daemon instance; rows a different instance left running are failed on first use. */
  readonly instanceId?: string;
  readonly retentionMs?: number;
  readonly pollIntervalMs?: number;
}

interface InputWaiter {
  readonly outstanding: Set<string>;
  readonly responses: JsonObject;
  readonly resolve: (responses: JsonObject) => void;
  readonly reject: (reason: unknown) => void;
}

interface TaskState {
  readonly controller: AbortController;
  /** Every input-request key issued so far: the spec keeps keys unique over the task's life. */
  readonly issuedInputKeys: Set<string>;
  cancelRequested: boolean;
  /** True only once the terminal state is durably stored; a failed write stays retryable. */
  settled: boolean;
  /** The terminal write in flight, shared by concurrent settle calls. */
  settling?: Promise<void>;
  waiter?: InputWaiter;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Task cancelled", "AbortError");
}

export class DefaultTaskManager implements TaskManager {
  private readonly store: McpTaskStore;
  private readonly timer: Timer;
  private readonly idGenerator: IdGenerator;
  private readonly instanceId: string;
  private readonly retentionMs: number;
  private readonly pollIntervalMs: number;
  private readonly running = new Map<string, TaskState>();
  private recovery: Promise<void> | undefined;

  constructor(deps: TaskManagerDeps) {
    this.store = deps.store;
    this.timer = deps.timer ?? defaultTimer;
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
    this.instanceId = deps.instanceId ?? this.idGenerator.next();
    this.retentionMs = deps.retentionMs ?? DEFAULT_TASK_RETENTION_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS;
  }

  /** Fails, once, the tasks a previous daemon instance left running (restart recovery). */
  private ready(): Promise<void> {
    this.recovery ??= this.recoverInterruptedTasks();
    return this.recovery;
  }

  private async recoverInterruptedTasks(): Promise<void> {
    try {
      const failed = await this.store.failInterrupted(
        this.instanceId,
        { code: INTERNAL_ERROR, message: TASK_INTERRUPTED_MESSAGE },
        TASK_INTERRUPTED_MESSAGE,
      );
      if (failed > 0) {
        logger.warn(`[TASKS] Failed ${failed} task(s) a previous daemon instance left running`);
      }
    } catch (error) {
      // Retry recovery on the next call rather than serving stale `working` rows forever.
      this.recovery = undefined;
      logger.warn(`[TASKS] Task restart recovery failed: ${errorMessage(error)}`, error);
    }
  }

  private async purgeExpired(): Promise<void> {
    try {
      await this.store.deleteExpired();
    } catch (error) {
      // Purging is housekeeping; an expired row is still refused on read.
      logger.warn(`[TASKS] Expired task purge failed: ${errorMessage(error)}`, error);
    }
  }

  async create(input: CreateTaskInput): Promise<RunningTask> {
    await this.ready();
    await this.purgeExpired();
    const created = await this.store.insert({
      taskId: this.idGenerator.next(),
      ownerKey: input.ownerKey,
      toolName: input.toolName,
      instanceId: this.instanceId,
      pollIntervalMs: input.pollIntervalMs ?? this.pollIntervalMs,
      retentionMs: this.retentionMs,
      ...(input.statusMessage !== undefined && { statusMessage: input.statusMessage }),
    });
    const state: TaskState = {
      controller: new AbortController(),
      issuedInputKeys: new Set(),
      cancelRequested: false,
      settled: false,
    };
    this.running.set(created.taskId, state);
    return this.handle(created, state);
  }

  async get(ownerKey: string, taskId: string): Promise<McpTaskRecord> {
    await this.ready();
    const record = await this.store.find(taskId);
    // A foreign task is reported exactly like a missing one, so its existence never leaks.
    if (!record || record.ownerKey !== ownerKey) {
      throw taskLookupError("not_found");
    }
    if (record.expiresAtMs !== null && record.expiresAtMs <= this.timer.now()) {
      throw taskLookupError("expired");
    }
    return record;
  }

  async update(ownerKey: string, taskId: string, inputResponses: JsonObject): Promise<void> {
    const record = await this.get(ownerKey, taskId);
    const state = this.running.get(taskId);
    const waiter = state?.waiter;
    if (record.status !== "input_required" || !state || !waiter) {
      return;
    }
    for (const [key, response] of Object.entries(inputResponses)) {
      if (waiter.outstanding.delete(key)) {
        waiter.responses[key] = response;
      }
    }
    if (waiter.outstanding.size > 0) {
      const remaining = Object.fromEntries(
        Object.entries(record.inputRequests ?? {}).filter(([key]) => waiter.outstanding.has(key)),
      );
      await this.store.updateRunning(taskId, {
        status: "input_required",
        inputRequests: remaining,
      });
      return;
    }
    // Persist the move back to `working` before releasing the waiter: if the write rejects, the
    // waiter stays, so the client's retry of this `tasks/update` still resolves it.
    await this.store.updateRunning(taskId, { status: "working", inputRequests: null });
    if (state.waiter === waiter) {
      state.waiter = undefined;
    }
    waiter.resolve(waiter.responses);
  }

  async cancel(ownerKey: string, taskId: string): Promise<void> {
    const record = await this.get(ownerKey, taskId);
    if (isTerminalTaskStatus(record.status)) {
      return;
    }
    const state = this.running.get(taskId);
    if (!state) {
      // Running rows belong to this instance after recovery; one without a live handle has no
      // work left to unwind, so it is cancelled directly.
      await this.store.settle(taskId, { status: "cancelled", statusMessage: "Task cancelled" });
      return;
    }
    state.cancelRequested = true;
    state.controller.abort();
    if (state.waiter) {
      const { reject } = state.waiter;
      state.waiter = undefined;
      reject(abortReason(state.controller.signal));
    }
  }

  private handle(created: McpTaskRecord, state: TaskState): RunningTask {
    const { taskId } = created;
    const persistSettlement = async (
      settlement: Parameters<McpTaskStore["settle"]>[1],
    ): Promise<void> => {
      try {
        await this.store.settle(taskId, settlement);
      } finally {
        state.settling = undefined;
      }
      // Only a durably stored terminal state settles the task: when the write rejects, a later
      // settle (the caller's fallback `fail`) can still persist one.
      state.settled = true;
      this.running.delete(taskId);
      state.waiter?.reject(new Error("Task settled while waiting for input"));
      state.waiter = undefined;
    };
    const settle = (settlement: Parameters<McpTaskStore["settle"]>[1]): Promise<void> => {
      if (state.settled) {
        return Promise.resolve();
      }
      state.settling ??= persistSettlement(settlement);
      return state.settling;
    };
    return {
      taskId,
      ownerKey: created.ownerKey,
      created,
      signal: state.controller.signal,
      get cancelRequested() {
        return state.cancelRequested;
      },
      setStatusMessage: async (message) => {
        if (!state.settled) {
          await this.store.updateRunning(taskId, {
            status: state.waiter ? "input_required" : "working",
            statusMessage: message,
          });
        }
      },
      requestInput: async (requests) => {
        state.controller.signal.throwIfAborted();
        if (state.settled) {
          throw new Error(`Task ${taskId} is already settled`);
        }
        if (state.waiter) {
          throw new Error(`Task ${taskId} is already waiting for input`);
        }
        const keys = Object.keys(requests);
        if (keys.length === 0) {
          return {};
        }
        const reused = keys.filter((key) => state.issuedInputKeys.has(key));
        if (reused.length > 0) {
          throw new Error(
            `Task ${taskId} already issued input-request key(s) ${reused.map((key) => JSON.stringify(key)).join(", ")}; keys must be unique over the task's life`,
          );
        }
        let waiter: InputWaiter | undefined;
        const responses = new Promise<JsonObject>((resolve, reject) => {
          waiter = { outstanding: new Set(keys), responses: {}, resolve, reject };
        });
        state.waiter = waiter;
        try {
          await this.store.updateRunning(taskId, {
            status: "input_required",
            inputRequests: requests,
          });
        } catch (error) {
          // The client never saw these requests: drop the waiter so the work may ask again.
          if (state.waiter === waiter) {
            state.waiter = undefined;
          }
          throw toActionableError(error, `Failed to store input requests for task ${taskId}`);
        }
        for (const key of keys) {
          state.issuedInputKeys.add(key);
        }
        return responses;
      },
      complete: (result, statusMessage) =>
        settle({
          status: "completed",
          result,
          ...(statusMessage !== undefined && { statusMessage }),
        }),
      fail: (error, statusMessage) =>
        settle({ status: "failed", error, ...(statusMessage !== undefined && { statusMessage }) }),
      markCancelled: (statusMessage) =>
        settle({ status: "cancelled", statusMessage: statusMessage ?? "Task cancelled" }),
    };
  }
}
