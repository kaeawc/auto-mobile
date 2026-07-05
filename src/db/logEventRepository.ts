import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDatabase } from "./database";
import { logger } from "../utils/logger";

export interface RecordLogEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  level: number;
  tag: string;
  message: string;
  filterName: string;
}

const RETENTION_MAX_ROWS = 10_000;
let cleanupInProgress = false;

function getDb(db?: Kysely<Database>): Kysely<Database> {
  return db ?? (getDatabase() as unknown as Kysely<Database>);
}

export async function recordLogEvent(
  input: RecordLogEventInput,
  db?: Kysely<Database>
): Promise<void> {
  await getDb(db)
    .insertInto("log_events")
    .values({
      device_id: input.deviceId,
      timestamp: input.timestamp,
      application_id: input.applicationId,
      session_id: input.sessionId,
      level: input.level,
      tag: input.tag,
      message: input.message,
      filter_name: input.filterName,
    })
    .execute();

  cleanupIfNeeded(db);
}

export async function getLogEvents(
  query: { deviceId?: string; sinceTimestamp?: number; tag?: string; limit?: number },
  db?: Kysely<Database>
): Promise<RecordLogEventInput[]> {
  let q = getDb(db).selectFrom("log_events").selectAll();

  if (query.deviceId) {
    q = q.where("device_id", "=", query.deviceId);
  }
  if (query.sinceTimestamp) {
    q = q.where("timestamp", ">=", query.sinceTimestamp);
  }
  if (query.tag) {
    q = q.where("tag", "=", query.tag);
  }

  q = q.orderBy("timestamp", "desc").limit(query.limit ?? 100);

  const rows = await q.execute();
  return rows.map(r => ({
    deviceId: r.device_id,
    timestamp: r.timestamp,
    applicationId: r.application_id,
    sessionId: r.session_id,
    level: r.level,
    tag: r.tag,
    message: r.message,
    filterName: r.filter_name,
  }));
}

export async function cleanupIfNeeded(
  db?: Kysely<Database>,
  maxRows: number = RETENTION_MAX_ROWS
): Promise<void> {
  if (cleanupInProgress) {return;}
  cleanupInProgress = true;
  try {
    const d = getDb(db);
    // Amortized retention (#2799): probe the (maxRows+1)-th newest row directly
    // via an indexed backward walk on idx_log_events_timestamp instead of a
    // full-table count(*) on every insert. If the probe returns a row the table
    // is over cap and everything strictly older is pruned — byte-identical to the
    // previous count-gated path, minus the hot-path scan.
    const cutoff = await d
      .selectFrom("log_events")
      .select("timestamp")
      .orderBy("timestamp", "desc")
      .offset(maxRows)
      .limit(1)
      .executeTakeFirst();

    if (cutoff) {
      await d
        .deleteFrom("log_events")
        .where("timestamp", "<", cutoff.timestamp)
        .execute();
    }
  } catch (error) {
    // Best-effort retention cleanup: a failure must not surface to the telemetry
    // write path, but log so it leaves a trace (CLAUDE.md error-handling
    // convention — no bare swallow).
    logger.warn(`log_events retention cleanup failed: ${error}`, error);
  } finally {
    cleanupInProgress = false;
  }
}
