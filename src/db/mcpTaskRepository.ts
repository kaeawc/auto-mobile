import type { Kysely, Selectable } from "kysely";
import { z } from "zod/v4";
import { getDatabase } from "./database";
import type { Database, McpTasksTable } from "./types";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/** The MCP Tasks extension statuses (#4668). `completed`, `failed` and `cancelled` are terminal. */
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
export type McpRunningTaskStatus = "working" | "input_required";
export type McpTerminalTaskStatus = "completed" | "failed" | "cancelled";

const RUNNING_STATUSES: readonly McpRunningTaskStatus[] = ["working", "input_required"];
const STATUSES: readonly McpTaskStatus[] = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
];

export function isTerminalTaskStatus(status: McpTaskStatus): status is McpTerminalTaskStatus {
  return status !== "working" && status !== "input_required";
}

export type JsonObject = Record<string, unknown>;

export interface McpTaskRecord {
  readonly taskId: string;
  readonly ownerKey: string;
  readonly toolName: string;
  readonly status: McpTaskStatus;
  readonly statusMessage: string | null;
  readonly instanceId: string;
  readonly pollIntervalMs: number;
  readonly retentionMs: number;
  readonly createdAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly terminalAtMs: number | null;
  /** null while the task runs; a terminal task is readable until this instant. */
  readonly expiresAtMs: number | null;
  readonly inputRequests: JsonObject | null;
  readonly result: JsonObject | null;
  readonly error: JsonObject | null;
}

export interface NewMcpTask {
  readonly taskId: string;
  readonly ownerKey: string;
  readonly toolName: string;
  readonly instanceId: string;
  readonly pollIntervalMs: number;
  readonly retentionMs: number;
  readonly statusMessage?: string;
}

export interface McpTaskRunningUpdate {
  readonly status: McpRunningTaskStatus;
  /** Omitted keeps the stored message; null clears it. */
  readonly statusMessage?: string | null;
  /** Omitted keeps the stored requests; null clears them. */
  readonly inputRequests?: JsonObject | null;
}

export type McpTaskSettlement =
  | { readonly status: "completed"; readonly result: JsonObject; readonly statusMessage?: string }
  | { readonly status: "failed"; readonly error: JsonObject; readonly statusMessage?: string }
  | { readonly status: "cancelled"; readonly statusMessage?: string };

/** Persistence for MCP tasks. Every write that changes status is fenced on a running status. */
export interface McpTaskStore {
  insert(task: NewMcpTask): Promise<McpTaskRecord>;
  find(taskId: string): Promise<McpTaskRecord | undefined>;
  /** Moves a running task between running statuses; false when the task is gone or terminal. */
  updateRunning(taskId: string, update: McpTaskRunningUpdate): Promise<boolean>;
  /** Moves a running task to a terminal status; false when the task is gone or already terminal. */
  settle(taskId: string, settlement: McpTaskSettlement): Promise<boolean>;
  /** Fails every running task another daemon instance left behind; returns how many. */
  failInterrupted(
    currentInstanceId: string,
    error: JsonObject,
    statusMessage: string,
  ): Promise<number>;
  /** Deletes terminal tasks whose retention has elapsed; returns how many. */
  deleteExpired(): Promise<number>;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

function parseJsonObject(taskId: string, column: string, value: string | null): JsonObject | null {
  if (value === null) {
    return null;
  }
  try {
    return jsonObjectSchema.parse(JSON.parse(value));
  } catch (error) {
    logger.warn(
      `Ignoring unreadable ${column} on MCP task ${taskId}: ${errorMessage(error)}`,
      error,
    );
    return null;
  }
}

function parseStatus(value: string): McpTaskStatus {
  const status = STATUSES.find((candidate) => candidate === value);
  if (!status) {
    // A status this build does not know cannot be advanced safely; report it as failed.
    logger.warn(`Unknown MCP task status "${value}"; reporting it as failed`);
    return "failed";
  }
  return status;
}

function toRecord(row: Selectable<McpTasksTable>): McpTaskRecord {
  return {
    taskId: row.task_id,
    ownerKey: row.owner_key,
    toolName: row.tool_name,
    status: parseStatus(row.status),
    statusMessage: row.status_message,
    instanceId: row.instance_id,
    pollIntervalMs: row.poll_interval_ms,
    retentionMs: row.retention_ms,
    createdAtMs: row.created_at_ms,
    lastUpdatedAtMs: row.last_updated_at_ms,
    terminalAtMs: row.terminal_at_ms,
    expiresAtMs: row.expires_at_ms,
    inputRequests: parseJsonObject(row.task_id, "input_requests_json", row.input_requests_json),
    result: parseJsonObject(row.task_id, "result_json", row.result_json),
    error: parseJsonObject(row.task_id, "error_json", row.error_json),
  };
}

function jsonOrNull(value: JsonObject | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export interface McpTaskRepositoryDeps {
  readonly db?: Kysely<Database>;
  readonly timer?: Timer;
}

/** SQLite-backed {@link McpTaskStore} in the daemon's database (#4668). */
export class McpTaskRepository implements McpTaskStore {
  private readonly db: Kysely<Database> | undefined;
  private readonly timer: Timer;

  constructor(deps: McpTaskRepositoryDeps = {}) {
    this.db = deps.db;
    this.timer = deps.timer ?? defaultTimer;
  }

  // Resolve lazily so construction never opens the default database.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async insert(task: NewMcpTask): Promise<McpTaskRecord> {
    const now = this.timer.now();
    const row = await this.getDb()
      .insertInto("mcp_tasks")
      .values({
        task_id: task.taskId,
        owner_key: task.ownerKey,
        tool_name: task.toolName,
        status: "working",
        status_message: task.statusMessage ?? null,
        instance_id: task.instanceId,
        poll_interval_ms: task.pollIntervalMs,
        retention_ms: task.retentionMs,
        created_at_ms: now,
        last_updated_at_ms: now,
        terminal_at_ms: null,
        expires_at_ms: null,
        input_requests_json: null,
        result_json: null,
        error_json: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async find(taskId: string): Promise<McpTaskRecord | undefined> {
    const row = await this.getDb()
      .selectFrom("mcp_tasks")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row ? toRecord(row) : undefined;
  }

  async updateRunning(taskId: string, update: McpTaskRunningUpdate): Promise<boolean> {
    const result = await this.getDb()
      .updateTable("mcp_tasks")
      .set({
        status: update.status,
        last_updated_at_ms: this.timer.now(),
        ...(update.statusMessage !== undefined && { status_message: update.statusMessage }),
        ...(update.inputRequests !== undefined && {
          input_requests_json: jsonOrNull(update.inputRequests),
        }),
      })
      .where("task_id", "=", taskId)
      .where("status", "in", RUNNING_STATUSES)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async settle(taskId: string, settlement: McpTaskSettlement): Promise<boolean> {
    const now = this.timer.now();
    const result = await this.getDb()
      .updateTable("mcp_tasks")
      .set((eb) => ({
        status: settlement.status,
        last_updated_at_ms: now,
        terminal_at_ms: now,
        expires_at_ms: eb(eb.val(now), "+", eb.ref("retention_ms")),
        input_requests_json: null,
        ...(settlement.statusMessage !== undefined && {
          status_message: settlement.statusMessage,
        }),
        result_json: settlement.status === "completed" ? JSON.stringify(settlement.result) : null,
        error_json: settlement.status === "failed" ? JSON.stringify(settlement.error) : null,
      }))
      .where("task_id", "=", taskId)
      .where("status", "in", RUNNING_STATUSES)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async failInterrupted(
    currentInstanceId: string,
    error: JsonObject,
    statusMessage: string,
  ): Promise<number> {
    const now = this.timer.now();
    const result = await this.getDb()
      .updateTable("mcp_tasks")
      .set((eb) => ({
        status: "failed",
        status_message: statusMessage,
        last_updated_at_ms: now,
        terminal_at_ms: now,
        expires_at_ms: eb(eb.val(now), "+", eb.ref("retention_ms")),
        input_requests_json: null,
        error_json: JSON.stringify(error),
      }))
      .where("instance_id", "!=", currentInstanceId)
      .where("status", "in", RUNNING_STATUSES)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async deleteExpired(): Promise<number> {
    const result = await this.getDb()
      .deleteFrom("mcp_tasks")
      .where("expires_at_ms", "is not", null)
      .where("expires_at_ms", "<=", this.timer.now())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
