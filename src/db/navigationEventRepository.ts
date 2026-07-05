import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDatabase } from "./database";
import { logger } from "../utils/logger";

export interface RecordNavigationEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  destination: string;
  source: string | null;
  arguments: Record<string, string> | null;
  metadata: Record<string, string> | null;
}

const RETENTION_MAX_ROWS = 10_000;
let cleanupInProgress = false;

function getDb(db?: Kysely<Database>): Kysely<Database> {
  return db ?? (getDatabase() as unknown as Kysely<Database>);
}

export async function recordNavigationEvent(
  input: RecordNavigationEventInput,
  db?: Kysely<Database>
): Promise<void> {
  await getDb(db)
    .insertInto("navigation_events")
    .values({
      device_id: input.deviceId,
      timestamp: input.timestamp,
      application_id: input.applicationId,
      session_id: input.sessionId,
      destination: input.destination,
      source: input.source,
      arguments_json: input.arguments ? JSON.stringify(input.arguments) : null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .execute();

  cleanupIfNeeded(db);
}

export async function getNavigationEvents(
  query: { deviceId?: string; sinceTimestamp?: number; limit?: number },
  db?: Kysely<Database>
): Promise<RecordNavigationEventInput[]> {
  let q = getDb(db).selectFrom("navigation_events").selectAll();

  if (query.deviceId) {
    q = q.where("device_id", "=", query.deviceId);
  }
  if (query.sinceTimestamp) {
    q = q.where("timestamp", ">=", query.sinceTimestamp);
  }

  q = q.orderBy("timestamp", "desc").limit(query.limit ?? 100);

  const rows = await q.execute();
  return rows.map(r => ({
    deviceId: r.device_id,
    timestamp: r.timestamp,
    applicationId: r.application_id,
    sessionId: r.session_id,
    destination: r.destination,
    source: r.source,
    arguments: r.arguments_json ? JSON.parse(r.arguments_json) : null,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
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
    // via an indexed backward walk on idx_navigation_events_timestamp instead of a
    // full-table count(*) on every insert. If the probe returns a row the table
    // is over cap and everything strictly older is pruned — byte-identical to the
    // previous count-gated path, minus the hot-path scan.
    const cutoff = await d
      .selectFrom("navigation_events")
      .select("timestamp")
      .orderBy("timestamp", "desc")
      .offset(maxRows)
      .limit(1)
      .executeTakeFirst();

    if (cutoff) {
      await d
        .deleteFrom("navigation_events")
        .where("timestamp", "<", cutoff.timestamp)
        .execute();
    }
  } catch (error) {
    // Best-effort retention cleanup: a failure must not surface to the telemetry
    // write path, but log so it leaves a trace (CLAUDE.md error-handling
    // convention — no bare swallow).
    logger.warn(`navigation_events retention cleanup failed: ${error}`, error);
  } finally {
    cleanupInProgress = false;
  }
}
