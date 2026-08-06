import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import type { Kysely } from "kysely";
import { Kysely as KyselyRuntime, sql } from "kysely";
import type { Database } from "../../src/db/types";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { SQLITE_MAX_BOUND_PARAMETERS } from "../../src/db/sqliteBatch";
import {
  TestExecutionRepository,
  type TestExecutionRecord,
  type TestStepRecord,
} from "../../src/db/testExecutionRepository";
import { runMigrations } from "../../src/db/migrator";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

function makeExecution(overrides: Partial<TestExecutionRecord> = {}): TestExecutionRecord {
  return {
    testClass: "com.example.LoginTest",
    testMethod: "testLoginSuccess",
    durationMs: 1500,
    status: "passed",
    timestamp: 1000000,
    ...overrides,
  };
}

function makeStep(overrides: Partial<TestStepRecord> = {}): TestStepRecord {
  return {
    stepIndex: 0,
    action: "tapOn",
    target: "login_button",
    status: "completed",
    durationMs: 200,
    ...overrides,
  };
}

describe("TestExecutionRepository", () => {
  let db: Kysely<Database>;
  let repo: TestExecutionRepository;
  let timer: FakeTimer;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    repo = new TestExecutionRepository(timer, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("recordExecution basic", () => {
    test("records a basic execution and returns an id", async () => {
      const id = await repo.recordExecution(makeExecution());
      expect(id).toBeGreaterThan(0);
    });

    test("records execution with all fields", async () => {
      const id = await repo.recordExecution(
        makeExecution({
          deviceId: "emulator-5554",
          deviceName: "Pixel_6",
          devicePlatform: "android",
          deviceType: "emulator",
          status: "failed",
          errorMessage: "AssertionError: expected true",
        })
      );

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(id);
      expect(runs[0].testClass).toBe("com.example.LoginTest");
      expect(runs[0].testMethod).toBe("testLoginSuccess");
      expect(runs[0].status).toBe("failed");
      expect(runs[0].durationMs).toBe(1500);
      expect(runs[0].deviceId).toBe("emulator-5554");
      expect(runs[0].deviceName).toBe("Pixel_6");
      expect(runs[0].platform).toBe("android");
      expect(runs[0].errorMessage).toBe("AssertionError: expected true");
    });

    test("records execution with skipped status", async () => {
      await repo.recordExecution(makeExecution({ status: "skipped" }));

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("skipped");
    });
  });

  describe("recordExecution with steps", () => {
    test("records steps alongside the execution", async () => {
      const steps: TestStepRecord[] = [
        makeStep({ stepIndex: 0, action: "tapOn", target: "username_field", durationMs: 100 }),
        makeStep({ stepIndex: 1, action: "inputText", target: "user@test.com", durationMs: 50 }),
        makeStep({ stepIndex: 2, action: "tapOn", target: "submit_button", durationMs: 150 }),
      ];

      await repo.recordExecution(makeExecution({ steps }));

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].steps).toHaveLength(3);
      expect(runs[0].steps[0].action).toBe("tapOn");
      expect(runs[0].steps[0].target).toBe("username_field");
      expect(runs[0].steps[0].stepIndex).toBe(0);
      expect(runs[0].steps[1].action).toBe("inputText");
      expect(runs[0].steps[1].stepIndex).toBe(1);
      expect(runs[0].steps[2].action).toBe("tapOn");
      expect(runs[0].steps[2].stepIndex).toBe(2);
    });

    test("records steps with failed status and error message", async () => {
      const steps: TestStepRecord[] = [
        makeStep({ stepIndex: 0, action: "tapOn", status: "completed", durationMs: 100 }),
        makeStep({
          stepIndex: 1,
          action: "inputText",
          status: "failed",
          durationMs: 50,
          errorMessage: "Element not visible",
        }),
      ];

      await repo.recordExecution(makeExecution({ steps }));

      const runs = await repo.getTestRuns();
      expect(runs[0].steps[1].status).toBe("failed");
      expect(runs[0].steps[1].errorMessage).toBe("Element not visible");
    });

    test("roundtrips step details through getTestRuns", async () => {
      await repo.recordExecution(
        makeExecution({
          steps: [
            makeStep({
              status: "skipped",
              details: {
                device: "device-a",
                trackIndex: 0,
                optional: true,
                error: "element not found",
              },
            }),
          ],
        })
      );

      const runs = await repo.getTestRuns();

      expect((runs[0].steps[0] as any).details).toEqual({
        device: "device-a",
        trackIndex: 0,
        optional: true,
        error: "element not found",
      });
    });

    test("records execution with screens visited", async () => {
      await repo.recordExecution(
        makeExecution({
          screensVisited: [
            { screenName: "LoginScreen", timestamp: 1000 },
            { screenName: "HomeScreen", timestamp: 2000 },
          ],
        })
      );

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].screensVisited).toEqual(["LoginScreen", "HomeScreen"]);
    });

    test("records execution with no steps yields empty steps array", async () => {
      await repo.recordExecution(makeExecution());

      const runs = await repo.getTestRuns();
      expect(runs[0].steps).toEqual([]);
      expect(runs[0].screensVisited).toEqual([]);
    });

    test("rolls back the execution row when inserting steps fails", async () => {
      await sql`
        CREATE TEMP TRIGGER fail_test_execution_steps_insert
        BEFORE INSERT ON test_execution_steps
        BEGIN
          SELECT RAISE(ABORT, 'injected step insert failure');
        END
      `.execute(db);

      await expect(
        repo.recordExecution(makeExecution({ steps: [makeStep()] }))
      ).rejects.toThrow("injected step insert failure");

      const row = await db
        .selectFrom("test_executions")
        .select(db.fn.count<number>("id").as("count"))
        .executeTakeFirstOrThrow();
      expect(Number(row.count)).toBe(0);
    });

    test("rolls back execution and steps when inserting screens fails", async () => {
      await sql`
        CREATE TEMP TRIGGER fail_test_execution_screens_insert
        BEFORE INSERT ON test_execution_screens
        BEGIN
          SELECT RAISE(ABORT, 'injected screen insert failure');
        END
      `.execute(db);

      await expect(
        repo.recordExecution(
          makeExecution({
            steps: [makeStep()],
            screensVisited: [{ screenName: "LoginScreen", timestamp: 1000 }],
          })
        )
      ).rejects.toThrow("injected screen insert failure");

      const executionRow = await db
        .selectFrom("test_executions")
        .select(db.fn.count<number>("id").as("count"))
        .executeTakeFirstOrThrow();
      const stepRow = await db
        .selectFrom("test_execution_steps")
        .select(db.fn.count<number>("id").as("count"))
        .executeTakeFirstOrThrow();
      expect(Number(executionRow.count)).toBe(0);
      expect(Number(stepRow.count)).toBe(0);
    });

    test("runs on an enclosing transaction executor without opening a nested transaction", async () => {
      let executionId = 0;

      await db.transaction().execute(async trx => {
        const boundRepo = new TestExecutionRepository(timer, trx);
        executionId = await boundRepo.recordExecution(
          makeExecution({
            steps: [makeStep()],
            screensVisited: [{ screenName: "LoginScreen", timestamp: 1000 }],
          })
        );
      });

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(executionId);
      expect(runs[0].steps).toHaveLength(1);
      expect(runs[0].screensVisited).toEqual(["LoginScreen"]);
    });
  });

  describe("getTestRuns basic", () => {
    test("returns empty array when no executions exist", async () => {
      const runs = await repo.getTestRuns();
      expect(runs).toEqual([]);
    });

    test("returns multiple runs ordered by timestamp desc by default", async () => {
      await repo.recordExecution(makeExecution({ timestamp: 1000 }));
      await repo.recordExecution(makeExecution({ timestamp: 3000 }));
      await repo.recordExecution(makeExecution({ timestamp: 2000 }));

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(3);
      expect(runs[0].startTime).toBe(3000);
      expect(runs[1].startTime).toBe(2000);
      expect(runs[2].startTime).toBe(1000);
    });

    test("returns runs ordered ascending when specified", async () => {
      await repo.recordExecution(makeExecution({ timestamp: 1000 }));
      await repo.recordExecution(makeExecution({ timestamp: 3000 }));
      await repo.recordExecution(makeExecution({ timestamp: 2000 }));

      const runs = await repo.getTestRuns({ orderDirection: "asc" });
      expect(runs).toHaveLength(3);
      expect(runs[0].startTime).toBe(1000);
      expect(runs[1].startTime).toBe(2000);
      expect(runs[2].startTime).toBe(3000);
    });

    test("fetches executions, steps, and screens with exactly three queries", async () => {
      const instrumented = await createInstrumentedTestDatabase();
      const instrumentedRepo = new TestExecutionRepository(timer, instrumented.db);
      try {
        for (let i = 0; i < 5; i++) {
          await instrumentedRepo.recordExecution(
            makeExecution({
              testClass: `Class${i}`,
              testMethod: `method${i}`,
              timestamp: 1000 + i,
              steps: [
                makeStep({ stepIndex: 0, action: "tapOn", target: `button-${i}` }),
                makeStep({ stepIndex: 1, action: "inputText", target: `field-${i}` }),
              ],
              screensVisited: [
                { screenName: `Screen${i}A`, timestamp: 1000 + i },
                { screenName: `Screen${i}B`, timestamp: 2000 + i },
              ],
            })
          );
        }

        instrumented.resetQueryCount();
        const runs = await instrumentedRepo.getTestRuns({ limit: 5 });

        expect(runs).toHaveLength(5);
        expect(runs[0].steps.map(step => step.stepIndex)).toEqual([0, 1]);
        expect(runs[0].screensVisited).toEqual(["Screen4A", "Screen4B"]);
        expect(instrumented.queryCount()).toBe(3);
      } finally {
        await instrumented.db.destroy();
      }
    });

    test("chunks more than SQLite's conservative bound-parameter limit without mixing steps or screens", async () => {
      const instrumented = await createInstrumentedTestDatabase();
      const instrumentedRepo = new TestExecutionRepository(timer, instrumented.db);
      const executionCount = SQLITE_MAX_BOUND_PARAMETERS + 6;
      try {
        await seedTestExecutions(instrumented.db, executionCount);

        instrumented.resetQueryCount();
        const runs = await instrumentedRepo.getTestRuns({ limit: executionCount });

        expect(runs).toHaveLength(executionCount);
        expect(instrumented.queryCount()).toBe(1 + 2 * Math.ceil(executionCount / SQLITE_MAX_BOUND_PARAMETERS));
        for (const id of [SQLITE_MAX_BOUND_PARAMETERS - 1, SQLITE_MAX_BOUND_PARAMETERS, SQLITE_MAX_BOUND_PARAMETERS + 1]) {
          const run = runs.find(item => item.id === id);
          expect(run?.steps).toHaveLength(1);
          expect(run?.steps[0]).toMatchObject({
            action: `action-${id}`,
            target: `target-${id}`,
          });
          expect(run?.screensVisited).toEqual([`Screen ${id}`]);
        }
      } finally {
        await instrumented.db.destroy();
      }
    });
  });

  describe("getTestRuns with filters", () => {
    test("filters by testClass", async () => {
      await repo.recordExecution(makeExecution({ testClass: "LoginTest" }));
      await repo.recordExecution(makeExecution({ testClass: "HomeTest" }));

      const runs = await repo.getTestRuns({ testClass: "LoginTest" });
      expect(runs).toHaveLength(1);
      expect(runs[0].testClass).toBe("LoginTest");
    });

    test("filters by testMethod", async () => {
      await repo.recordExecution(makeExecution({ testMethod: "testLogin" }));
      await repo.recordExecution(makeExecution({ testMethod: "testLogout" }));

      const runs = await repo.getTestRuns({ testMethod: "testLogin" });
      expect(runs).toHaveLength(1);
      expect(runs[0].testMethod).toBe("testLogin");
    });

    test("respects limit", async () => {
      await repo.recordExecution(makeExecution({ timestamp: 1000 }));
      await repo.recordExecution(makeExecution({ timestamp: 2000 }));
      await repo.recordExecution(makeExecution({ timestamp: 3000 }));

      const runs = await repo.getTestRuns({ limit: 2 });
      expect(runs).toHaveLength(2);
      expect(runs[0].startTime).toBe(3000);
      expect(runs[1].startTime).toBe(2000);
    });

    test("combines testClass and testMethod filters", async () => {
      await repo.recordExecution(makeExecution({ testClass: "LoginTest", testMethod: "testLogin" }));
      await repo.recordExecution(makeExecution({ testClass: "LoginTest", testMethod: "testLogout" }));
      await repo.recordExecution(makeExecution({ testClass: "HomeTest", testMethod: "testLogin" }));

      const runs = await repo.getTestRuns({ testClass: "LoginTest", testMethod: "testLogin" });
      expect(runs).toHaveLength(1);
      expect(runs[0].testClass).toBe("LoginTest");
      expect(runs[0].testMethod).toBe("testLogin");
    });

    test("filters by deviceId", async () => {
      await repo.recordExecution(makeExecution({ deviceId: "device-a" }));
      await repo.recordExecution(makeExecution({ deviceId: "device-b" }));

      const runs = await repo.getTestRuns({ deviceId: "device-a" });
      expect(runs).toHaveLength(1);
      expect(runs[0].deviceId).toBe("device-a");
    });

    test("returns runs across all devices when deviceId is omitted", async () => {
      await repo.recordExecution(makeExecution({ deviceId: "device-a" }));
      await repo.recordExecution(makeExecution({ deviceId: "device-b" }));

      const runs = await repo.getTestRuns();
      expect(runs).toHaveLength(2);
    });
  });

  describe("getTestRuns with lookbackDays", () => {
    test("filters by lookbackDays using FakeTimer", async () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      timer.setCurrentTime(10 * oneDayMs);

      // Record at day 2 (old) and day 9 (recent)
      await repo.recordExecution(makeExecution({ timestamp: 2 * oneDayMs }));
      await repo.recordExecution(makeExecution({ timestamp: 9 * oneDayMs }));

      // Lookback 3 days from day 10 = cutoff at day 7
      const runs = await repo.getTestRuns({ lookbackDays: 3 });
      expect(runs).toHaveLength(1);
      expect(runs[0].startTime).toBe(9 * oneDayMs);
    });

    test("returns all runs when lookbackDays covers entire range", async () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      timer.setCurrentTime(5 * oneDayMs);

      await repo.recordExecution(makeExecution({ timestamp: 1 * oneDayMs }));
      await repo.recordExecution(makeExecution({ timestamp: 4 * oneDayMs }));

      const runs = await repo.getTestRuns({ lookbackDays: 30 });
      expect(runs).toHaveLength(2);
    });

    test("returns no runs when lookbackDays excludes all", async () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      timer.setCurrentTime(100 * oneDayMs);

      await repo.recordExecution(makeExecution({ timestamp: 1 * oneDayMs }));

      const runs = await repo.getTestRuns({ lookbackDays: 1 });
      expect(runs).toHaveLength(0);
    });
  });

  describe("getTimingStats basic", () => {
    test("returns timing stats grouped by test class and method", async () => {
      await repo.recordExecution(
        makeExecution({
          testClass: "LoginTest",
          testMethod: "testLogin",
          durationMs: 1000,
          status: "passed",
          timestamp: 5000,
        })
      );
      await repo.recordExecution(
        makeExecution({
          testClass: "LoginTest",
          testMethod: "testLogin",
          durationMs: 2000,
          status: "passed",
          timestamp: 6000,
        })
      );

      const stats = await repo.getTimingStats({});
      expect(stats).toHaveLength(1);
      expect(stats[0].testClass).toBe("LoginTest");
      expect(stats[0].testMethod).toBe("testLogin");
      expect(stats[0].averageDurationMs).toBe(1500);
      expect(stats[0].sampleSize).toBe(2);
      expect(stats[0].lastRunTimestampMs).toBe(6000);
      expect(stats[0].passedCount).toBe(2);
      expect(stats[0].failedCount).toBe(0);
      expect(stats[0].skippedCount).toBe(0);
    });

    test("computes counts for different statuses", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", status: "passed", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", status: "failed", durationMs: 200, timestamp: 2000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", status: "skipped", durationMs: 50, timestamp: 3000 })
      );

      const stats = await repo.getTimingStats({});
      expect(stats).toHaveLength(1);
      expect(stats[0].sampleSize).toBe(3);
      expect(stats[0].passedCount).toBe(1);
      expect(stats[0].failedCount).toBe(1);
      expect(stats[0].skippedCount).toBe(1);
    });

    test("groups different test methods separately", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "LoginTest", testMethod: "testLogin", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "LoginTest", testMethod: "testLogout", durationMs: 200, timestamp: 2000 })
      );

      const stats = await repo.getTimingStats({});
      expect(stats).toHaveLength(2);

      const loginStats = stats.find(s => s.testMethod === "testLogin");
      const logoutStats = stats.find(s => s.testMethod === "testLogout");
      expect(loginStats).toBeDefined();
      expect(logoutStats).toBeDefined();
      expect(loginStats!.averageDurationMs).toBe(100);
      expect(logoutStats!.averageDurationMs).toBe(200);
    });

    test("returns empty array when no executions exist", async () => {
      const stats = await repo.getTimingStats({});
      expect(stats).toEqual([]);
    });

    test("computes standard deviation", async () => {
      // Values: 100, 200, 300 => avg=200, variance = ((100-200)^2 + (200-200)^2 + (300-200)^2)/3 = 20000/3
      // stdDev = sqrt(6666.67) ~= 81.65 -> rounded to 82
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", durationMs: 200, timestamp: 2000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", durationMs: 300, timestamp: 3000 })
      );

      const stats = await repo.getTimingStats({});
      expect(stats).toHaveLength(1);
      expect(stats[0].averageDurationMs).toBe(200);
      // stdDev should be approximately 82 (population stddev of 100,200,300)
      expect(stats[0].stdDevDurationMs).toBeGreaterThanOrEqual(80);
      expect(stats[0].stdDevDurationMs).toBeLessThanOrEqual(84);
    });
  });

  describe("getTimingStats with filters", () => {
    test("filters by testClass", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "LoginTest", testMethod: "testLogin", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "HomeTest", testMethod: "testHome", durationMs: 200, timestamp: 2000 })
      );

      const stats = await repo.getTimingStats({ testClass: "LoginTest" });
      expect(stats).toHaveLength(1);
      expect(stats[0].testClass).toBe("LoginTest");
    });

    test("filters by testMethod", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "testA", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "testB", durationMs: 200, timestamp: 2000 })
      );

      const stats = await repo.getTimingStats({ testMethod: "testA" });
      expect(stats).toHaveLength(1);
      expect(stats[0].testMethod).toBe("testA");
    });

    test("filters by lookbackDays using FakeTimer", async () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      timer.setCurrentTime(10 * oneDayMs);

      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", durationMs: 100, timestamp: 2 * oneDayMs })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", durationMs: 200, timestamp: 9 * oneDayMs })
      );

      // Lookback 3 days from day 10 = cutoff at day 7, only the day-9 execution is included
      const stats = await repo.getTimingStats({ lookbackDays: 3 });
      expect(stats).toHaveLength(1);
      expect(stats[0].sampleSize).toBe(1);
      expect(stats[0].averageDurationMs).toBe(200);
    });

    test("filters by deviceId", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", deviceId: "d-1", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "T", testMethod: "m", deviceId: "d-2", durationMs: 200, timestamp: 2000 })
      );

      const stats = await repo.getTimingStats({ deviceId: "d-1" });
      expect(stats).toHaveLength(1);
      expect(stats[0].averageDurationMs).toBe(100);
    });

    test("respects limit", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "A", testMethod: "m1", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "B", testMethod: "m2", durationMs: 200, timestamp: 2000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "C", testMethod: "m3", durationMs: 300, timestamp: 3000 })
      );

      const stats = await repo.getTimingStats({ limit: 2 });
      expect(stats).toHaveLength(2);
    });

    test("respects minSamples filter", async () => {
      await repo.recordExecution(
        makeExecution({ testClass: "A", testMethod: "m1", durationMs: 100, timestamp: 1000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "B", testMethod: "m2", durationMs: 200, timestamp: 2000 })
      );
      await repo.recordExecution(
        makeExecution({ testClass: "B", testMethod: "m2", durationMs: 250, timestamp: 3000 })
      );

      const stats = await repo.getTimingStats({ minSamples: 2 });
      expect(stats).toHaveLength(1);
      expect(stats[0].testClass).toBe("B");
      expect(stats[0].sampleSize).toBe(2);
    });
  });
});

async function createInstrumentedTestDatabase(): Promise<{
  db: Kysely<Database>;
  queryCount: () => number;
  resetQueryCount: () => void;
}> {
  const bunDb = new BunDatabase(":memory:");
  let count = 0;
  const db = new KyselyRuntime<Database>({
    dialect: new BunSqliteDialect({
      database: bunDb,
      beforeQuery: async () => {
        count++;
      },
    }),
  });
  await runMigrations(db as Kysely<unknown>);
  return {
    db,
    queryCount: () => count,
    resetQueryCount: () => {
      count = 0;
    },
  };
}

async function seedTestExecutions(db: Kysely<Database>, count: number): Promise<void> {
  const ids = Array.from({ length: count }, (_unused, index) => index + 1);
  for (const chunk of chunkArray(ids, 200)) {
    await db
      .insertInto("test_executions")
      .values(chunk.map(id => ({
        id,
        test_class: `Class${id}`,
        test_method: `method${id}`,
        duration_ms: id,
        status: "passed" as const,
        timestamp: id,
        device_id: null,
        device_name: null,
        device_platform: "android" as const,
        device_type: "emulator" as const,
        app_version: null,
        git_commit: null,
        target_sdk: null,
        jdk_version: null,
        jvm_target: null,
        gradle_version: null,
        is_ci: null,
        session_uuid: null,
        error_message: null,
        video_path: null,
        snapshot_path: null,
      })))
      .execute();

    await db
      .insertInto("test_execution_steps")
      .values(chunk.map(id => ({
        id,
        execution_id: id,
        step_index: 0,
        action: `action-${id}`,
        target: `target-${id}`,
        status: "completed" as const,
        duration_ms: id,
        screen_name: `Screen ${id}`,
        screenshot_path: null,
        error_message: null,
        details_json: null,
      })))
      .execute();

    await db
      .insertInto("test_execution_screens")
      .values(chunk.map(id => ({
        id,
        execution_id: id,
        screen_name: `Screen ${id}`,
        visit_order: 0,
        timestamp: id,
      })))
      .execute();
  }
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

describe("TestExecutionRepository retention (#3440)", () => {
  let db: Kysely<Database>;
  let repo: TestExecutionRepository;
  let timer: FakeTimer;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(10_000_000_000);
    repo = new TestExecutionRepository(timer, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("pruneToRowCap trims to exactly the cap, keeping the newest rows", async () => {
    const base = timer.now();
    for (let i = 1; i <= 12; i++) {
      await repo.recordExecution(makeExecution({ timestamp: base + i }));
    }

    await (repo as any).pruneToRowCap(5);

    const rows = await db
      .selectFrom("test_executions")
      .select("timestamp")
      .orderBy("timestamp", "asc")
      .execute();
    expect(rows.map(r => Number(r.timestamp))).toEqual([base + 8, base + 9, base + 10, base + 11, base + 12]);
  });

  test("pruneToRowCap under the cap deletes nothing (count(*) gate short-circuits)", async () => {
    const base = timer.now();
    for (let i = 1; i <= 3; i++) {
      await repo.recordExecution(makeExecution({ timestamp: base + i }));
    }

    await (repo as any).pruneToRowCap(10);

    const rows = await db.selectFrom("test_executions").selectAll().execute();
    expect(rows).toHaveLength(3);
  });

  test("cleanupRetention still runs the age-based delete on every insert", async () => {
    // A row older than the retention window must be pruned by the cheap,
    // sargable age-delete that fires on every insert, independent of the
    // amortized row-cap probe (#3440). Seed the stale row directly so it isn't
    // removed by the age-delete on its own insert.
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const stale = timer.now() - 200 * MS_PER_DAY;
    await db
      .insertInto("test_executions")
      .values({ test_class: "C", test_method: "m", duration_ms: 1, status: "passed", timestamp: stale })
      .execute();
    expect(await db.selectFrom("test_executions").selectAll().execute()).toHaveLength(1);

    // A fresh insert triggers cleanupRetention, whose age-delete removes the
    // stale row even though the row-cap probe is amortized away.
    const fresh = timer.now();
    await repo.recordExecution(makeExecution({ timestamp: fresh }));

    const rows = await db.selectFrom("test_executions").select("timestamp").execute();
    expect(rows.map(r => Number(r.timestamp))).toEqual([fresh]);
  });
});
