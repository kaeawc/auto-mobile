import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDatabase } from "./database";
import { pruneEventTableByCount, type EventRetentionState } from "./eventRetention";

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

const retentionState: EventRetentionState = { cleanupInProgress: false, insertsSinceCleanup: 0 };

function getDb(db?: Kysely<Database>): Kysely<Database> {
  return db ?? (getDatabase() as unknown as Kysely<Database>);
}

function toLogRow(input: RecordLogEventInput) {
  return {
    device_id: input.deviceId,
    timestamp: input.timestamp,
    application_id: input.applicationId,
    session_id: input.sessionId,
    level: input.level,
    tag: input.tag,
    message: input.message,
    filter_name: input.filterName,
  };
}

export async function recordLogEvent(
  input: RecordLogEventInput,
  db?: Kysely<Database>
): Promise<void> {
  await getDb(db).insertInto("log_events").values(toLogRow(input)).execute();

  cleanupIfNeeded(db);
}

/**
 * Batched multi-row INSERT for coalesced log telemetry (issue #3138).
 * Emits a single `INSERT ... VALUES (...),(...)` — one auto-commit for the whole
 * batch instead of one per row — then runs retention once for the batch.
 */
export async function recordLogEvents(
  inputs: RecordLogEventInput[],
  db?: Kysely<Database>
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  await getDb(db).insertInto("log_events").values(inputs.map(toLogRow)).execute();

  cleanupIfNeeded(db, undefined, undefined, inputs.length);
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
  maxRows?: number,
  checkInterval?: number,
  inserted?: number
): Promise<void> {
  await pruneEventTableByCount(db, "log_events", retentionState, maxRows, checkInterval, inserted);
}
