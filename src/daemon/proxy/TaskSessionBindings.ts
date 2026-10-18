import type { Timer } from "../../utils/SystemTimer";

/**
 * How long a device-binding task may go unpolled before the proxy stops waiting to bind from it:
 * the daemon's own retention of a finished task (`DEFAULT_TASK_RETENTION_MS`), so a task the
 * daemon can still report is never one this proxy forgot.
 */
export const TASK_BINDING_IDLE_MS = 10 * 60 * 1000;

/** At most this many device-binding tasks wait to bind, and this many bound ones are remembered. */
export const TASK_BINDING_CAPACITY = 64;

type Entry<C> =
  | { kind: "pending"; context: C; touchedAt: number }
  | { kind: "bound"; done: Promise<void> };

export interface TaskSessionBindingsDeps<C> {
  readonly timer: Pick<Timer, "now">;
  /** Apply the binding the synchronous call would have applied from `result`. */
  readonly bind: (context: C, result: unknown) => Promise<void>;
  /** The task starts waiting to bind. */
  readonly retain: (context: C) => void;
  /** The task no longer waits to bind (bound, failed, cancelled, gone or evicted). */
  readonly release: (context: C) => void;
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

  constructor(private readonly deps: TaskSessionBindingsDeps<C>) {}

  /** Remember a device-binding call the daemon answered with task `taskId`. */
  defer(taskId: string, context: C): void {
    this.prune();
    this.drop(taskId);
    this.deps.retain(context);
    this.entries.set(taskId, { kind: "pending", context, touchedAt: this.deps.timer.now() });
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
    if (entry === undefined) {
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
        this.entries.set(taskId, { kind: "bound", done });
        this.evictOverCapacity("bound");
        return done;
      }
      case "failed":
      case "cancelled":
        this.drop(taskId);
        return;
      default:
        entry.touchedAt = this.deps.timer.now();
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
    let result: Record<string, unknown>;
    try {
      result = await answer;
    } catch (error) {
      if (error !== null && typeof error === "object" && "jsonRpcError" in error) {
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
    for (const taskId of [...this.entries.keys()]) {
      this.drop(taskId);
    }
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
