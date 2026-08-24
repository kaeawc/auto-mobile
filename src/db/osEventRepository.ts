import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDb, createEventRetentionState, cleanupEventTable } from "./eventRepositoryBase";

export interface RecordOsEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  category: string; // lifecycle, broadcast, websocket_frame
  kind: string;
  details: Record<string, string> | null;
}

const retentionState = createEventRetentionState();

function toOsRow(input: RecordOsEventInput) {
  return {
    device_id: input.deviceId,
    timestamp: input.timestamp,
    application_id: input.applicationId,
    session_id: input.sessionId,
    category: input.category,
    kind: input.kind,
    details_json: input.details ? JSON.stringify(input.details) : null,
  };
}

export async function recordOsEvent(
  input: RecordOsEventInput,
  db?: Kysely<Database>,
): Promise<void> {
  await getDb(db).insertInto("os_events").values(toOsRow(input)).execute();

  cleanupIfNeeded(db);
}

/**
 * Batched multi-row INSERT for coalesced OS telemetry (issue #3138).
 * One auto-commit for the whole batch, then a single retention pass.
 */
export async function recordOsEvents(
  inputs: RecordOsEventInput[],
  db?: Kysely<Database>,
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  await getDb(db).insertInto("os_events").values(inputs.map(toOsRow)).execute();

  cleanupIfNeeded(db, undefined, undefined, inputs.length);
}

export async function getOsEvents(
  query: {
    deviceId?: string;
    sessionId?: string;
    sinceTimestamp?: number;
    category?: string;
    limit?: number;
  },
  db?: Kysely<Database>,
): Promise<RecordOsEventInput[]> {
  let q = getDb(db).selectFrom("os_events").selectAll();

  if (query.deviceId) {
    q = q.where("device_id", "=", query.deviceId);
  }
  if (query.sessionId) {
    q = q.where("session_id", "=", query.sessionId);
  }
  if (query.sinceTimestamp) {
    q = q.where("timestamp", ">=", query.sinceTimestamp);
  }
  if (query.category) {
    q = q.where("category", "=", query.category);
  }

  q = q.orderBy("timestamp", "desc").limit(query.limit ?? 100);

  const rows = await q.execute();
  return rows.map((r) => ({
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
  maxRows?: number,
  checkInterval?: number,
  inserted?: number,
): Promise<void> {
  await cleanupEventTable("os_events", retentionState, db, maxRows, checkInterval, inserted);
}
