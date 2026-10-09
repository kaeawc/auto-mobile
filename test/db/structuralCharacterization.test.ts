import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { CompiledQuery, Kysely, sql } from "kysely";
import type { Database } from "../../src/db/types";
import { BunSqliteDialect, BunSqliteConnectionState } from "../../src/db/bunSqliteDialect";
import { NavigationRepository } from "../../src/db/navigationRepository";
import {
  VideoRecordingRepository,
  type VideoRecordingRecord,
} from "../../src/db/videoRecordingRepository";
import {
  TestExecutionRepository,
  type TestExecutionRecord,
} from "../../src/db/testExecutionRepository";
import { FailureEventRepository } from "../../src/db/failureEventRepository";
import {
  FailureAnalyticsRepository,
  type RecordFailureInput,
} from "../../src/db/failureAnalyticsRepository";
import { up as navigationUp } from "../../src/db/migrations/2025_12_30_001_navigation_graph";
import { up as failuresUp } from "../../src/db/migrations/2026_01_27_000_failures";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

beforeAll(async () => {
  const db = await createTestDatabase();
  await db.destroy();
});

describe("structural repository characterization", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
  });
  afterEach(async () => {
    await db.destroy();
  });

  test.each([
    {},
    {
      text: "",
      resourceId: "id",
      contentDescription: "desc",
      className: "Button",
      bounds: { left: 0, top: 1, right: 2, bottom: 3 },
      clickable: false,
      scrollable: true,
    },
  ])("UI element creation and reuse %j", async (element) => {
    const repo = new NavigationRepository(db);
    await repo.getOrCreateApp("app");
    const first = await repo.getOrCreateUIElement("app", element, 100);
    const second = await repo.getOrCreateUIElement("app", element, 200);
    expect(second).toEqual({ ...first, last_seen_at: 200 });
    expect(first).toMatchObject({
      text: element.text ?? null,
      resource_id: element.resourceId ?? null,
      clickable: element.clickable === false ? 0 : null,
      scrollable: element.scrollable === true ? 1 : null,
    });
  });

  const recording: VideoRecordingRecord = {
    recordingId: "rec",
    deviceId: "device",
    platform: "android",
    status: "recording",
    fileName: "a.mp4",
    filePath: "/tmp/a.mp4",
    format: "mp4",
    sizeBytes: 1,
    createdAt: "2025-01-01",
    startedAt: "2025-01-01",
    lastAccessedAt: "2025-01-01",
    config: {
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
    },
  };
  test("video updates preserve omitted fields and serialize metadata", async () => {
    const repo = new VideoRecordingRepository(db);
    await repo.insertRecording(recording);
    const update: Partial<VideoRecordingRecord> = {
      ...recording,
      deviceId: "changed",
      platform: "ios",
      status: "completed",
      outputName: "out",
      sizeBytes: 0,
      durationMs: 0,
      codec: "h264",
      endedAt: "2025-01-02",
      ownerSessionUuid: "owner",
      highlights: [],
      recordedPanel: { key: "1", role: "inner" },
      transitions: [],
    };
    await repo.updateRecording("rec", update);
    expect(await repo.getRecording("rec")).toMatchObject(update);
    await repo.updateRecording("rec", {
      outputName: undefined,
      durationMs: undefined,
      config: undefined,
    });
    expect(await repo.getRecording("rec")).toMatchObject(update);
  });

  test.each([undefined, false, true, null])(
    "execution metadata and child records with CI %j",
    async (isCi) => {
      const repo = new TestExecutionRepository(timer, db);
      const record: TestExecutionRecord = {
        testClass: "Class",
        testMethod: "method",
        durationMs: 2.6,
        status: "passed",
        timestamp: 1_000_000,
        isCi,
        deviceId: "device",
        deviceName: "name",
        devicePlatform: "android",
        deviceType: "emulator",
        appVersion: "1",
        gitCommit: "commit",
        targetSdk: 36,
        jdkVersion: "21",
        jvmTarget: "17",
        gradleVersion: "9",
        sessionUuid: "session",
        errorMessage: "error",
        videoPath: "video",
        snapshotPath: "snapshot",
        steps: [
          { stepIndex: 0, action: "tap", status: "completed", durationMs: -1, details: { a: 1 } },
        ],
        screensVisited: [{ screenName: "Home", timestamp: 1_000_000 }],
      };
      const id = await repo.recordExecution(record);
      const row = await db
        .selectFrom("test_executions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row.is_ci).toBe(isCi === null || isCi === undefined ? null : isCi ? 1 : 0);
      expect(row.duration_ms).toBe(3);
      const runs = await repo.getTestRuns({
        lookbackDays: 1,
        testClass: "Class",
        testMethod: "method",
        deviceId: "device",
        limit: 1,
        orderDirection: "asc",
      });
      expect(runs[0].steps[0]).toMatchObject({ target: null, durationMs: 0, details: { a: 1 } });
      expect(runs[0].screensVisited).toEqual(["Home"]);
      const stats = await repo.getTimingStats({
        ...record,
        lookbackDays: 1,
        minSamples: 1,
        limit: 1,
        orderBy: "averageDuration",
        isCi: isCi ?? undefined,
      });
      expect(stats).toMatchObject([
        { averageDurationMs: 3, sampleSize: 1, passedCount: 1, stdDevDurationMs: 0 },
      ]);
      expect(await repo.getTestRuns({ testClass: "missing" })).toEqual([]);
    },
  );

  test("execution defaults, empty children and timing filters", async () => {
    const repo = new TestExecutionRepository(timer, db);
    await repo.recordExecution({
      testClass: "C",
      testMethod: "m",
      durationMs: 0,
      status: "failed",
      timestamp: 1_000_000,
      steps: [],
      screensVisited: [],
    });
    expect((await repo.getTestRuns())[0]).toMatchObject({
      deviceId: null,
      steps: [],
      screensVisited: [],
    });
    expect(await repo.getTimingStats({ minSamples: 2 })).toEqual([]);
    expect(await repo.getTimingStats({ targetSdk: 0 })).toEqual([]);
    for (const orderBy of ["sampleSize", "lastRun"] as const) {
      expect((await repo.getTimingStats({ orderBy }))[0].failedCount).toBe(1);
    }
  });

  test.each([false, true])("ANR optional values and unified failures %j", async (full) => {
    const repo = new FailureEventRepository(timer, db);
    const id = await repo.saveAnr({
      deviceId: "device",
      packageName: "app",
      timestamp: 3000,
      detectionSource: "sdk_websocket",
      ...(full
        ? {
            processName: "process",
            pid: 0,
            reason: "",
            activity: "A",
            waitDurationMs: 0,
            cpuUsage: "10%",
            mainThreadState: "waiting",
            stacktrace: "stack",
            rawLog: "raw",
            sessionUuid: "session",
          }
        : {}),
    });
    expect(await repo.getAnrById(id)).toMatchObject({
      pid: full ? 0 : null,
      reason: full ? "" : null,
    });
    await repo.saveCrash({
      deviceId: "device",
      packageName: "app",
      timestamp: 2000,
      crashType: "java",
      detectionSource: "sdk_websocket",
    });
    await repo.saveToolCall("tapOn", {
      status: "failure",
      errorMessage: "bad",
      errorType: "tap",
      toolArgs: "{}",
    });
    expect((await repo.getAllFailures()).map((r) => r.type)).toEqual([
      "tool_call_failure",
      "anr",
      "crash",
    ]);
    expect(
      (await repo.getAllFailures({ includeToolCallFailures: false, limit: 1 }))[0],
    ).toMatchObject({
      type: "anr",
      reason: full ? "" : undefined,
      waitDurationMs: full ? 0 : undefined,
    });
  });

  test("failure occurrence defaults, optional metadata, merge and notification cursors", async () => {
    const barrier = new FakeDbWriteBarrier();
    barrier.beginDrain();
    const repo = new FailureAnalyticsRepository(
      timer,
      db,
      () => barrier,
      new FakeIdGenerator(["o1", "g1", "o2", "g2", "capture"]),
    );
    const base: RecordFailureInput = {
      type: "tool_failure",
      signature: "sig",
      title: "title",
      message: "message",
      severity: "critical",
      occurrence: { deviceModel: "Pixel", os: "Android", appVersion: "1", sessionId: "s1" },
      toolCallInfo: {
        toolName: "tapOn",
        errorCodes: { one: 1 },
        parameterVariants: {},
        durationStats: null,
      },
    };
    await repo.recordFailure(base);
    await repo.recordFailure({
      ...base,
      occurrence: {
        ...base.occurrence,
        deviceId: "device",
        sessionId: "s2",
        screenAtFailure: "Home",
        testName: "test",
        durationMs: 0,
        errorCode: "two",
        toolArgs: {},
        screensVisited: ["Home", "Next"],
      },
      capture: { type: "screenshot", path: "capture.png" },
    });
    expect(
      await db.selectFrom("failure_groups").select(["total_count", "unique_sessions"]).execute(),
    ).toEqual([{ total_count: 2, unique_sessions: 2 }]);
    expect(
      await db
        .selectFrom("failure_occurrence_screens")
        .select("screen_name")
        .orderBy("visit_order")
        .execute(),
    ).toEqual([{ screen_name: "Home" }, { screen_name: "Next" }]);
    const first = await repo.getNotificationsSince({
      type: "tool_failure",
      acknowledged: false,
      startTime: 1,
      endTime: 1_000_000,
      limit: 1,
    });
    expect(first.notifications).toHaveLength(1);
    const second = await repo.getNotificationsSince({
      sinceTimestamp: first.lastTimestamp,
      sinceId: first.lastId,
    });
    expect(second.notifications).toHaveLength(1);
    await repo.acknowledgeNotifications([second.lastId!]);
    expect(
      (await repo.getNotificationsSince({ acknowledged: true })).notifications[0].acknowledged,
    ).toBe(true);
    expect(
      await repo.getNotificationsSince({
        sinceTimestamp: second.lastTimestamp,
        sinceId: second.lastId,
      }),
    ).toMatchObject({
      notifications: [],
      lastTimestamp: second.lastTimestamp,
      lastId: second.lastId,
    });
  });
});

describe("structural SQLite characterization", () => {
  test("retries an injected busy error before the query, preserving the cause on exhaustion", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const raw = new BunDatabase(":memory:");
    const busy = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    let calls = 0;
    const state = new BunSqliteConnectionState(
      raw,
      async () => {
        if (++calls === 1) {
          throw busy;
        }
      },
      {
        timer,
        maxAttempts: 2,
        random: { next: () => 0, pick: <T>(items: readonly T[]) => items[0]! },
      },
    );
    expect(await state.executeQuery(CompiledQuery.raw("select 1 as v"), Symbol())).toMatchObject({
      rows: [{ v: 1 }],
    });
    expect(calls).toBe(2);
    state.close();
    const failing = new BunSqliteConnectionState(
      new BunDatabase(":memory:"),
      async () => {
        throw busy;
      },
      { timer, maxAttempts: 1 },
    );
    try {
      await expect(
        failing.executeQuery(CompiledQuery.raw("select 1"), Symbol()),
      ).rejects.toMatchObject({ cause: busy });
    } finally {
      failing.close();
    }
  });

  test.each([0, 10])(
    "DDL, RETURNING, rollback, errors and optimize interval %i",
    async (interval) => {
      const timer = new FakeTimer();
      const raw = new BunDatabase(":memory:");
      const state = new BunSqliteConnectionState(
        () => raw,
        undefined,
        { timer, maxAttempts: 1 },
        interval,
      );
      const owner = Symbol("owner");
      await state.executeQuery(
        CompiledQuery.raw("create table items (id integer primary key, value text)"),
        owner,
      );
      expect(
        await state.executeQuery(
          CompiledQuery.raw("insert into items(value) values ('a') returning id"),
          owner,
        ),
      ).toMatchObject({ rows: [{ id: 1 }], numAffectedRows: 1n });
      await state.beginTransaction(owner);
      await state.executeQuery(CompiledQuery.raw("update items set value = 'b'"), owner);
      await state.rollbackTransaction(owner);
      expect(
        await state.executeQuery(CompiledQuery.raw("select value from items"), owner),
      ).toMatchObject({ rows: [{ value: "a" }] });
      await expect(
        state.executeQuery(CompiledQuery.raw("select * from missing"), owner),
      ).rejects.toThrow("Query failed:");
      state.close();
      await expect(state.executeQuery(CompiledQuery.raw("select 1"), owner)).rejects.toThrow(
        "Cannot use a closed database",
      );
    },
  );

  // Snapshot keys are the test title plus a per-title counter, so each migration
  // needs its own title or the keys swap when the order is randomized.
  test.each([
    ["navigation", navigationUp],
    ["failures", failuresUp],
  ] as const)("migration schema before, after and repeated up (%s)", async (_label, up) => {
    const raw = new BunDatabase(":memory:");
    const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: raw }) });
    try {
      const catalog = () =>
        sql`select type, name, tbl_name, sql from sqlite_master order by rowid`.execute(db);
      expect((await catalog()).rows).toMatchSnapshot();
      await up(db);
      expect((await catalog()).rows).toMatchSnapshot();
      const tables = await sql<{
        name: string;
      }>`select name from sqlite_master where type = 'table' order by rowid`.execute(db);
      const columns = [];
      for (const { name } of tables.rows) {
        columns.push({
          name,
          rows: (await sql`pragma table_info(${sql.lit(name)})`.execute(db)).rows,
        });
      }
      expect(columns).toMatchSnapshot();
      await up(db);
      expect((await catalog()).rows).toMatchSnapshot();
    } finally {
      await db.destroy();
    }
  });
});
