import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDb, createEventRetentionState, cleanupEventTable } from "./eventRepositoryBase";
import { logger } from "../utils/logger";

export interface RecordStorageEventInput {
  deviceId: string | null;
  timestamp: number;
  applicationId: string | null;
  sessionId: string | null;
  fileName: string;
  key: string | null;
  value: string | null;
  valueType: string | null;
  changeType: string;
  previousValue?: string | null;
}

/**
 * The recorder-contract fields whose canonical defaults the shared normalizer
 * owns. Callers (iOS ingestor, Android wire builder) supply partial, platform-
 * shaped values; the normalizer folds them into a single canonical vocabulary so
 * that a `storage_events` row is platform-independent (issue #3173).
 */
export type PartialStorageEvent = Omit<
  RecordStorageEventInput,
  "valueType" | "changeType"
> & {
  valueType?: string | null;
  changeType?: string | null;
};

/**
 * The canonical, lower-cased `value_type` token persisted regardless of source
 * platform. Absent/blank/`unknown` all collapse to `"unknown"`, so a query,
 * grouping, or UI filter on `value_type` never sees platform-dependent casing
 * (`"STRING"` vs `"string"`) or a NULL/`"unknown"` split.
 */
export function normalizeValueType(valueType: string | null | undefined): string {
  const trimmed = valueType?.trim();
  if (!trimmed) {
    return "unknown";
  }
  return trimmed.toLowerCase();
}

/**
 * Fold a platform-shaped partial storage event into the canonical
 * `RecordStorageEventInput` recorder contract. This is the SINGLE source of the
 * recorder-contract defaults (`changeType ?? "modify"`, canonical `valueType`),
 * preventing the wire-shape/contract-mismatch bug class that #3001 exposed and
 * the cross-platform vocabulary divergence #3173 tracks. Both the iOS and
 * Android call sites persist through here, so a string change on either platform
 * yields the same canonical `value_type` token.
 */
export function normalizeStorageEvent(input: PartialStorageEvent): RecordStorageEventInput {
  return {
    ...input,
    valueType: normalizeValueType(input.valueType),
    changeType: input.changeType?.trim() || "modify",
  };
}

const retentionState = createEventRetentionState();

export async function recordStorageEvent(
  rawInput: RecordStorageEventInput,
  db?: Kysely<Database>
): Promise<void> {
  const d = getDb(db);

  // Canonicalize the recorder-contract fields at this single seam so a row's
  // `value_type`/`change_type` is platform-independent regardless of caller
  // (issue #3173). Both the iOS ingestor and the Android wire builder persist
  // through here, so neither can reintroduce divergent casing/defaults.
  const input = normalizeStorageEvent(rawInput);

  const previousValueSupplied = input.previousValue !== undefined;
  const shouldLookupPreviousValue =
    !previousValueSupplied && input.key !== null && input.deviceId !== null;

  if (shouldLookupPreviousValue && !d.isTransaction) {
    await d.transaction().execute(trx => insertStorageEventWithPreviousValue(input, trx, true));
  } else {
    await insertStorageEventWithPreviousValue(input, d, shouldLookupPreviousValue);
  }

  cleanupIfNeeded(db);
}

async function insertStorageEventWithPreviousValue(
  input: RecordStorageEventInput,
  d: Kysely<Database>,
  shouldLookupPreviousValue: boolean
): Promise<void> {
  // Look up the previous value for this key only when the caller did not supply
  // one. `!== undefined` (not `?? null`) is deliberate: a caller that passes an
  // explicit `previousValue: null` is asserting "there is no prior value" and
  // must NOT trigger the lookup — otherwise a stale older row would silently
  // override that intent. Omitting the field (undefined) is the only auto-lookup
  // trigger.
  //
  // The lookup predicate (device_id=? AND file_name=? AND key=? ORDER BY
  // timestamp DESC LIMIT 1) is served by idx_storage_events_key_lookup as a
  // prefix seek (#2798). `file_name` is a non-null column on both the table and
  // RecordStorageEventInput, so it never binds NULL here (a NULL bind would make
  // `file_name = ?` match nothing regardless of the index).
  let previousValue: string | null = input.previousValue ?? null;
  if (shouldLookupPreviousValue) {
    try {
      const q = d
        .selectFrom("storage_events")
        .select("value")
        .where("device_id", "=", input.deviceId)
        .where("file_name", "=", input.fileName)
        .where("key", "=", input.key)
        .orderBy("timestamp", "desc")
        .limit(1);
      const prev = await q.executeTakeFirst();
      if (prev) {
        previousValue = prev.value;
      }
    } catch (error) {
      // Best-effort lookup: a failure here must not block the insert, but log so
      // it leaves a trace (CLAUDE.md error-handling convention — no bare swallow).
      logger.warn(`storage_events previous-value lookup failed: ${error}`, error);
    }
  }

  await d
    .insertInto("storage_events")
    .values({
      device_id: input.deviceId,
      timestamp: input.timestamp,
      application_id: input.applicationId,
      session_id: input.sessionId,
      file_name: input.fileName,
      key: input.key,
      value: input.value,
      value_type: input.valueType,
      change_type: input.changeType,
      previous_value: previousValue,
    })
    .execute();
}

export async function getStorageEvents(
  query: { deviceId?: string; sinceTimestamp?: number; limit?: number },
  db?: Kysely<Database>
): Promise<RecordStorageEventInput[]> {
  let q = getDb(db).selectFrom("storage_events").selectAll();

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
    fileName: r.file_name,
    key: r.key,
    value: r.value,
    valueType: r.value_type,
    changeType: r.change_type,
    previousValue: r.previous_value ?? null,
  }));
}

export async function cleanupIfNeeded(
  db?: Kysely<Database>,
  maxRows?: number,
  checkInterval?: number
): Promise<void> {
  await cleanupEventTable("storage_events", retentionState, db, maxRows, checkInterval);
}
