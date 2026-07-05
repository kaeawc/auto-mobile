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
// Amortize the retention scan (#2799): run the count(*) gate at most once per
// this many inserts instead of on every insert. Worst-case overshoot is bounded
// (cap + CLEANUP_CHECK_INTERVAL rows) and negligible against the 10k cap.
const CLEANUP_CHECK_INTERVAL = 256;
let cleanupInProgress = false;
let insertsSinceCleanup = 0;

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
  maxRows: number = RETENTION_MAX_ROWS,
  checkInterval: number = CLEANUP_CHECK_INTERVAL
): Promise<void> {
  // Amortize (#2799): only scan once per checkInterval inserts. The counter is
  // bumped synchronously on every call (recordX dispatches this fire-and-forget),
  // so retention still fires deterministically every N inserts without putting a
  // scan on the hot path each time.
  if (++insertsSinceCleanup < checkInterval) {
    return;
  }
  insertsSinceCleanup = 0;

  if (cleanupInProgress) {return;}
  cleanupInProgress = true;
  try {
    const d = getDb(db);
    // count(*) is the cheap gate: SQLite compiles it to the page-granular Count
    // opcode (~0.6µs on a 10k-row covering index), far cheaper than the O(cap)
    // offset probe, which only runs on the rare insert that pushes over the cap.
    const count = await d
      .selectFrom("os_events")
      .select(d.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    if (Number(count.count) > maxRows) {
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
