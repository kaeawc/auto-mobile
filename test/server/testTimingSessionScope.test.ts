import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  TestExecutionRepository,
  type TestExecutionRecord,
} from "../../src/db/testExecutionRepository";
import { buildTestTimingResponse } from "../../src/server/testTimingData";

// #10091: the JUnit runner sent its own fresh per-JVM session UUID as the `sessionUuid` filter, but
// every recorded row carries the UUID of an earlier executePlan attempt, so the query could never
// match. The daemon keeps `sessionUuid` as an opt-in filter; the runner must simply not send it.

function execution(overrides: Partial<TestExecutionRecord> = {}): TestExecutionRecord {
  return {
    testClass: "com.app.login.SmokeTest",
    testMethod: "opensHome",
    durationMs: 1500,
    status: "passed",
    timestamp: 1_000_000,
    devicePlatform: "android",
    sessionUuid: "plan-attempt-a",
    ...overrides,
  };
}

describe("test timing sessionUuid scope (#10091)", () => {
  let db: Kysely<Database>;
  let repo: TestExecutionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    const timer = new FakeTimer();
    timer.setCurrentTime(2_000_000);
    repo = new TestExecutionRepository(timer, db);
    await repo.recordExecution(execution());
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("a query carrying a different session UUID returns no history", async () => {
    const response = await buildTestTimingResponse(
      { devicePlatform: "android", sessionUuid: "runner-jvm-session-b" },
      repo,
    );
    expect(response.testTimings).toEqual([]);
  });

  test("the same query without sessionUuid returns the earlier run's history", async () => {
    const response = await buildTestTimingResponse({ devicePlatform: "android" }, repo);
    expect(response.testTimings.map((entry) => entry.testMethod)).toEqual(["opensHome"]);
  });

  test("an explicit matching sessionUuid still filters, so the opt-in stays usable", async () => {
    const response = await buildTestTimingResponse(
      { devicePlatform: "android", sessionUuid: "plan-attempt-a" },
      repo,
    );
    expect(response.totalTests).toBe(1);
  });

  test("fully qualified class names keep same-named classes' history apart", async () => {
    await repo.recordExecution(
      execution({ testClass: "com.app.checkout.SmokeTest", durationMs: 9000 }),
    );

    const response = await buildTestTimingResponse({ devicePlatform: "android" }, repo);

    const byClass = Object.fromEntries(
      response.testTimings.map((entry) => [entry.testClass, entry.averageDurationMs]),
    );
    expect(byClass).toEqual({
      "com.app.login.SmokeTest": 1500,
      "com.app.checkout.SmokeTest": 9000,
    });
  });
});
