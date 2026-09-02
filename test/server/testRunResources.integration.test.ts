import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  convertToResponseEntry,
  buildTestRunResponse,
  parseTestRunParams,
  buildTestRunUri,
} from "../../src/server/testRunResources";
import { TestExecutionRepository, type TestRun } from "../../src/db/testExecutionRepository";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type {
  Database as DatabaseSchema,
  NewTestExecution,
  NewTestExecutionStep,
  NewTestExecutionScreen,
} from "../../src/db/types";
import { runMigrations } from "../../src/db/migrator";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

describe("testRunResources", () => {
  test("exposes step details in test run resource entries", () => {
    const entry = convertToResponseEntry(
      {
        id: 1,
        testClass: "com.example.LoginTest",
        testMethod: "testLogin",
        status: "passed",
        startTime: 1000,
        durationMs: 500,
        deviceId: "sim-1",
        deviceName: "iPhone",
        platform: "ios",
        errorMessage: null,
        videoPath: null,
        snapshotPath: null,
        screensVisited: [],
        steps: [
          {
            id: 10,
            stepIndex: 0,
            action: "tapOn",
            target: 'text="Not Now"',
            status: "skipped",
            durationMs: 250,
            screenName: null,
            screenshotPath: null,
            errorMessage: "element not found",
            details: {
              device: "device-a",
              trackIndex: 0,
              optional: true,
            },
          },
        ],
      } as TestRun,
      1,
    );

    expect(entry.steps[0].details).toEqual({
      device: "device-a",
      trackIndex: 0,
      optional: true,
    });
  });
});

describe("testRunResources deviceId scoping", () => {
  let db: Kysely<DatabaseSchema>;
  let repo: TestExecutionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new TestExecutionRepository(new FakeTimer(), db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("buildTestRunResponse filters runs to the requested deviceId", async () => {
    await repo.recordExecution({
      testClass: "com.example.LoginTest",
      testMethod: "testLogin",
      durationMs: 100,
      status: "passed",
      timestamp: 1000,
      deviceId: "device-a",
    });
    await repo.recordExecution({
      testClass: "com.example.HomeTest",
      testMethod: "testHome",
      durationMs: 100,
      status: "passed",
      timestamp: 2000,
      deviceId: "device-b",
    });

    const response = await buildTestRunResponse({ deviceId: "device-a" }, repo);

    expect(response.testRuns).toHaveLength(1);
    expect(response.testRuns[0].deviceId).toBe("device-a");
    expect(response.filters.deviceId).toBe("device-a");
  });

  test("buildTestRunResponse returns all devices when deviceId is omitted", async () => {
    await repo.recordExecution({
      testClass: "com.example.LoginTest",
      testMethod: "testLogin",
      durationMs: 100,
      status: "passed",
      timestamp: 1000,
      deviceId: "device-a",
    });
    await repo.recordExecution({
      testClass: "com.example.HomeTest",
      testMethod: "testHome",
      durationMs: 100,
      status: "passed",
      timestamp: 2000,
      deviceId: "device-b",
    });

    const response = await buildTestRunResponse({}, repo);

    expect(response.testRuns).toHaveLength(2);
    expect(response.filters.deviceId).toBeUndefined();
  });

  test("parseTestRunParams accepts deviceId and buildTestRunUri round-trips it", () => {
    const args = parseTestRunParams({ deviceId: "emulator-5554" });
    expect(args.deviceId).toBe("emulator-5554");
    expect(buildTestRunUri(args)).toContain("deviceId=emulator-5554");
  });
});

describe("TestRunResources - Database Schema", () => {
  let db: Kysely<DatabaseSchema>;

  beforeAll(async () => {
    const sqliteDb = new BunDatabase(":memory:");
    // Enable foreign key constraints for cascade delete
    sqliteDb.exec("PRAGMA foreign_keys = ON;");

    db = new Kysely<DatabaseSchema>({
      dialect: new BunSqliteDialect({
        database: sqliteDb,
      }),
    });
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Clear test data in correct order for foreign key constraints
    await db
      .deleteFrom("test_execution_screens")
      .execute()
      .catch(() => {});
    await db
      .deleteFrom("test_execution_steps")
      .execute()
      .catch(() => {});
    await db
      .deleteFrom("test_executions")
      .execute()
      .catch(() => {});
  });

  describe("test_executions table", () => {
    test("supports new columns: error_message, video_path, snapshot_path", async () => {
      const entry: NewTestExecution = {
        test_class: "com.example.TestClass",
        test_method: "testMethod",
        duration_ms: 1500,
        status: "failed",
        timestamp: Date.now(),
        device_id: "emulator-5554",
        device_name: "Pixel 6",
        device_platform: "android",
        device_type: "emulator",
        error_message: "Element not found",
        video_path: "/path/to/video.mp4",
        snapshot_path: "/path/to/snapshot.png",
      };

      const result = await db.insertInto("test_executions").values(entry).executeTakeFirst();
      expect(Number(result.insertId)).toBeGreaterThan(0);

      const rows = await db
        .selectFrom("test_executions")
        .select(["id", "error_message", "video_path", "snapshot_path"])
        .where("id", "=", Number(result.insertId))
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].error_message).toBe("Element not found");
      expect(rows[0].video_path).toBe("/path/to/video.mp4");
      expect(rows[0].snapshot_path).toBe("/path/to/snapshot.png");
    });
  });

  describe("test_execution_steps table", () => {
    test("stores step data with foreign key to test_executions", async () => {
      // First create a test execution
      const execResult = await db
        .insertInto("test_executions")
        .values({
          test_class: "com.example.TestClass",
          test_method: "testMethod",
          duration_ms: 1500,
          status: "passed",
          timestamp: Date.now(),
        })
        .executeTakeFirst();
      const executionId = Number(execResult.insertId);

      // Now create steps
      const steps: NewTestExecutionStep[] = [
        {
          execution_id: executionId,
          step_index: 0,
          action: "tapOn",
          target: 'text="Login"',
          status: "completed",
          duration_ms: 200,
          screen_name: "LoginScreen",
          screenshot_path: null,
          error_message: null,
          details_json: null,
        },
        {
          execution_id: executionId,
          step_index: 1,
          action: "inputText",
          target: 'id="username"',
          status: "completed",
          duration_ms: 300,
          screen_name: "LoginScreen",
          screenshot_path: null,
          error_message: null,
          details_json: JSON.stringify({ text: "testuser" }),
        },
      ];

      await db.insertInto("test_execution_steps").values(steps).execute();

      const storedSteps = await db
        .selectFrom("test_execution_steps")
        .select(["id", "step_index", "action", "target", "status", "duration_ms", "screen_name"])
        .where("execution_id", "=", executionId)
        .orderBy("step_index", "asc")
        .execute();

      expect(storedSteps).toHaveLength(2);
      expect(storedSteps[0].action).toBe("tapOn");
      expect(storedSteps[0].target).toBe('text="Login"');
      expect(storedSteps[0].screen_name).toBe("LoginScreen");
      expect(storedSteps[1].action).toBe("inputText");
    });

    test("cascades delete when test_execution is deleted", async () => {
      // Create a test execution with steps
      const execResult = await db
        .insertInto("test_executions")
        .values({
          test_class: "com.example.TestClass",
          test_method: "testCascade",
          duration_ms: 100,
          status: "passed",
          timestamp: Date.now(),
        })
        .executeTakeFirst();
      const executionId = Number(execResult.insertId);

      await db
        .insertInto("test_execution_steps")
        .values({
          execution_id: executionId,
          step_index: 0,
          action: "tapOn",
          status: "completed",
          duration_ms: 100,
        })
        .execute();

      // Verify step exists
      const stepsBefore = await db
        .selectFrom("test_execution_steps")
        .select("id")
        .where("execution_id", "=", executionId)
        .execute();
      expect(stepsBefore).toHaveLength(1);

      // Delete the execution
      await db.deleteFrom("test_executions").where("id", "=", executionId).execute();

      // Verify step was cascade deleted
      const stepsAfter = await db
        .selectFrom("test_execution_steps")
        .select("id")
        .where("execution_id", "=", executionId)
        .execute();
      expect(stepsAfter).toHaveLength(0);
    });
  });

  describe("test_execution_screens table", () => {
    test("stores screens visited with foreign key to test_executions", async () => {
      const execResult = await db
        .insertInto("test_executions")
        .values({
          test_class: "com.example.TestClass",
          test_method: "testScreens",
          duration_ms: 1500,
          status: "passed",
          timestamp: Date.now(),
        })
        .executeTakeFirst();
      const executionId = Number(execResult.insertId);

      const now = Date.now();
      const screens: NewTestExecutionScreen[] = [
        {
          execution_id: executionId,
          screen_name: "LoginScreen",
          visit_order: 0,
          timestamp: now - 1000,
        },
        {
          execution_id: executionId,
          screen_name: "HomeScreen",
          visit_order: 1,
          timestamp: now - 500,
        },
        { execution_id: executionId, screen_name: "ProfileScreen", visit_order: 2, timestamp: now },
      ];

      await db.insertInto("test_execution_screens").values(screens).execute();

      const storedScreens = await db
        .selectFrom("test_execution_screens")
        .select(["screen_name", "visit_order", "timestamp"])
        .where("execution_id", "=", executionId)
        .orderBy("visit_order", "asc")
        .execute();

      expect(storedScreens).toHaveLength(3);
      expect(storedScreens.map((s) => s.screen_name)).toEqual([
        "LoginScreen",
        "HomeScreen",
        "ProfileScreen",
      ]);
    });
  });
});
