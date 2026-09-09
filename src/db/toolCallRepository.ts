import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, NewToolCall } from "./types";
import { logger } from "../utils/logger";
import {
  createRowCapRetentionState,
  pruneTableByRowCap,
  runAmortizedRetention,
} from "./rowCapRetention";

interface ToolCallRecord {
  toolName: string;
  timestamp: string;
  sessionUuid?: string | null;
  durationMs?: number | null;
}

// `tool_calls` receives one insert per MCP tool call for the life of the
// process with no prior cap (#6464). Mirrors the row-cap constants already
// used for the other single-row-insert RowCapTable repositories.
const TOOL_CALL_RETENTION_MAX_ROWS = 10_000;
const retentionState = createRowCapRetentionState();

export class ToolCallRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
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
    await runAmortizedRetention(retentionState, () => this.pruneToRowCap());
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
