import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, NewToolCall } from "./types";
import { logger } from "../utils/logger";
import {
  CLEANUP_CHECK_INTERVAL,
  pruneTableByRowCap,
  runAmortizedRetention,
} from "./rowCapRetention";
import type { RepositoryDeps } from "./repositoryDeps";

export interface ToolCallRecord {
  toolName: string;
  timestamp: string;
  sessionUuid?: string | null;
  durationMs?: number | null;
  status?: "success" | "failure";
  errorType?: string | null;
  errorMessage?: string | null;
  deviceId?: string | null;
}

/** Keep the message head and include the ellipsis within the 500-character bound. */
export function boundToolCallErrorMessage(message: string): string {
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

// `tool_calls` receives one insert per MCP tool call for the life of the
// process with no prior cap (#6464). Mirrors the row-cap constants already
// used for the other single-row-insert RowCapTable repositories.
const TOOL_CALL_RETENTION_MAX_ROWS = 10_000;

export class ToolCallRepository {
  private db: Kysely<Database> | null;
  private readonly retentionState = {
    cleanupInProgress: false,
    insertsSinceCleanup: CLEANUP_CHECK_INTERVAL,
  };

  /** `retentionMaxRows` lets tests observe the amortized sweep at a small cap. */
  private readonly retentionMaxRows: number;

  constructor({
    db,
    retentionMaxRows = TOOL_CALL_RETENTION_MAX_ROWS,
  }: Pick<RepositoryDeps, "db"> & { retentionMaxRows?: number } = {}) {
    this.retentionMaxRows = retentionMaxRows;
    this.db = db ?? null;
  }

  /** @internal Typed view of private retention for unit tests; not part of the public API. */
  get testHooks() {
    return { pruneToRowCap: (maxRows?: number) => this.pruneToRowCap(maxRows) };
  }

  private getDb(): Kysely<Database> {
    if (this.db) {
      return this.db;
    }
    return getDatabase();
  }

  async recordToolCall(record: ToolCallRecord): Promise<void> {
    try {
      const db = this.getDb();
      const entry: NewToolCall = {
        tool_name: record.toolName,
        timestamp: record.timestamp,
        session_uuid: record.sessionUuid ?? null,
        status: record.status ?? "success",
        error_type: record.errorType ?? null,
        error_message:
          record.errorMessage === undefined || record.errorMessage === null
            ? null
            : boundToolCallErrorMessage(record.errorMessage),
        device_id: record.deviceId ?? null,
        duration_ms:
          record.durationMs === undefined || record.durationMs === null
            ? null
            : Math.max(0, Math.round(record.durationMs)),
      };

      await db.insertInto("tool_calls").values(entry).execute();
      await this.cleanupRetention();
    } catch (error) {
      logger.warn(`[ToolCallRepository] Failed to record tool call: ${error}`);
    }
  }

  // Amortize the offset-probe: fire at most once per CLEANUP_CHECK_INTERVAL
  // inserts (#6464), mirroring the other RowCapTable repositories so retention
  // does not add a scan to the hot insert path.
  private async cleanupRetention(): Promise<void> {
    await runAmortizedRetention(this.retentionState, () =>
      this.pruneToRowCap(this.retentionMaxRows),
    );
  }

  // `maxRows` is injectable so tests can exercise trimming at a small cap
  // without inserting 10k rows.
  private async pruneToRowCap(maxRows: number = TOOL_CALL_RETENTION_MAX_ROWS): Promise<void> {
    try {
      await pruneTableByRowCap(this.getDb(), "tool_calls", maxRows);
    } catch (error) {
      logger.warn(`[ToolCallRepository] Row-cap retention cleanup failed: ${error}`);
    }
  }

  /**
   * List the distinct tool names invoked in [startTime, endTime], ordered by
   * first appearance (earliest timestamp, then id).
   *
   * The dedup, ordering, and exclusion are pushed into SQL (#3438): the database
   * returns only the handful of distinct names rather than every tool-call row
   * in the window, which the caller would otherwise transfer and dedup in JS.
   */
  async listToolNamesBetween(
    startTime: string,
    endTime: string,
    excludeTools: string[] = [],
  ): Promise<string[]> {
    try {
      const db = this.getDb();
      let query = db
        .selectFrom("tool_calls")
        .select("tool_name")
        .where("timestamp", ">=", startTime)
        .where("timestamp", "<=", endTime)
        .groupBy("tool_name")
        // First-appearance order: earliest occurrence of each name, ties broken
        // on the monotonic id (matches the prior JS timestamp-asc, id-asc dedup).
        .orderBy(db.fn.min("timestamp"), "asc")
        .orderBy(db.fn.min("id"), "asc");

      if (excludeTools.length > 0) {
        query = query.where("tool_name", "not in", excludeTools);
      }

      const rows = await query.execute();
      return rows.map((row) => row.tool_name);
    } catch (error) {
      logger.warn(`[ToolCallRepository] Failed to list tool calls: ${error}`);
      return [];
    }
  }
}
