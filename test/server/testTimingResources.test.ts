import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  TestExecutionRepository,
  type TestExecutionRecord,
} from "../../src/db/testExecutionRepository";
import { buildTestTimingResponse } from "../../src/server/testTimingData";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { registerTestTimingResources } from "../../src/server/testTimingResources";

function makeExecution(overrides: Partial<TestExecutionRecord> = {}): TestExecutionRecord {
  return {
    testClass: "com.example.LoginTest",
    testMethod: "testLoginSuccess",
    durationMs: 1500,
    status: "passed",
    timestamp: 1_000_000,
    ...overrides,
  };
}

describe("testTimingData", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: TestExecutionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(2_000_000);
    repo = new TestExecutionRepository(timer, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("buildTestTimingResponse", () => {
    test("returns aggregated timing stats for recorded executions", async () => {
      await repo.recordExecution(makeExecution());
      await repo.recordExecution(makeExecution({ durationMs: 2500, timestamp: 1_100_000 }));

      const response = await buildTestTimingResponse({}, repo);

      expect(response.totalTests).toBe(1);
      expect(response.totalSamples).toBe(2);
      expect(response.testTimings).toHaveLength(1);
      expect(response.testTimings[0].testClass).toBe("com.example.LoginTest");
      expect(response.testTimings[0].sampleSize).toBe(2);
      expect(response.testTimings[0].statusCounts.passed).toBe(2);
    });

    test("filters by testClass", async () => {
      await repo.recordExecution(makeExecution());
      await repo.recordExecution(makeExecution({ testClass: "com.example.SignupTest" }));

      const response = await buildTestTimingResponse({ testClass: "com.example.SignupTest" }, repo);

      expect(response.testTimings).toHaveLength(1);
      expect(response.testTimings[0].testClass).toBe("com.example.SignupTest");
      expect(response.filters.testClass).toBe("com.example.SignupTest");
    });

    test("returns empty results when no executions match", async () => {
      const response = await buildTestTimingResponse(
        { testClass: "com.example.Nonexistent" },
        repo,
      );

      expect(response.testTimings).toHaveLength(0);
      expect(response.totalTests).toBe(0);
      expect(response.totalSamples).toBe(0);
    });

    test("respects the limit option", async () => {
      await repo.recordExecution(makeExecution({ testMethod: "testA" }));
      await repo.recordExecution(makeExecution({ testMethod: "testB" }));

      const response = await buildTestTimingResponse({ limit: 1 }, repo);

      expect(response.testTimings).toHaveLength(1);
      expect(response.aggregation.limit).toBe(1);
    });
  });

  describe("resource registration", () => {
    afterEach(() => {
      ResourceRegistry.clearResources();
    });

    test("registers the base URI and a query-param template", () => {
      registerTestTimingResources();

      expect(ResourceRegistry.getResource("automobile:test-timings")).toBeDefined();

      const templates = ResourceRegistry.getAllTemplates();
      const queryTemplate = templates.find((t) =>
        t.uriTemplate.startsWith("automobile:test-timings?"),
      );
      expect(queryTemplate).toBeDefined();
    });
  });
});
