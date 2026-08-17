import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDb, createEventRetentionState, cleanupEventTable } from "./eventRepositoryBase";

export interface RecordLayoutEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  subType: string;
  composableName: string | null;
  composableId: string | null;
  recompositionCount: number | null;
  durationMs: number | null;
  likelyCause: string | null;
  detailsJson: string | null;
  screenName?: string | null;
}

const retentionState = createEventRetentionState();

function toLayoutRow(input: RecordLayoutEventInput) {
  return {
    device_id: input.deviceId,
    timestamp: input.timestamp,
    application_id: input.applicationId,
    session_id: input.sessionId,
    sub_type: input.subType,
    composable_name: input.composableName,
    composable_id: input.composableId,
    recomposition_count: input.recompositionCount,
    duration_ms: input.durationMs,
    likely_cause: input.likelyCause,
    details_json: input.detailsJson,
    screen_name: input.screenName ?? null,
  };
}

export async function recordLayoutEvent(
  input: RecordLayoutEventInput,
  db?: Kysely<Database>
): Promise<void> {
  await getDb(db).insertInto("layout_events").values(toLayoutRow(input)).execute();

  cleanupIfNeeded(db);
}

/**
 * Batched multi-row INSERT for coalesced layout telemetry (issue #3138).
 * One auto-commit for the whole batch, then a single retention pass.
 */
export async function recordLayoutEvents(
  inputs: RecordLayoutEventInput[],
  db?: Kysely<Database>
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  await getDb(db).insertInto("layout_events").values(inputs.map(toLayoutRow)).execute();

  cleanupIfNeeded(db, undefined, undefined, inputs.length);
}

export async function getLayoutEvents(
  query: { deviceId?: string; sessionId?: string; sinceTimestamp?: number; limit?: number },
  db?: Kysely<Database>
): Promise<RecordLayoutEventInput[]> {
  let q = getDb(db).selectFrom("layout_events").selectAll();

  if (query.deviceId) {
    q = q.where("device_id", "=", query.deviceId);
  }
  if (query.sessionId) {
    q = q.where("session_id", "=", query.sessionId);
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
    subType: r.sub_type,
    composableName: r.composable_name,
    composableId: r.composable_id,
    recompositionCount: r.recomposition_count,
    durationMs: r.duration_ms,
    likelyCause: r.likely_cause,
    detailsJson: r.details_json,
    screenName: r.screen_name ?? null,
  }));
}

export async function cleanupIfNeeded(
  db?: Kysely<Database>,
  maxRows?: number,
  checkInterval?: number,
  inserted?: number
): Promise<void> {
  await cleanupEventTable("layout_events", retentionState, db, maxRows, checkInterval, inserted);
}
