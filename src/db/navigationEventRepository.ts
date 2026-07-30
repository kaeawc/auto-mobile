import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDb, createEventRetentionState, cleanupEventTable } from "./eventRepositoryBase";

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

const retentionState = createEventRetentionState();

function toNavigationRow(input: RecordNavigationEventInput) {
  return {
    device_id: input.deviceId,
    timestamp: input.timestamp,
    application_id: input.applicationId,
    session_id: input.sessionId,
    destination: input.destination,
    source: input.source,
    arguments_json: input.arguments ? JSON.stringify(input.arguments) : null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
  };
}

export async function recordNavigationEvent(
  input: RecordNavigationEventInput,
  db?: Kysely<Database>
): Promise<void> {
  await getDb(db).insertInto("navigation_events").values(toNavigationRow(input)).execute();

  cleanupIfNeeded(db);
}

/**
 * Batched multi-row INSERT for coalesced navigation telemetry (issue #3138).
 * One auto-commit for the whole batch, then a single retention pass.
 */
export async function recordNavigationEvents(
  inputs: RecordNavigationEventInput[],
  db?: Kysely<Database>
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  await getDb(db).insertInto("navigation_events").values(inputs.map(toNavigationRow)).execute();

  cleanupIfNeeded(db, undefined, undefined, inputs.length);
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
  maxRows?: number,
  checkInterval?: number,
  inserted?: number
): Promise<void> {
  await cleanupEventTable("navigation_events", retentionState, db, maxRows, checkInterval, inserted);
}
