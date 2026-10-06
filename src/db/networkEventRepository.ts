import { sql, type Kysely } from "kysely";
import type { Database } from "./types";
import { getDb, createEventRetentionState, cleanupEventTable } from "./eventRepositoryBase";
import { truncateBodyText } from "../utils/truncateBodyText";
import { MOCKED_NETWORK_ERROR_PREFIX } from "../utils/networkRequestOutcome";

export interface RecordNetworkEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  url: string;
  method: string;
  statusCode: number;
  durationMs: number;
  requestBodySize: number;
  responseBodySize: number;
  protocol: string | null;
  requestId?: string | null;
  connectionId?: string | null;
  direction?: string | null;
  metadata?: Record<string, string> | null;
  sequenceNumber?: number | null;
  host: string | null;
  path: string | null;
  error: string | null;
  requestHeaders?: Record<string, string> | null;
  responseHeaders?: Record<string, string> | null;
  requestBody?: string | null;
  responseBody?: string | null;
  contentType?: string | null;
}

const retentionState = createEventRetentionState();

export async function recordNetworkEvent(
  input: RecordNetworkEventInput,
  db?: Kysely<Database>,
): Promise<number> {
  const result = await getDb(db)
    .insertInto("network_events")
    .values({
      device_id: input.deviceId,
      timestamp: input.timestamp,
      application_id: input.applicationId,
      session_id: input.sessionId,
      url: input.url,
      method: input.method,
      status_code: input.statusCode,
      duration_ms: input.durationMs,
      request_body_size: input.requestBodySize,
      response_body_size: input.responseBodySize,
      protocol: input.protocol,
      request_id: input.requestId ?? null,
      connection_id: input.connectionId ?? null,
      direction: input.direction ?? null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      sequence_number: input.sequenceNumber ?? null,
      host: input.host,
      path: input.path,
      error: input.error,
      request_headers_json: input.requestHeaders ? JSON.stringify(input.requestHeaders) : null,
      response_headers_json: input.responseHeaders ? JSON.stringify(input.responseHeaders) : null,
      request_body: input.requestBody ?? null,
      response_body: input.responseBody ?? null,
      content_type: input.contentType ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Retention failures are logged inside pruneEventTableByCount.
  void cleanupIfNeeded(db);

  return result.id;
}

export interface NetworkEventWithId extends RecordNetworkEventInput {
  id: number;
}

export interface NetworkEventQuery {
  deviceId?: string;
  sessionId?: string;
  sinceTimestamp?: number;
  limit?: number;
  host?: string;
  method?: string;
  statusCode?: string;
  minStatusCode?: number;
  errorsOnly?: boolean;
}

function mapRow(r: any): NetworkEventWithId {
  return {
    id: r.id,
    deviceId: r.device_id,
    timestamp: r.timestamp,
    applicationId: r.application_id,
    sessionId: r.session_id,
    url: r.url,
    method: r.method,
    statusCode: r.status_code,
    durationMs: r.duration_ms,
    requestBodySize: r.request_body_size ?? -1,
    responseBodySize: r.response_body_size ?? -1,
    protocol: r.protocol,
    requestId: r.request_id,
    connectionId: r.connection_id,
    direction: r.direction,
    metadata:
      r.metadata_json !== null && r.metadata_json !== undefined
        ? (JSON.parse(r.metadata_json) as Record<string, string>)
        : null,
    sequenceNumber: r.sequence_number,
    host: r.host,
    path: r.path,
    error: r.error,
    requestHeaders: r.request_headers_json ? JSON.parse(r.request_headers_json) : null,
    responseHeaders: r.response_headers_json ? JSON.parse(r.response_headers_json) : null,
    // Truncate bodies to 10KB here so both getNetworkEventById and the
    // getNetworkEvents list projection (fanned out 100-at-a-time by the
    // telemetry backfill) share one cap — the dashboard renders at most this
    // many bytes anyway (#2801). Original sizes are preserved in
    // request_body_size / response_body_size for truncation-flag callers.
    requestBody: truncateBodyText(r.request_body ?? null),
    responseBody: truncateBodyText(r.response_body ?? null),
    contentType: r.content_type ?? null,
  };
}

export async function getNetworkEventById(
  id: number,
  db?: Kysely<Database>,
): Promise<NetworkEventWithId | null> {
  const row = await getDb(db)
    .selectFrom("network_events")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  // mapRow already caps bodies at BODY_TRUNCATION_LIMIT (surrogate-safe), so
  // there is exactly one truncation site shared with getNetworkEvents (#2801).
  return mapRow(row);
}

export async function getNetworkEvents(
  query: NetworkEventQuery,
  db?: Kysely<Database>,
): Promise<NetworkEventWithId[]> {
  let q = getDb(db).selectFrom("network_events").selectAll();

  if (query.deviceId) {
    q = q.where("device_id", "=", query.deviceId);
  }
  if (query.sessionId) {
    q = q.where("session_id", "=", query.sessionId);
  }
  if (query.sinceTimestamp) {
    q = q.where("timestamp", ">=", query.sinceTimestamp);
  }
  if (query.host) {
    q = q.where("host", "=", query.host);
  }
  if (query.method) {
    q = q.where("method", "=", query.method.toUpperCase());
  }
  if (query.statusCode) {
    if (/^\d+$/.test(query.statusCode)) {
      q = q.where("status_code", "=", parseInt(query.statusCode, 10));
    } else if (/^\dxx$/i.test(query.statusCode)) {
      const base = parseInt(query.statusCode[0], 10) * 100;
      q = q.where("status_code", ">=", base).where("status_code", "<", base + 100);
    }
  }
  if (query.minStatusCode !== undefined) {
    q = q.where("status_code", ">=", query.minStatusCode);
  }

  if (query.errorsOnly) {
    // Mirror isFailedNetworkRequest: the schema stores integer statuses (missing = 0).
    // SQLite trim defaults to spaces only; include all ECMAScript trim whitespace.
    const whitespace =
      "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    // A "mocked:<id>" marker is provenance, not a transport failure: only the status decides.
    const trimmedError = sql<string>`trim(error, ${whitespace})`;
    q = q.where((eb) =>
      eb.or([
        eb("status_code", ">=", 400),
        eb("status_code", "<=", 0),
        eb("status_code", "is", null),
        eb.and([
          eb(trimmedError, "!=", ""),
          eb(
            sql<string>`substr(${trimmedError}, 1, ${MOCKED_NETWORK_ERROR_PREFIX.length})`,
            "!=",
            MOCKED_NETWORK_ERROR_PREFIX,
          ),
        ]),
      ]),
    );
  }

  q = q.orderBy("timestamp", "desc").limit(query.limit ?? 100);

  const rows = await q.execute();
  return rows.map(mapRow);
}

export async function cleanupIfNeeded(
  db?: Kysely<Database>,
  maxRows?: number,
  checkInterval?: number,
): Promise<void> {
  await cleanupEventTable("network_events", retentionState, db, maxRows, checkInterval);
}
