import type { Kysely } from "kysely";
import { sql } from "kysely";
import { getDatabase } from "./database";
import type { Database, NewTestExecution, NewTestExecutionStep, NewTestExecutionScreen } from "./types";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { appendToBucket, chunkBySqliteParameterLimit } from "./sqliteBatch";
import { createRowCapRetentionState, pruneTableByRowCap, runAmortizedRetention } from "./rowCapRetention";

const TEST_EXECUTION_RETENTION_MAX_ROWS = 10_000;
export const TEST_EXECUTION_RETENTION_MAX_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const retentionState = createRowCapRetentionState();

export type TestExecutionStatus = "passed" | "failed" | "skipped";

export interface TestStepRecord {
  stepIndex: number;
  action: string;
  target?: string | null;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  screenName?: string | null;
  screenshotPath?: string | null;
  errorMessage?: string | null;
  details?: unknown;
}

export interface TestExecutionRecord {
  testClass: string;
  testMethod: string;
  durationMs: number;
  status: TestExecutionStatus;
  timestamp: number;
  deviceId?: string | null;
  deviceName?: string | null;
  devicePlatform?: "android" | "ios" | null;
  deviceType?: "emulator" | "simulator" | "device" | null;
  appVersion?: string | null;
  gitCommit?: string | null;
  targetSdk?: number | null;
  jdkVersion?: string | null;
  jvmTarget?: string | null;
  gradleVersion?: string | null;
  isCi?: boolean | null;
  sessionUuid?: string | null;
  errorMessage?: string | null;
  videoPath?: string | null;
  snapshotPath?: string | null;
  steps?: TestStepRecord[];
  screensVisited?: Array<{ screenName: string; timestamp: number }>;
}

export interface TestTimingQueryOptions {
  lookbackDays?: number;
  testClass?: string;
  testMethod?: string;
  deviceId?: string;
  deviceName?: string;
  devicePlatform?: "android" | "ios";
  deviceType?: "emulator" | "simulator" | "device";
  appVersion?: string;
  gitCommit?: string;
  targetSdk?: number;
  jdkVersion?: string;
  jvmTarget?: string;
  gradleVersion?: string;
  isCi?: boolean;
  sessionUuid?: string;
  minSamples?: number;
  limit?: number;
  orderBy?: "lastRun" | "averageDuration" | "sampleSize";
  orderDirection?: "asc" | "desc";
}

interface TestTimingStats {
  testClass: string;
  testMethod: string;
  averageDurationMs: number;
  sampleSize: number;
  lastRunTimestampMs: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  stdDevDurationMs: number;
}

interface TestRunStep {
  id: number;
  stepIndex: number;
  action: string;
  target: string | null;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  screenName: string | null;
  screenshotPath: string | null;
  errorMessage: string | null;
  details: unknown;
}

export interface TestRun {
  id: number;
  testClass: string;
  testMethod: string;
  status: TestExecutionStatus;
  startTime: number;
  durationMs: number;
  deviceId: string | null;
  deviceName: string | null;
  platform: "android" | "ios" | null;
  errorMessage: string | null;
  videoPath: string | null;
  snapshotPath: string | null;
  steps: TestRunStep[];
  screensVisited: string[];
}

export interface TestRunQueryOptions {
  testClass?: string;
  testMethod?: string;
  deviceId?: string;
  lookbackDays?: number;
  limit?: number;
  orderDirection?: "asc" | "desc";
}

function parseStepDetailsJson(detailsJson: string | null, stepId: number): unknown {
  if (!detailsJson) {
    return undefined;
  }
  try {
    return JSON.parse(detailsJson) as unknown;
  } catch (error) {
    logger.warn(`[TestExecutionRepository] Failed to parse details_json for step ${stepId}: ${error}`);
    return undefined;
  }
}

export class TestExecutionRepository {
  private timer: Timer;
  private db: Kysely<Database> | null;

  constructor(timer: Timer = defaultTimer, db?: Kysely<Database>) {
    this.timer = timer;
    this.db = db ?? null;
  }

  private getDb(): Kysely<Database> {
    if (this.db) {
      return this.db;
    }
    return getDatabase();
  }

  async recordExecution(record: TestExecutionRecord): Promise<number> {
    const db = this.getDb();

    const executionId = db.isTransaction
      ? await this.recordExecutionWithin(db, record)
      : await db.transaction().execute(trx => this.recordExecutionWithin(trx, record));

    await this.cleanupRetention();
    return executionId;
  }

  private async recordExecutionWithin(db: Kysely<Database>, record: TestExecutionRecord): Promise<number> {
    const entry: NewTestExecution = {
      test_class: record.testClass,
      test_method: record.testMethod,
      duration_ms: Math.max(0, Math.round(record.durationMs)),
      status: record.status,
      timestamp: record.timestamp,
      device_id: record.deviceId ?? null,
      device_name: record.deviceName ?? null,
      device_platform: record.devicePlatform ?? null,
      device_type: record.deviceType ?? null,
      app_version: record.appVersion ?? null,
      git_commit: record.gitCommit ?? null,
      target_sdk: record.targetSdk ?? null,
      jdk_version: record.jdkVersion ?? null,
      jvm_target: record.jvmTarget ?? null,
      gradle_version: record.gradleVersion ?? null,
      is_ci: record.isCi === null || record.isCi === undefined ? null : record.isCi ? 1 : 0,
      session_uuid: record.sessionUuid ?? null,
      error_message: record.errorMessage ?? null,
      video_path: record.videoPath ?? null,
      snapshot_path: record.snapshotPath ?? null,
    };

    const result = await db.insertInto("test_executions").values(entry).executeTakeFirst();
    const executionId = Number(result.insertId);

    // Record steps if provided
    if (record.steps && record.steps.length > 0) {
      const stepEntries: NewTestExecutionStep[] = record.steps.map(step => ({
        execution_id: executionId,
        step_index: step.stepIndex,
        action: step.action,
        target: step.target ?? null,
        status: step.status,
        duration_ms: Math.max(0, Math.round(step.durationMs)),
        screen_name: step.screenName ?? null,
        screenshot_path: step.screenshotPath ?? null,
        error_message: step.errorMessage ?? null,
        details_json: step.details ? JSON.stringify(step.details) : null,
      }));

      await db.insertInto("test_execution_steps").values(stepEntries).execute();
    }

    // Record screens visited if provided
    if (record.screensVisited && record.screensVisited.length > 0) {
      const screenEntries: NewTestExecutionScreen[] = record.screensVisited.map((screen, index) => ({
        execution_id: executionId,
        screen_name: screen.screenName,
        visit_order: index,
        timestamp: screen.timestamp,
      }));

      await db.insertInto("test_execution_screens").values(screenEntries).execute();
    }

    return executionId;
  }

  async getTestRuns(options: TestRunQueryOptions = {}): Promise<TestRun[]> {
    const db = this.getDb();

    let query = db
      .selectFrom("test_executions")
      .select([
        "id",
        "test_class as testClass",
        "test_method as testMethod",
        "status",
        "timestamp as startTime",
        "duration_ms as durationMs",
        "device_id as deviceId",
        "device_name as deviceName",
        "device_platform as platform",
        "error_message as errorMessage",
        "video_path as videoPath",
        "snapshot_path as snapshotPath",
      ]);

    if (options.lookbackDays && options.lookbackDays > 0) {
      const cutoff = this.timer.now() - options.lookbackDays * MS_PER_DAY;
      query = query.where("timestamp", ">=", cutoff);
    }

    if (options.testClass) {
      query = query.where("test_class", "=", options.testClass);
    }

    if (options.testMethod) {
      query = query.where("test_method", "=", options.testMethod);
    }

    if (options.deviceId) {
      query = query.where("device_id", "=", options.deviceId);
    }

    const orderDirection = options.orderDirection ?? "desc";
    query = query.orderBy("timestamp", orderDirection);

    if (options.limit && options.limit > 0) {
      query = query.limit(options.limit);
    }

    const executions = await query.execute();

    const executionIds = executions.map(exec => exec.id);
    if (executionIds.length === 0) {
      return [];
    }

    const stepsByExecutionId = new Map<number, Array<{
      id: number;
      stepIndex: number;
      action: string;
      target: string | null;
      status: "completed" | "failed" | "skipped";
      durationMs: number;
      screenName: string | null;
      screenshotPath: string | null;
      errorMessage: string | null;
      details: unknown;
    }>>();
    const screensByExecutionId = new Map<number, string[]>();

    for (const chunk of chunkBySqliteParameterLimit(executionIds)) {
      const steps = await db
        .selectFrom("test_execution_steps")
        .select([
          "execution_id as executionId",
          "id",
          "step_index as stepIndex",
          "action",
          "target",
          "status",
          "duration_ms as durationMs",
          "screen_name as screenName",
          "screenshot_path as screenshotPath",
          "error_message as errorMessage",
          "details_json as detailsJson",
        ])
        .where("execution_id", "in", chunk)
        .orderBy("execution_id", "asc")
        .orderBy("step_index", "asc")
        .execute();

      const screens = await db
        .selectFrom("test_execution_screens")
        .select(["execution_id as executionId", "screen_name as screenName"])
        .where("execution_id", "in", chunk)
        .orderBy("execution_id", "asc")
        .orderBy("visit_order", "asc")
        .execute();

      for (const step of steps) {
        appendToBucket(stepsByExecutionId, step.executionId, {
          id: step.id,
          stepIndex: step.stepIndex,
          action: step.action,
          target: step.target,
          status: step.status as "completed" | "failed" | "skipped",
          durationMs: step.durationMs,
          screenName: step.screenName,
          screenshotPath: step.screenshotPath,
          errorMessage: step.errorMessage,
          details: parseStepDetailsJson(step.detailsJson, step.id),
        });
      }

      for (const screen of screens) {
        appendToBucket(screensByExecutionId, screen.executionId, screen.screenName);
      }
    }

    return executions.map(exec => {
      const steps = stepsByExecutionId.get(exec.id) ?? [];
      const screensVisited = screensByExecutionId.get(exec.id) ?? [];
      return {
        id: exec.id,
        testClass: exec.testClass,
        testMethod: exec.testMethod,
        status: exec.status as TestExecutionStatus,
        startTime: exec.startTime,
        durationMs: exec.durationMs,
        deviceId: exec.deviceId,
        deviceName: exec.deviceName,
        platform: exec.platform as "android" | "ios" | null,
        errorMessage: exec.errorMessage,
        videoPath: exec.videoPath,
        snapshotPath: exec.snapshotPath,
        steps,
        screensVisited,
      };
    });
  }

  private async cleanupRetention(): Promise<void> {
    // The age-based delete is a cheap indexed/sargable range delete, so it runs
    // on every insert. The row-cap offset probe (LIMIT 1 OFFSET 9999) is the
    // expensive index walk, so it is amortized behind a count(*) gate (#3440).
    try {
      const db = this.getDb();
      const cutoff = this.timer.now() - TEST_EXECUTION_RETENTION_MAX_DAYS * MS_PER_DAY;

      await db
        .deleteFrom("test_executions")
        .where("timestamp", "<", cutoff)
        .execute();
    } catch (error) {
      logger.warn(`[TestExecutionRepository] Age-based retention cleanup failed: ${error}`);
    }

    await runAmortizedRetention(retentionState, () => this.pruneToRowCap());
  }

  // `maxRows` is injectable so tests can exercise trimming at a small cap without
  // inserting 10k rows.
  private async pruneToRowCap(maxRows: number = TEST_EXECUTION_RETENTION_MAX_ROWS): Promise<void> {
    try {
      await pruneTableByRowCap(this.getDb(), "test_executions", maxRows);
    } catch (error) {
      logger.warn(`[TestExecutionRepository] Row-cap retention cleanup failed: ${error}`);
    }
  }

  async getTimingStats(options: TestTimingQueryOptions): Promise<TestTimingStats[]> {
    const db = this.getDb();

    let query = db
      .selectFrom("test_executions")
      .select([
        "test_class as testClass",
        "test_method as testMethod",
        db.fn.avg<number>("duration_ms").as("avgDurationMs"),
        db.fn.avg<number>(sql`duration_ms * duration_ms`).as("avgDurationMsSquared"),
        db.fn.countAll<number>().as("sampleSize"),
        db.fn.max<number>("timestamp").as("lastRunTimestampMs"),
        db.fn.sum<number>(sql`case when status = 'passed' then 1 else 0 end`).as("passedCount"),
        db.fn.sum<number>(sql`case when status = 'failed' then 1 else 0 end`).as("failedCount"),
        db.fn.sum<number>(sql`case when status = 'skipped' then 1 else 0 end`).as("skippedCount"),
      ])
      .groupBy(["test_class", "test_method"]);

    if (options.lookbackDays && options.lookbackDays > 0) {
      const cutoff = this.timer.now() - options.lookbackDays * MS_PER_DAY;
      query = query.where("timestamp", ">=", cutoff);
    }

    if (options.testClass) {
      query = query.where("test_class", "=", options.testClass);
    }

    if (options.testMethod) {
      query = query.where("test_method", "=", options.testMethod);
    }

    if (options.deviceId) {
      query = query.where("device_id", "=", options.deviceId);
    }

    if (options.deviceName) {
      query = query.where("device_name", "=", options.deviceName);
    }

    if (options.devicePlatform) {
      query = query.where("device_platform", "=", options.devicePlatform);
    }

    if (options.deviceType) {
      query = query.where("device_type", "=", options.deviceType);
    }

    if (options.appVersion) {
      query = query.where("app_version", "=", options.appVersion);
    }

    if (options.gitCommit) {
      query = query.where("git_commit", "=", options.gitCommit);
    }

    if (options.targetSdk !== undefined) {
      query = query.where("target_sdk", "=", options.targetSdk);
    }

    if (options.jdkVersion) {
      query = query.where("jdk_version", "=", options.jdkVersion);
    }

    if (options.jvmTarget) {
      query = query.where("jvm_target", "=", options.jvmTarget);
    }

    if (options.gradleVersion) {
      query = query.where("gradle_version", "=", options.gradleVersion);
    }

    if (options.sessionUuid) {
      query = query.where("session_uuid", "=", options.sessionUuid);
    }

    if (typeof options.isCi === "boolean") {
      query = query.where("is_ci", "=", options.isCi ? 1 : 0);
    }

    if (options.minSamples && options.minSamples > 1) {
      query = query.having(db.fn.countAll(), ">=", options.minSamples);
    }

    const orderBy = options.orderBy ?? "lastRun";
    const orderDirection = options.orderDirection ?? "desc";

    switch (orderBy) {
      case "averageDuration":
        query = query.orderBy("avgDurationMs", orderDirection);
        break;
      case "sampleSize":
        query = query.orderBy("sampleSize", orderDirection);
        break;
      default:
        query = query.orderBy("lastRunTimestampMs", orderDirection);
        break;
    }

    if (options.limit && options.limit > 0) {
      query = query.limit(options.limit);
    }

    const rows = await query.execute();

    return rows.map(row => {
      const avgDuration = Number(row.avgDurationMs ?? 0);
      const avgSquare = Number(row.avgDurationMsSquared ?? 0);
      const variance = Math.max(0, avgSquare - avgDuration * avgDuration);
      const stdDev = Math.sqrt(variance);

      return {
        testClass: row.testClass,
        testMethod: row.testMethod,
        averageDurationMs: Math.round(avgDuration),
        sampleSize: Number(row.sampleSize ?? 0),
        lastRunTimestampMs: Number(row.lastRunTimestampMs ?? 0),
        passedCount: Number(row.passedCount ?? 0),
        failedCount: Number(row.failedCount ?? 0),
        skippedCount: Number(row.skippedCount ?? 0),
        stdDevDurationMs: Math.round(stdDev),
      };
    });
  }
}
