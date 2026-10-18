import {
  isTerminalTaskStatus,
  type JsonObject,
  type McpTaskRecord,
  type McpTaskRunningUpdate,
  type McpTaskSettlement,
  type McpTaskStore,
  type NewMcpTask,
} from "../../src/db/mcpTaskRepository";
import type { Timer } from "../../src/utils/SystemTimer";

/** In-memory {@link McpTaskStore} with the repository's status fences, on an injected clock. */
export class FakeMcpTaskStore implements McpTaskStore {
  readonly rows = new Map<string, McpTaskRecord>();

  constructor(private readonly timer: Pick<Timer, "now">) {}

  async insert(task: NewMcpTask): Promise<McpTaskRecord> {
    // The real table's primary key rejects a duplicate task id rather than replacing the row.
    if (this.rows.has(task.taskId)) {
      throw new Error(`UNIQUE constraint failed: mcp_tasks.task_id (${task.taskId})`);
    }
    const now = this.timer.now();
    const record: McpTaskRecord = {
      taskId: task.taskId,
      ownerKey: task.ownerKey,
      toolName: task.toolName,
      status: "working",
      statusMessage: task.statusMessage ?? null,
      instanceId: task.instanceId,
      pollIntervalMs: task.pollIntervalMs,
      retentionMs: task.retentionMs,
      createdAtMs: now,
      lastUpdatedAtMs: now,
      terminalAtMs: null,
      expiresAtMs: null,
      inputRequests: null,
      result: null,
      error: null,
    };
    this.rows.set(task.taskId, record);
    return record;
  }

  async find(taskId: string): Promise<McpTaskRecord | undefined> {
    return this.rows.get(taskId);
  }

  async updateRunning(taskId: string, update: McpTaskRunningUpdate): Promise<boolean> {
    const row = this.rows.get(taskId);
    if (!row || isTerminalTaskStatus(row.status)) {
      return false;
    }
    this.rows.set(taskId, {
      ...row,
      status: update.status,
      lastUpdatedAtMs: this.timer.now(),
      ...(update.statusMessage !== undefined && { statusMessage: update.statusMessage }),
      ...(update.inputRequests !== undefined && { inputRequests: update.inputRequests }),
    });
    return true;
  }

  async settle(taskId: string, settlement: McpTaskSettlement): Promise<boolean> {
    const row = this.rows.get(taskId);
    if (!row || isTerminalTaskStatus(row.status)) {
      return false;
    }
    const now = this.timer.now();
    this.rows.set(taskId, {
      ...row,
      status: settlement.status,
      lastUpdatedAtMs: now,
      terminalAtMs: now,
      expiresAtMs: now + row.retentionMs,
      inputRequests: null,
      ...(settlement.statusMessage !== undefined && { statusMessage: settlement.statusMessage }),
      result: settlement.status === "completed" ? settlement.result : null,
      error: settlement.status === "failed" ? settlement.error : null,
    });
    return true;
  }

  async failInterrupted(
    currentInstanceId: string,
    error: JsonObject,
    statusMessage: string,
  ): Promise<number> {
    const now = this.timer.now();
    const stale = [...this.rows.values()].filter(
      (row) => row.instanceId !== currentInstanceId && !isTerminalTaskStatus(row.status),
    );
    for (const row of stale) {
      this.rows.set(row.taskId, {
        ...row,
        status: "failed",
        statusMessage,
        lastUpdatedAtMs: now,
        terminalAtMs: now,
        expiresAtMs: now + row.retentionMs,
        inputRequests: null,
        error,
      });
    }
    return stale.length;
  }

  async deleteExpired(): Promise<number> {
    const now = this.timer.now();
    const expired = [...this.rows.values()].filter(
      (row) => row.expiresAtMs !== null && row.expiresAtMs <= now,
    );
    for (const row of expired) {
      this.rows.delete(row.taskId);
    }
    return expired.length;
  }
}
