import { sql, type Kysely } from "kysely";
import { getDatabase } from "./database";
import type {
  Database,
  NewFailureOccurrence,
  NewFailureOccurrenceScreen,
  NewFailureCapture,
  NewFailureNotification,
} from "./types";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { type DbWriteBarrier, getDbWriteBarrier } from "./dbWriteBarrier";
import { appendToBucket, chunkBySqliteParameterLimit } from "./sqliteBatch";
import {
  createRowCapRetentionState,
  pruneTableByRowCap,
  runAmortizedRetention,
} from "./rowCapRetention";
import type {
  FailureType,
  FailureSeverity,
  StackTraceElement,
  AggregatedToolCallInfo,
  DeviceBreakdown,
  VersionBreakdown,
  ScreenBreakdown,
  FailureGroup,
  FailureOccurrence,
  FailureCapture,
  TimelineDataPoint,
  PeriodTotals,
} from "../server/failuresResources";

const RETENTION_MAX_ROWS = 10_000;
const retentionState = createRowCapRetentionState();

interface FailureScreenCountRow {
  screenName: string;
  failureCount: number;
}

interface VisitScreenCountRow {
  screenName: string;
  visitCount: number;
}

export function mergeScreenBreakdownRows(
  failureScreens: readonly FailureScreenCountRow[],
  visitedScreens: readonly VisitScreenCountRow[],
): ScreenBreakdown[] {
  const visitMap = new Map(visitedScreens.map((screen) => [screen.screenName, screen.visitCount]));
  const totalVisits = visitedScreens.reduce((sum, screen) => sum + screen.visitCount, 0);

  const result: ScreenBreakdown[] = [];
  const processedScreens = new Set<string>();

  for (const row of failureScreens) {
    const visitCount = visitMap.get(row.screenName) ?? 0;
    result.push({
      screenName: row.screenName,
      visitCount,
      failureCount: row.failureCount,
      visitPercentage: totalVisits > 0 ? (visitCount / totalVisits) * 100 : 0,
    });
    processedScreens.add(row.screenName);
  }

  const visitOnlyScreens = visitedScreens
    .filter((screen) => !processedScreens.has(screen.screenName))
    .sort((a, b) => b.visitCount - a.visitCount || a.screenName.localeCompare(b.screenName))
    .slice(0, 5);

  for (const screen of visitOnlyScreens) {
    result.push({
      screenName: screen.screenName,
      visitCount: screen.visitCount,
      failureCount: 0,
      visitPercentage: totalVisits > 0 ? (screen.visitCount / totalVisits) * 100 : 0,
    });
  }

  return result
    .map((screen, index) => ({ screen, index }))
    .sort((a, b) => b.screen.visitCount - a.screen.visitCount || a.index - b.index)
    .map(({ screen }) => screen);
}

// Types for recording failures

export interface RecordFailureInput {
  type: FailureType;
  signature: string;
  title: string;
  message: string;
  severity: FailureSeverity;
  stackTrace?: StackTraceElement[];
  toolCallInfo?: AggregatedToolCallInfo;
  occurrence: {
    deviceId?: string;
    deviceModel: string;
    os: string;
    appVersion: string;
    sessionId: string;
    screenAtFailure?: string;
    screensVisited?: string[];
    testName?: string;
    testExecutionId?: number;
    errorCode?: string;
    durationMs?: number;
    toolArgs?: Record<string, unknown>;
  };
  capture?: {
    type: "screenshot" | "video";
    path: string;
  };
}

// Types for querying failures

interface FailuresQuery {
  type?: FailureType;
  severity?: FailureSeverity;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

interface TimelineQuery {
  startTime: number;
  endTime: number;
  aggregation: "minute" | "hour" | "day" | "week";
}

interface FailuresStreamQuery {
  sinceTimestamp?: number;
  sinceId?: number;
  startTime?: number;
  endTime?: number;
  limit?: number;
  type?: FailureType;
  severity?: FailureSeverity;
  acknowledged?: boolean;
}

interface FailureNotificationEntry {
  id: number;
  occurrenceId: string;
  groupId: string;
  type: FailureType;
  severity: FailureSeverity;
  title: string;
  timestamp: number;
  acknowledged: boolean;
}

interface FailuresStreamResponse {
  notifications: FailureNotificationEntry[];
  lastTimestamp?: number;
  lastId?: number;
}

const STREAM_LIMIT_MAX = 500;

export class FailureAnalyticsRepository {
  private timer: Timer;
  private db: Kysely<Database> | null;
  private getBarrier: () => DbWriteBarrier;
  private idGenerator: IdGenerator;

  constructor(
    timer: Timer = defaultTimer,
    db?: Kysely<Database>,
    // Resolve the shared barrier per write, not once at construction, so a
    // same-process DB reopen (resetDbWriteBarrier swaps in a fresh barrier) is
    // seen instead of a pinned drained instance (issue #2912).
    getBarrier: () => DbWriteBarrier = getDbWriteBarrier,
    idGenerator: IdGenerator = defaultIdGenerator,
  ) {
    this.timer = timer;
    this.db = db ?? null;
    this.getBarrier = getBarrier;
    this.idGenerator = idGenerator;
  }

  private getDb(): Kysely<Database> {
    if (this.db) {
      return this.db;
    }
    return getDatabase();
  }

  /**
   * Record a new failure occurrence, creating or updating the group as needed
   */
  async recordFailure(input: RecordFailureInput): Promise<string> {
    const db = this.getDb();
    const now = this.timer.now();
    const occurrenceId = this.idGenerator.next();

    try {
      await db.transaction().execute(async (trx) => {
        // Atomic get-or-create keyed on signature (#2789). The daemon's single
        // connection releases its mutex across every await, so the former
        // SELECT-then-INSERT/UPDATE interleaved: two same-signature failures could
        // both INSERT (duplicate groups, now blocked by the UNIQUE index from
        // migration 2026_07_01_000) or both read a stale total_count and clobber
        // (lost increments). A single INSERT ... ON CONFLICT DO UPDATE makes the
        // count bump atomic. The candidate id is used only on the first-seen path.
        const candidateGroupId = this.idGenerator.next();
        const nowIso = new Date().toISOString();

        const upserted = await trx
          .insertInto("failure_groups")
          .values({
            id: candidateGroupId,
            type: input.type,
            signature: input.signature,
            title: input.title,
            message: input.message,
            severity: input.severity,
            first_occurrence: now,
            last_occurrence: now,
            total_count: 1,
            unique_sessions: 1,
            stack_trace_json: input.stackTrace ? JSON.stringify(input.stackTrace) : null,
            tool_call_info_json: input.toolCallInfo ? JSON.stringify(input.toolCallInfo) : null,
            updated_at: nowIso,
          })
          .onConflict((oc) =>
            oc.column("signature").doUpdateSet((eb) => ({
              last_occurrence: now,
              total_count: eb("failure_groups.total_count", "+", 1),
              updated_at: nowIso,
            })),
          )
          .returning("id")
          .executeTakeFirstOrThrow();

        const groupId = upserted.id;
        // RETURNING gives the pre-existing id on the conflict path, so a returned
        // id equal to our fresh candidate means this call created the group.
        const isNewGroup = groupId === candidateGroupId;

        // Insert occurrence
        const occurrence: NewFailureOccurrence = {
          id: occurrenceId,
          group_id: groupId,
          timestamp: now,
          device_id: input.occurrence.deviceId ?? null,
          device_model: input.occurrence.deviceModel,
          os: input.occurrence.os,
          app_version: input.occurrence.appVersion,
          session_id: input.occurrence.sessionId,
          screen_at_failure: input.occurrence.screenAtFailure ?? null,
          test_name: input.occurrence.testName ?? null,
          test_execution_id: input.occurrence.testExecutionId ?? null,
          error_code: input.occurrence.errorCode ?? null,
          duration_ms: input.occurrence.durationMs ?? null,
          tool_args_json: input.occurrence.toolArgs
            ? JSON.stringify(input.occurrence.toolArgs)
            : null,
        };

        await trx.insertInto("failure_occurrences").values(occurrence).execute();

        // Derive unique_sessions from the transaction's occurrence rows rather
        // than incrementing a stale read (#2789). COUNT(DISTINCT session_id) is
        // evaluated inside SQLite in one statement, so it is idempotent. Backed
        // by idx_failure_occurrences_group_session so it does not scan the group.
        // Skip it on the first-seen path: the INSERT already set unique_sessions=1
        // and this call's occurrence is the only one, so the recompute is a no-op.
        if (!isNewGroup) {
          await trx
            .updateTable("failure_groups")
            .set({
              unique_sessions: sql<number>`(
                SELECT COUNT(DISTINCT session_id)
                FROM failure_occurrences
                WHERE group_id = ${groupId}
              )`,
            })
            .where("id", "=", groupId)
            .execute();
        }

        // Preserve tool-call-info aggregation. On the first-seen path the upsert
        // already stored this occurrence's info; on the conflict path we fold the
        // new contribution into the existing aggregate. The merge is an inherent
        // read-modify-write (JSON merged in JS), so it must stay inside this
        // method-level transaction to serialize concurrent tool_failure merges.
        if (input.type === "tool_failure" && !isNewGroup) {
          const current = await trx
            .selectFrom("failure_groups")
            .select("tool_call_info_json")
            .where("id", "=", groupId)
            .executeTakeFirst();

          let mergedToolCallInfo = input.toolCallInfo;
          if (current?.tool_call_info_json) {
            const existing = JSON.parse(current.tool_call_info_json) as AggregatedToolCallInfo;
            mergedToolCallInfo = this.mergeToolCallInfo(
              existing,
              input.toolCallInfo,
              input.occurrence,
            );
          }

          await trx
            .updateTable("failure_groups")
            .set({
              tool_call_info_json: mergedToolCallInfo ? JSON.stringify(mergedToolCallInfo) : null,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", groupId)
            .execute();
        }

        // Insert screens visited
        if (input.occurrence.screensVisited && input.occurrence.screensVisited.length > 0) {
          const screens: NewFailureOccurrenceScreen[] = input.occurrence.screensVisited.map(
            (screenName, index) => ({
              occurrence_id: occurrenceId,
              screen_name: screenName,
              visit_order: index,
            }),
          );
          await trx.insertInto("failure_occurrence_screens").values(screens).execute();
        }

        // Insert capture if provided
        if (input.capture) {
          const capture: NewFailureCapture = {
            id: this.idGenerator.next(),
            occurrence_id: occurrenceId,
            type: input.capture.type,
            path: input.capture.path,
            timestamp: now,
            device_model: input.occurrence.deviceModel,
          };
          await trx.insertInto("failure_captures").values(capture).execute();
        }

        // Create notification for streaming
        const notification: NewFailureNotification = {
          occurrence_id: occurrenceId,
          group_id: groupId,
          type: input.type,
          severity: input.severity,
          title: input.title,
          timestamp: now,
          acknowledged: 0,
        };
        await trx.insertInto("failure_notifications").values(notification).execute();
      });

      // Run retention cleanup in background, tracked by the shutdown barrier so
      // this fire-and-forget writer is drained (or skipped) before closeDatabase().
      this.getBarrier()
        .track(() => this.cleanupRetention())
        .catch(() => {});

      return occurrenceId;
    } catch (error) {
      logger.error(`[FailureAnalyticsRepository] Failed to record failure: ${error}`);
      throw error;
    }
  }

  /**
   * Get all failure groups with aggregated data
   */
  async getFailureGroups(query: FailuresQuery = {}): Promise<FailureGroup[]> {
    const db = this.getDb();
    const limit = Math.max(1, query.limit ?? 100);
    const offset = Math.max(0, query.offset ?? 0);

    let builder = db.selectFrom("failure_groups").selectAll();

    if (query.type) {
      builder = builder.where("type", "=", query.type);
    }
    if (query.severity) {
      builder = builder.where("severity", "=", query.severity);
    }
    if (query.startTime) {
      builder = builder.where("last_occurrence", ">=", query.startTime);
    }
    if (query.endTime) {
      builder = builder.where("last_occurrence", "<=", query.endTime);
    }

    const groups = await builder
      .orderBy("last_occurrence", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    const groupIds = groups.map((group) => group.id);
    if (groupIds.length === 0) {
      return [];
    }

    const [
      deviceBreakdowns,
      versionBreakdowns,
      screenBreakdowns,
      affectedTestsByGroup,
      recentCapturesByGroup,
      sampleOccurrencesByGroup,
    ] = await Promise.all([
      this.getDeviceBreakdowns(groupIds),
      this.getVersionBreakdowns(groupIds),
      this.getScreenBreakdowns(groupIds),
      this.getAffectedTestsByGroup(groupIds),
      this.getRecentCapturesByGroup(groupIds, 5),
      this.getSampleOccurrencesByGroup(groupIds, 6),
    ]);

    return groups.map((group) => {
      const screenBreakdown = screenBreakdowns.get(group.id) ?? [];
      return {
        id: group.id,
        type: group.type as FailureType,
        signature: group.signature,
        title: group.title,
        message: group.message,
        firstOccurrence: group.first_occurrence,
        lastOccurrence: group.last_occurrence,
        totalCount: group.total_count,
        uniqueSessions: group.unique_sessions,
        severity: group.severity as FailureSeverity,
        deviceBreakdown: deviceBreakdowns.get(group.id) ?? [],
        versionBreakdown: versionBreakdowns.get(group.id) ?? [],
        screenBreakdown,
        failureScreens: this.computeFailureScreens(screenBreakdown),
        stackTraceElements: group.stack_trace_json
          ? (JSON.parse(group.stack_trace_json) as StackTraceElement[])
          : [],
        toolCallInfo: group.tool_call_info_json
          ? (JSON.parse(group.tool_call_info_json) as AggregatedToolCallInfo)
          : null,
        affectedTests: affectedTestsByGroup.get(group.id) ?? {},
        recentCaptures: recentCapturesByGroup.get(group.id) ?? [],
        sampleOccurrences: sampleOccurrencesByGroup.get(group.id) ?? [],
      };
    });
  }

  /**
   * Get timeline data with aggregation
   */
  async getTimelineData(query: TimelineQuery): Promise<{
    dataPoints: TimelineDataPoint[];
    previousPeriodTotals: PeriodTotals;
  }> {
    const db = this.getDb();
    const { startTime, endTime, aggregation } = query;

    // Get bucket duration in ms
    const bucketMs = this.getAggregationMs(aggregation);
    const periodDuration = endTime - startTime;

    // Aggregate occurrences per (bucket, type) in SQL rather than transferring
    // every occurrence and bucketing/counting in JS (#3439). `bucketMs` is a
    // constant here, so integer-dividing the timestamp yields the bucket index;
    // CAST(... AS INTEGER) makes the truncation explicit regardless of how the
    // bound value types. Only O(buckets * types) rows transfer.
    const bucketIndex = sql<number>`cast(failure_occurrences.timestamp / ${bucketMs} as integer)`;
    const bucketedCounts = await db
      .selectFrom("failure_occurrences")
      .innerJoin("failure_groups", "failure_occurrences.group_id", "failure_groups.id")
      .select([
        bucketIndex.as("bucket"),
        "failure_groups.type",
        db.fn.countAll<number>().as("count"),
      ])
      .where("failure_occurrences.timestamp", ">=", startTime)
      .where("failure_occurrences.timestamp", "<=", endTime)
      .groupBy([bucketIndex, "failure_groups.type"])
      .execute();

    // Pre-create all buckets for the time range with zero values, then fill from
    // the aggregate so empty buckets still appear as zeros.
    const buckets = new Map<number, PeriodTotals>();
    const firstBucketStart = Math.floor(startTime / bucketMs) * bucketMs;
    const lastBucketStart = Math.floor(endTime / bucketMs) * bucketMs;

    for (
      let bucketStart = firstBucketStart;
      bucketStart <= lastBucketStart;
      bucketStart += bucketMs
    ) {
      buckets.set(bucketStart, { crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 });
    }

    for (const row of bucketedCounts) {
      const bucketStart = Number(row.bucket) * bucketMs;
      const bucket = buckets.get(bucketStart);
      if (!bucket) {
        continue;
      } // Should not happen, but guard against it
      this.addTypeCount(bucket, row.type as FailureType, Number(row.count));
    }

    // Convert to sorted array
    const dataPoints: TimelineDataPoint[] = [];
    const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);

    for (const [bucketStart, counts] of sortedBuckets) {
      dataPoints.push({
        label: this.formatBucketLabel(bucketStart, aggregation),
        crashes: counts.crashes,
        anrs: counts.anrs,
        toolFailures: counts.toolFailures,
        nonfatals: counts.nonfatals,
      });
    }

    // Previous period totals: one grouped COUNT(*) rather than fetching every
    // occurrence and running four full `.filter().length` passes (#3439).
    const previousStart = startTime - periodDuration;
    const previousEnd = startTime;

    const previousCounts = await db
      .selectFrom("failure_occurrences")
      .innerJoin("failure_groups", "failure_occurrences.group_id", "failure_groups.id")
      .select(["failure_groups.type", db.fn.countAll<number>().as("count")])
      .where("failure_occurrences.timestamp", ">=", previousStart)
      .where("failure_occurrences.timestamp", "<", previousEnd)
      .groupBy("failure_groups.type")
      .execute();

    const previousPeriodTotals: PeriodTotals = {
      crashes: 0,
      anrs: 0,
      toolFailures: 0,
      nonfatals: 0,
    };
    for (const row of previousCounts) {
      this.addTypeCount(previousPeriodTotals, row.type as FailureType, Number(row.count));
    }

    return { dataPoints, previousPeriodTotals };
  }

  // Add `count` to the field of `target` matching the failure `type`. Both the
  // per-bucket tallies and the previous-period totals share the same four
  // fields, so one accumulator serves both.
  private addTypeCount(target: PeriodTotals, type: FailureType, count: number): void {
    switch (type) {
      case "crash":
        target.crashes += count;
        break;
      case "anr":
        target.anrs += count;
        break;
      case "tool_failure":
        target.toolFailures += count;
        break;
      case "nonfatal":
        target.nonfatals += count;
        break;
    }
  }

  /**
   * Get new failure notifications since a cursor (for streaming)
   */
  async getNotificationsSince(query: FailuresStreamQuery): Promise<FailuresStreamResponse> {
    const db = this.getDb();
    const limit = Math.min(Math.max(1, query.limit ?? 50), STREAM_LIMIT_MAX);

    let builder = db.selectFrom("failure_notifications").selectAll();

    if (query.type) {
      builder = builder.where("type", "=", query.type);
    }
    if (query.acknowledged !== undefined) {
      builder = builder.where("acknowledged", "=", query.acknowledged ? 1 : 0);
    }
    if (query.startTime) {
      builder = builder.where("timestamp", ">=", query.startTime);
    }
    if (query.endTime) {
      builder = builder.where("timestamp", "<=", query.endTime);
    }
    if (query.sinceTimestamp !== undefined) {
      const sinceId = query.sinceId ?? 0;
      builder = builder.where((eb) =>
        eb.or([
          eb("timestamp", ">", query.sinceTimestamp!),
          eb.and([eb("timestamp", "=", query.sinceTimestamp!), eb("id", ">", sinceId)]),
        ]),
      );
    }

    const rows = await builder
      .orderBy("timestamp", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();

    const notifications: FailureNotificationEntry[] = rows.map((row) => ({
      id: row.id,
      occurrenceId: row.occurrence_id,
      groupId: row.group_id,
      type: row.type as FailureType,
      severity: row.severity as FailureSeverity,
      title: row.title,
      timestamp: row.timestamp,
      acknowledged: row.acknowledged === 1,
    }));

    const last = notifications.length > 0 ? notifications[notifications.length - 1] : undefined;

    return {
      notifications,
      lastTimestamp: last?.timestamp ?? query.sinceTimestamp,
      lastId: last?.id ?? query.sinceId,
    };
  }

  /**
   * Acknowledge notifications (mark as read)
   */
  async acknowledgeNotifications(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const db = this.getDb();
    await db
      .updateTable("failure_notifications")
      .set({ acknowledged: 1 })
      .where("id", "in", ids)
      .execute();
  }

  /**
   * Get aggregated data for groups (used for streaming updates)
   */
  async getAggregatedGroups(query: FailuresStreamQuery): Promise<{
    groups: FailureGroup[];
    totals: { crashes: number; anrs: number; toolFailures: number; nonfatals: number };
  }> {
    const groups = await this.getFailureGroups({
      startTime: query.startTime,
      endTime: query.endTime,
      type: query.type,
      severity: query.severity,
    });

    const totals = {
      crashes: groups.filter((g) => g.type === "crash").reduce((sum, g) => sum + g.totalCount, 0),
      anrs: groups.filter((g) => g.type === "anr").reduce((sum, g) => sum + g.totalCount, 0),
      toolFailures: groups
        .filter((g) => g.type === "tool_failure")
        .reduce((sum, g) => sum + g.totalCount, 0),
      nonfatals: groups
        .filter((g) => g.type === "nonfatal")
        .reduce((sum, g) => sum + g.totalCount, 0),
    };

    return { groups, totals };
  }

  // Private helper methods

  private async getDeviceBreakdowns(groupIds: string[]): Promise<Map<string, DeviceBreakdown[]>> {
    const db = this.getDb();
    const buckets = new Map<
      string,
      Array<{
        deviceModel: string;
        os: string;
        count: number;
      }>
    >();

    for (const chunk of chunkBySqliteParameterLimit(groupIds)) {
      const rows = await sql<{
        groupId: string;
        deviceModel: string;
        os: string;
        occurrenceCount: number;
      }>`
        SELECT groupId, deviceModel, os, occurrenceCount
        FROM (
          SELECT
            group_id AS groupId,
            device_model AS deviceModel,
            os,
            COUNT(id) AS occurrenceCount,
            ROW_NUMBER() OVER (
              PARTITION BY group_id
              ORDER BY COUNT(id) DESC, device_model ASC, os ASC
            ) AS rn
          FROM failure_occurrences
          WHERE group_id IN (${sql.join(chunk)})
          GROUP BY group_id, device_model, os
        )
        WHERE rn <= 10
        ORDER BY groupId ASC, occurrenceCount DESC, deviceModel ASC, os ASC
      `.execute(db);

      for (const row of rows.rows) {
        appendToBucket(buckets, row.groupId, {
          deviceModel: row.deviceModel,
          os: row.os,
          count: Number(row.occurrenceCount),
        });
      }
    }

    const result = new Map<string, DeviceBreakdown[]>();
    for (const [groupId, rows] of buckets) {
      const sorted = rows
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.deviceModel.localeCompare(b.deviceModel) ||
            a.os.localeCompare(b.os),
        )
        .slice(0, 10);
      const total = sorted.reduce((sum, row) => sum + row.count, 0);
      result.set(
        groupId,
        sorted.map((row) => ({
          deviceModel: row.deviceModel,
          os: row.os,
          count: row.count,
          percentage: total > 0 ? (row.count / total) * 100 : 0,
        })),
      );
    }
    return result;
  }

  private async getVersionBreakdowns(groupIds: string[]): Promise<Map<string, VersionBreakdown[]>> {
    const db = this.getDb();
    const buckets = new Map<string, Array<{ version: string; count: number }>>();

    for (const chunk of chunkBySqliteParameterLimit(groupIds)) {
      const rows = await sql<{
        groupId: string;
        version: string;
        occurrenceCount: number;
      }>`
        SELECT groupId, version, occurrenceCount
        FROM (
          SELECT
            group_id AS groupId,
            app_version AS version,
            COUNT(id) AS occurrenceCount,
            ROW_NUMBER() OVER (
              PARTITION BY group_id
              ORDER BY COUNT(id) DESC, app_version ASC
            ) AS rn
          FROM failure_occurrences
          WHERE group_id IN (${sql.join(chunk)})
          GROUP BY group_id, app_version
        )
        WHERE rn <= 10
        ORDER BY groupId ASC, occurrenceCount DESC, version ASC
      `.execute(db);

      for (const row of rows.rows) {
        appendToBucket(buckets, row.groupId, {
          version: row.version,
          count: Number(row.occurrenceCount),
        });
      }
    }

    const result = new Map<string, VersionBreakdown[]>();
    for (const [groupId, rows] of buckets) {
      const sorted = rows
        .sort((a, b) => b.count - a.count || a.version.localeCompare(b.version))
        .slice(0, 10);
      const total = sorted.reduce((sum, row) => sum + row.count, 0);
      result.set(
        groupId,
        sorted.map((row) => ({
          version: row.version,
          count: row.count,
          percentage: total > 0 ? (row.count / total) * 100 : 0,
        })),
      );
    }
    return result;
  }

  private async getScreenBreakdowns(groupIds: string[]): Promise<Map<string, ScreenBreakdown[]>> {
    const db = this.getDb();
    const failureScreensByGroup = new Map<string, FailureScreenCountRow[]>();
    const visitedScreensByGroup = new Map<string, VisitScreenCountRow[]>();

    for (const chunk of chunkBySqliteParameterLimit(groupIds)) {
      const failureRows = await sql<{
        groupId: string;
        screenName: string;
        failureCount: number;
      }>`
        SELECT
          group_id AS groupId,
          screen_at_failure AS screenName,
          COUNT(id) AS failureCount
        FROM failure_occurrences
        WHERE group_id IN (${sql.join(chunk)})
          AND screen_at_failure IS NOT NULL
        GROUP BY group_id, screen_at_failure
        ORDER BY group_id ASC, screen_at_failure ASC
      `.execute(db);

      const visitRows = await sql<{
        groupId: string;
        screenName: string;
        visitCount: number;
      }>`
        SELECT
          failure_occurrences.group_id AS groupId,
          failure_occurrence_screens.screen_name AS screenName,
          COUNT(failure_occurrence_screens.id) AS visitCount
        FROM failure_occurrence_screens
        INNER JOIN failure_occurrences
          ON failure_occurrence_screens.occurrence_id = failure_occurrences.id
        WHERE failure_occurrences.group_id IN (${sql.join(chunk)})
        GROUP BY failure_occurrences.group_id, failure_occurrence_screens.screen_name
        ORDER BY failure_occurrences.group_id ASC, failure_occurrence_screens.screen_name ASC
      `.execute(db);

      for (const row of failureRows.rows) {
        appendToBucket(failureScreensByGroup, row.groupId, {
          screenName: row.screenName,
          failureCount: Number(row.failureCount),
        });
      }
      for (const row of visitRows.rows) {
        appendToBucket(visitedScreensByGroup, row.groupId, {
          screenName: row.screenName,
          visitCount: Number(row.visitCount),
        });
      }
    }

    const result = new Map<string, ScreenBreakdown[]>();
    for (const groupId of groupIds) {
      result.set(
        groupId,
        mergeScreenBreakdownRows(
          failureScreensByGroup.get(groupId) ?? [],
          visitedScreensByGroup.get(groupId) ?? [],
        ),
      );
    }
    return result;
  }

  private async getAffectedTestsByGroup(
    groupIds: string[],
  ): Promise<Map<string, Record<string, number>>> {
    const db = this.getDb();
    const result = new Map<string, Record<string, number>>();

    for (const chunk of chunkBySqliteParameterLimit(groupIds)) {
      const rows = await sql<{
        groupId: string;
        testName: string;
        occurrenceCount: number;
      }>`
        SELECT
          group_id AS groupId,
          test_name AS testName,
          COUNT(id) AS occurrenceCount
        FROM failure_occurrences
        WHERE group_id IN (${sql.join(chunk)})
          AND test_name IS NOT NULL
        GROUP BY group_id, test_name
        ORDER BY group_id ASC, test_name ASC
      `.execute(db);

      for (const row of rows.rows) {
        const tests = result.get(row.groupId) ?? {};
        tests[row.testName] = Number(row.occurrenceCount);
        result.set(row.groupId, tests);
      }
    }

    return result;
  }

  private async getRecentCapturesByGroup(
    groupIds: string[],
    limit: number,
  ): Promise<Map<string, FailureCapture[]>> {
    const db = this.getDb();
    const result = new Map<string, FailureCapture[]>();

    for (const chunk of chunkBySqliteParameterLimit(groupIds, 1)) {
      const rows = await sql<{
        groupId: string;
        id: string;
        type: "screenshot" | "video";
        path: string;
        timestamp: number;
        deviceModel: string;
      }>`
        SELECT groupId, id, type, path, timestamp, deviceModel
        FROM (
          SELECT
            failure_occurrences.group_id AS groupId,
            failure_captures.id,
            failure_captures.type,
            failure_captures.path,
            failure_captures.timestamp,
            failure_captures.device_model AS deviceModel,
            ROW_NUMBER() OVER (
              PARTITION BY failure_occurrences.group_id
              ORDER BY failure_captures.timestamp DESC, failure_captures.id ASC
            ) AS rn
          FROM failure_captures
          INNER JOIN failure_occurrences
            ON failure_captures.occurrence_id = failure_occurrences.id
          WHERE failure_occurrences.group_id IN (${sql.join(chunk)})
        )
        WHERE rn <= ${limit}
        ORDER BY groupId ASC, timestamp DESC, id ASC
      `.execute(db);

      for (const row of rows.rows) {
        appendToBucket(result, row.groupId, {
          id: row.id,
          type: row.type,
          path: row.path,
          timestamp: row.timestamp,
          deviceModel: row.deviceModel,
        });
      }
    }

    return result;
  }

  private async getSampleOccurrencesByGroup(
    groupIds: string[],
    limit: number,
  ): Promise<Map<string, FailureOccurrence[]>> {
    const db = this.getDb();
    const occurrenceRows: Array<{
      id: string;
      groupId: string;
      timestamp: number;
      deviceModel: string;
      os: string;
      appVersion: string;
      sessionId: string;
      screenAtFailure: string | null;
      testName: string | null;
    }> = [];

    for (const chunk of chunkBySqliteParameterLimit(groupIds, 1)) {
      const rows = await sql<{
        id: string;
        groupId: string;
        timestamp: number;
        deviceModel: string;
        os: string;
        appVersion: string;
        sessionId: string;
        screenAtFailure: string | null;
        testName: string | null;
      }>`
        SELECT
          id,
          groupId,
          timestamp,
          deviceModel,
          os,
          appVersion,
          sessionId,
          screenAtFailure,
          testName
        FROM (
          SELECT
            id,
            group_id AS groupId,
            timestamp,
            device_model AS deviceModel,
            os,
            app_version AS appVersion,
            session_id AS sessionId,
            screen_at_failure AS screenAtFailure,
            test_name AS testName,
            ROW_NUMBER() OVER (
              PARTITION BY group_id
              ORDER BY timestamp DESC, id ASC
            ) AS rn
          FROM failure_occurrences
          WHERE group_id IN (${sql.join(chunk)})
        )
        WHERE rn <= ${limit}
        ORDER BY groupId ASC, timestamp DESC, id ASC
      `.execute(db);

      occurrenceRows.push(...rows.rows);
    }

    const occurrenceIds = occurrenceRows.map((row) => row.id);
    const screensByOccurrence = new Map<string, string[]>();
    const captureByOccurrence = new Map<string, { path: string; type: "screenshot" | "video" }>();

    for (const chunk of chunkBySqliteParameterLimit(occurrenceIds)) {
      const screenRows = await sql<{
        occurrenceId: string;
        screenName: string;
      }>`
        SELECT
          occurrence_id AS occurrenceId,
          screen_name AS screenName
        FROM failure_occurrence_screens
        WHERE occurrence_id IN (${sql.join(chunk)})
        ORDER BY occurrence_id ASC, visit_order ASC
      `.execute(db);

      const captureRows = await sql<{
        occurrenceId: string;
        path: string;
        type: "screenshot" | "video";
      }>`
        SELECT
          occurrence_id AS occurrenceId,
          path,
          type
        FROM failure_captures
        WHERE occurrence_id IN (${sql.join(chunk)})
        ORDER BY occurrence_id ASC, timestamp DESC, id ASC
      `.execute(db);

      for (const row of screenRows.rows) {
        appendToBucket(screensByOccurrence, row.occurrenceId, row.screenName);
      }
      for (const row of captureRows.rows) {
        if (!captureByOccurrence.has(row.occurrenceId)) {
          captureByOccurrence.set(row.occurrenceId, {
            path: row.path,
            type: row.type,
          });
        }
      }
    }

    const result = new Map<string, FailureOccurrence[]>();
    for (const row of occurrenceRows) {
      const capture = captureByOccurrence.get(row.id);
      appendToBucket(result, row.groupId, {
        id: row.id,
        timestamp: row.timestamp,
        deviceModel: row.deviceModel,
        os: row.os,
        appVersion: row.appVersion,
        sessionId: row.sessionId,
        screenAtFailure: row.screenAtFailure,
        screensVisited: screensByOccurrence.get(row.id) ?? [],
        testName: row.testName,
        capturePath: capture?.path ?? null,
        captureType: capture?.type ?? null,
      });
    }

    return result;
  }

  private computeFailureScreens(screenBreakdown: ScreenBreakdown[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const screen of screenBreakdown) {
      if (screen.failureCount > 0) {
        result[screen.screenName] = screen.failureCount;
      }
    }
    return result;
  }

  private mergeToolCallInfo(
    existing: AggregatedToolCallInfo,
    newInfo: AggregatedToolCallInfo | undefined,
    occurrence: RecordFailureInput["occurrence"],
  ): AggregatedToolCallInfo {
    if (!newInfo) {
      // Just update error codes from occurrence
      const errorCodes = { ...existing.errorCodes };
      if (occurrence.errorCode) {
        errorCodes[occurrence.errorCode] = (errorCodes[occurrence.errorCode] ?? 0) + 1;
      }
      return { ...existing, errorCodes };
    }

    // Merge error codes
    const errorCodes = { ...existing.errorCodes };
    for (const [code, count] of Object.entries(newInfo.errorCodes)) {
      errorCodes[code] = (errorCodes[code] ?? 0) + count;
    }

    // Merge parameter variants (keep unique values)
    const parameterVariants: Record<string, string[]> = { ...existing.parameterVariants };
    for (const [param, values] of Object.entries(newInfo.parameterVariants)) {
      const existingValues = new Set(parameterVariants[param] ?? []);
      for (const val of values) {
        existingValues.add(val);
      }
      parameterVariants[param] = Array.from(existingValues).slice(0, 10); // Limit variants
    }

    // Merge duration stats (simple average approach)
    let durationStats = existing.durationStats;
    if (newInfo.durationStats && existing.durationStats) {
      durationStats = {
        minMs: Math.min(existing.durationStats.minMs, newInfo.durationStats.minMs),
        maxMs: Math.max(existing.durationStats.maxMs, newInfo.durationStats.maxMs),
        avgMs: Math.round((existing.durationStats.avgMs + newInfo.durationStats.avgMs) / 2),
        medianMs: Math.round(
          (existing.durationStats.medianMs + newInfo.durationStats.medianMs) / 2,
        ),
        p95Ms: Math.max(existing.durationStats.p95Ms, newInfo.durationStats.p95Ms),
      };
    } else if (newInfo.durationStats) {
      durationStats = newInfo.durationStats;
    }

    return {
      toolName: existing.toolName,
      errorCodes,
      parameterVariants,
      durationStats,
    };
  }

  private getAggregationMs(aggregation: "minute" | "hour" | "day" | "week"): number {
    switch (aggregation) {
      case "minute":
        return 60 * 1000;
      case "hour":
        return 60 * 60 * 1000;
      case "day":
        return 24 * 60 * 60 * 1000;
      case "week":
        return 7 * 24 * 60 * 60 * 1000;
    }
  }

  private formatBucketLabel(
    timestamp: number,
    aggregation: "minute" | "hour" | "day" | "week",
  ): string {
    const date = new Date(timestamp);

    switch (aggregation) {
      case "minute": {
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? "PM" : "AM";
        const displayHours = hours % 12 || 12;
        return `${displayHours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
      }
      case "hour": {
        const hours = date.getHours();
        const ampm = hours >= 12 ? "PM" : "AM";
        const displayHours = hours % 12 || 12;
        return `${displayHours} ${ampm}`;
      }
      case "day": {
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        return `${months[date.getMonth()]} ${date.getDate()}`;
      }
      case "week": {
        // Get Monday of the week
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(date.setDate(diff));
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        return `${months[monday.getMonth()]} ${monday.getDate()}`;
      }
    }
  }

  private async cleanupRetention(): Promise<void> {
    // Amortize the offset probe and orphan sweep: fire at most once per
    // CLEANUP_CHECK_INTERVAL failures and gate the index walk on a cheap
    // count(*), instead of running both full-table operations on every ingest
    // (#3436).
    await runAmortizedRetention(retentionState, () => this.pruneToRowCap());
  }

  // `maxRows` is injectable so tests can exercise trimming at a small cap without
  // inserting 10k rows.
  private async pruneToRowCap(maxRows: number = RETENTION_MAX_ROWS): Promise<void> {
    try {
      const db = this.getDb();

      // Delete old occurrences (cascades to screens, captures, notifications).
      const deleted = await pruneTableByRowCap(db, "failure_occurrences", maxRows);

      // Only sweep orphan groups when occurrences were actually removed, and
      // use a correlated NOT EXISTS (index-served, early-exit) rather than
      // materializing the full DISTINCT set for a NOT IN scan.
      if (deleted > 0) {
        await db
          .deleteFrom("failure_groups")
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("failure_occurrences")
                  .select(sql`1`.as("one"))
                  .whereRef("failure_occurrences.group_id", "=", "failure_groups.id"),
              ),
            ),
          )
          .execute();
      }
    } catch (error) {
      logger.warn(`[FailureAnalyticsRepository] Retention cleanup failed: ${error}`);
    }
  }
}
