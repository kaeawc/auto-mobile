import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDatabase } from "./database";
import { logger } from "../utils/logger";

export interface RecordOsEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  category: string; // lifecycle, broadcast, websocket_frame
  kind: string;
  details: Record<string, string> | null;
}

const RETENTION_MAX_ROWS = 10_000;
let cleanupInProgress = false;

function getDb(db?: Kysely<Database>): Kysely<Database> {
  return db ?? (getDatabase() as unknown as Kysely<Database>);
}

export async function recordOsEvent(
  input: RecordOsEventInput,
  db?: Kysely<Database>
): Promise<void> {
  await getDb(db)
    .insertInto("os_events")
    .values({
      device_id: input.deviceId,
      timestamp: input.timestamp,
      application_id: input.applicationId,
      session_id: input.sessionId,
      category: input.category,
      kind: input.kind,
      details_json: input.details ? JSON.stringify(input.details) : null,
    })
    .execute();

  cleanupIfNeeded(db);
}

export async function getOsEvents(
  query: { deviceId?: string; sinceTimestamp?: number; category?: string; limit?: number },
  db?: Kysely<Database>
): Promise<RecordOsEventInput[]> {
  let q = getDb(db).selectFrom("os_events").selectAll();

  if (query.deviceId) {
    q = q.where("device_id", "=", query.deviceId);
  }
  if (query.sinceTimestamp) {
    q = q.where("timestamp", ">=", query.sinceTimestamp);
  }
  if (query.category) {
    q = q.where("category", "=", query.category);
  }

  q = q.orderBy("timestamp", "desc").limit(query.limit ?? 100);

  const rows = await q.execute();
  return rows.map(r => ({
    deviceId: r.device_id,
    timestamp: r.timestamp,
    applicationId: r.application_id,
    sessionId: r.session_id,
    category: r.category,
    kind: r.kind,
    details: r.details_json ? JSON.parse(r.details_json) : null,
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
    // via an indexed backward walk on idx_os_events_timestamp instead of a
    // full-table count(*) on every insert. If the probe returns a row the table
    // is over cap and everything strictly older is pruned — byte-identical to the
    // previous count-gated path, minus the hot-path scan.
    const cutoff = await d
      .selectFrom("os_events")
      .select("timestamp")
      .orderBy("timestamp", "desc")
      .offset(maxRows)
      .limit(1)
      .executeTakeFirst();

    if (cutoff) {
      await d
        .deleteFrom("os_events")
        .where("timestamp", "<", cutoff.timestamp)
        .execute();
    }
  } catch (error) {
    // Best-effort retention cleanup: a failure must not surface to the telemetry
    // write path, but log so it leaves a trace (CLAUDE.md error-handling
    // convention — no bare swallow).
    logger.warn(`os_events retention cleanup failed: ${error}`, error);
  } finally {
    cleanupInProgress = false;
  }
}
