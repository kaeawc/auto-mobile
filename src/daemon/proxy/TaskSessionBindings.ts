import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import { DEFAULT_TASK_RETENTION_MS } from "../tasks/TaskManager";

/**
 * How long a device-binding task may go unpolled before the proxy stops waiting to bind from it:
 * the daemon's own retention of a finished task (`DEFAULT_TASK_RETENTION_MS`), so a task the
 * daemon can still report is never one this proxy forgot.
 */
export const TASK_BINDING_IDLE_MS = DEFAULT_TASK_RETENTION_MS;

/** JSON-RPC `-32602`: the code of the daemon's task-lookup failure (unknown, foreign or expired). */
const TASK_LOOKUP_ERROR_CODE = -32602;

/** At most this many device-binding tasks wait to bind, and this many bound ones are remembered. */
export const TASK_BINDING_CAPACITY = 64;

type Entry<C> =
  | {
      kind: "pending";
      context: C;
      touchedAt: number;
      expiry: ReturnType<Timer["setTimeout"]>;
    }
  | { kind: "bound"; done: Promise<void> };

export interface TaskSessionBindingsDeps<C> {
  readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** Apply the binding the synchronous call would have applied from `result`. */
  readonly bind: (context: C, result: unknown) => Promise<void>;
  /** The task starts waiting to bind. */
  readonly retain: (context: C) => void;
  /** The task no longer waits to bind (bound, failed, cancelled, gone or evicted). */
  readonly release: (context: C) => void;
  /**
   * `drain` gave up on a binding still running at its deadline. The owner must fence that binding
   * so it cannot publish state after the close has released what it knew about (#13155).
   */
  readonly abandon?: () => void;
}

/**
 * Whether the daemon answered a poll with its task-lookup failure (unknown or expired task), the
 * only error after which nothing will ever bind from the task. Any other error (a missing Tasks
 * declaration, a lost connection) is transient: the next poll may still complete and bind.
 */
function isTaskLookupFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const rpc: unknown = Reflect.get(error, "jsonRpcError");
  return (
    rpc !== null &&
    typeof rpc === "object" &&
    Reflect.get(rpc, "code") === TASK_LOOKUP_ERROR_CODE &&
    /not found|expired/i.test(String(Reflect.get(rpc, "message")))
  );
}

/**
 * The device-binding tool calls (`startDevice` and friends) this proxy relayed as MCP tasks
 * (#4668), keyed by task id. The proxy learns the session such a call binds from its result, and a
 * task delivers that result only through a later `tasks/get`. The first `tasks/get` answering
 * `completed` applies the binding exactly once; every later or concurrent poll of that task waits
 * for that one binding and applies nothing more. A `failed` or `cancelled` task, or one the daemon
 * no longer knows, binds nothing. Entries live in the proxy instance, which outlives its daemon
 * reconnects, so a poll after a reconnect still binds once.
 */
export class TaskSessionBindings<C> {
  private readonly entries = new Map<string, Entry<C>>();
  private closed = false;

  constructor(private readonly deps: TaskSessionBindingsDeps<C>) {}

  /** Remember a device-binding call the daemon answered with task `taskId`. */
  defer(taskId: string, context: C): void {
    if (this.closed) {
      return;
    }
    this.prune();
    this.drop(taskId);
    this.deps.retain(context);
    this.entries.set(taskId, {
      kind: "pending",
      context,
      touchedAt: this.deps.timer.now(),
      expiry: this.scheduleExpiry(),
    });
    this.evictOverCapacity("pending");
  }

  /**
   * Apply what `tasks/get` answered for `taskId`: bind from a `completed` task's result once, drop a
   * `failed` or `cancelled` one, and keep waiting while it runs. Resolves once any binding for the
   * task has been applied; rejects with that binding's error.
   */
  async settle(taskId: string, answer: Record<string, unknown>): Promise<void> {
    this.prune();
    const entry = this.entries.get(taskId);
    if (entry === undefined || this.closed) {
      return;
    }
    if (entry.kind === "bound") {
      return entry.done;
    }
    switch (answer.status) {
      case "completed": {
        const done = this.bindOnce(entry.context, answer.result);
        // Every poll awaits `done` itself; this handler only keeps an unawaited copy quiet.
        done.catch(() => undefined);
        this.deps.timer.clearTimeout(entry.expiry);
        this.entries.set(taskId, { kind: "bound", done });
        this.evictOverCapacity("bound");
        return done;
      }
      case "failed":
      case "cancelled":
        this.drop(taskId);
        return;
      default:
        this.touch(entry);
    }
  }

  /**
   * Apply a relayed `tasks/*` answer before it is returned to the client. Only `tasks/get` carries
   * a status; a JSON-RPC error answering it (unknown or expired task) means it will never bind.
   */
  async relayed(
    method: string,
    params: Record<string, unknown>,
    answer: Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const taskId = params.taskId;
    if (method !== "tasks/get" || typeof taskId !== "string") {
      return answer;
    }
    // A poll in flight keeps its task alive: a transient failure of it must not leave the task on
    // the clock of an earlier poll, or its retry could find the task already abandoned (#13155).
    const polled = this.entries.get(taskId);
    if (polled?.kind === "pending") {
      this.touch(polled);
    }
    let result: Record<string, unknown>;
    try {
      result = await answer;
    } catch (error) {
      if (isTaskLookupFailure(error)) {
        this.forget(taskId);
      }
      throw error;
    }
    await this.settle(taskId, result);
    return result;
  }

  /** The daemon no longer knows `taskId` (not found or expired): nothing will ever bind from it. */
  forget(taskId: string): void {
    if (this.entries.get(taskId)?.kind === "pending") {
      this.drop(taskId);
    }
  }

  /** Whether `taskId` still waits to bind. */
  isPending(taskId: string): boolean {
    return this.entries.get(taskId)?.kind === "pending";
  }

  /** Stop waiting for every task (the proxy is closing). */
  clear(): void {
    this.closed = true;
    for (const taskId of [...this.entries.keys()]) {
      this.drop(taskId);
    }
  }

  /**
   * Close the bindings: stop waiting for every pending task, bind nothing more, and resolve once
   * every binding already in flight has finished (whether it bound or failed), so the caller can
   * release sessions knowing no late binding will claim one afterwards. A binding still running
   * after `timeoutMs` is left to finish on its own: a stuck one cannot hold the close.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.closed = true;
    const inFlight: Array<Promise<void>> = [];
    for (const [taskId, entry] of [...this.entries]) {
      if (entry.kind === "bound") {
        inFlight.push(entry.done);
      } else {
        this.drop(taskId);
      }
    }
    try {
      await raceWithDeadline(Promise.allSettled(inFlight), {
        timer: this.deps.timer,
        timeoutMs,
        unref: true,
        label: "Draining device-binding tasks",
      });
    } catch (error) {
      // A binding stuck past the deadline is abandoned so the close can proceed.
      logger.warn(`[TaskSessionBindings] ${errorMessage(error)}`);
      this.deps.abandon?.();
    }
    this.clear();
  }

  private touch(entry: Extract<Entry<C>, { kind: "pending" }>): void {
    entry.touchedAt = this.deps.timer.now();
    this.deps.timer.clearTimeout(entry.expiry);
    entry.expiry = this.scheduleExpiry();
  }

  private scheduleExpiry(): ReturnType<Timer["setTimeout"]> {
    const handle = this.deps.timer.setTimeout(() => this.prune(), TASK_BINDING_IDLE_MS + 1);
    // An abandoned task's expiry must not keep a closing process alive.
    handle.unref?.();
    return handle;
  }

  private async bindOnce(context: C, result: unknown): Promise<void> {
    try {
      await this.deps.bind(context, result);
    } finally {
      this.deps.release(context);
    }
  }

  private drop(taskId: string): void {
    const entry = this.entries.get(taskId);
    this.entries.delete(taskId);
    if (entry?.kind === "pending") {
      this.deps.timer.clearTimeout(entry.expiry);
      this.deps.release(entry.context);
    }
  }

  /** A pending task left unpolled for the daemon's whole retention is abandoned. */
  private prune(): void {
    const now = this.deps.timer.now();
    const abandoned = [...this.entries].filter(
      ([, entry]) => entry.kind === "pending" && now - entry.touchedAt > TASK_BINDING_IDLE_MS,
    );
    for (const [taskId] of abandoned) {
      this.drop(taskId);
    }
  }

  private evictOverCapacity(kind: Entry<C>["kind"]): void {
    const ofKind = [...this.entries].filter(([, entry]) => entry.kind === kind);
    for (const [taskId] of ofKind.slice(0, Math.max(0, ofKind.length - TASK_BINDING_CAPACITY))) {
      this.drop(taskId);
    }
  }
}
