import type { JsonObject, McpTaskRecord } from "../../src/db/mcpTaskRepository";
import {
  DefaultTaskManager,
  type CreateTaskInput,
  type RunningTask,
  type TaskManager,
} from "../../src/daemon/tasks/TaskManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeMcpTaskStore } from "./FakeMcpTaskStore";
import { FakeTimer } from "./FakeTimer";

/**
 * A {@link TaskManager} over an in-memory store and a fake clock that records every call, so
 * a test can assert that no task was created (or read, updated, cancelled) at all.
 */
export class FakeTaskManager implements TaskManager {
  readonly timer: FakeTimer;
  readonly store: FakeMcpTaskStore;
  readonly created: RunningTask[] = [];
  readonly calls: Array<{ method: "create" | "get" | "update" | "cancel"; taskId?: string }> = [];
  private readonly inner: DefaultTaskManager;

  constructor(options: { timer?: FakeTimer; store?: FakeMcpTaskStore; instanceId?: string } = {}) {
    this.timer = options.timer ?? new FakeTimer();
    this.store = options.store ?? new FakeMcpTaskStore(this.timer);
    this.inner = new DefaultTaskManager({
      store: this.store,
      timer: this.timer,
      idGenerator: new CountingIdGenerator("task"),
      instanceId: options.instanceId ?? "fake-instance",
    });
  }

  async create(input: CreateTaskInput): Promise<RunningTask> {
    this.calls.push({ method: "create" });
    const task = await this.inner.create(input);
    this.created.push(task);
    return task;
  }

  get(ownerKey: string, taskId: string): Promise<McpTaskRecord> {
    this.calls.push({ method: "get", taskId });
    return this.inner.get(ownerKey, taskId);
  }

  update(ownerKey: string, taskId: string, inputResponses: JsonObject): Promise<void> {
    this.calls.push({ method: "update", taskId });
    return this.inner.update(ownerKey, taskId, inputResponses);
  }

  cancel(ownerKey: string, taskId: string): Promise<void> {
    this.calls.push({ method: "cancel", taskId });
    return this.inner.cancel(ownerKey, taskId);
  }
}
