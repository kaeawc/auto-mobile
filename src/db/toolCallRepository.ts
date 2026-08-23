import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, NewToolCall } from "./types";
import { logger } from "../utils/logger";

interface ToolCallRecord {
  toolName: string;
  timestamp: string;
  sessionUuid?: string | null;
  durationMs?: number | null;
}

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
    } catch (error) {
      logger.warn(`[ToolCallRepository] Failed to record tool call: ${error}`);
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
