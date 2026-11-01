import { afterEach, beforeEach, expect, test } from "bun:test";
import { PredictionHistoryRepository } from "../../src/db/predictionHistoryRepository";
import { SqliteFeatureFlagRepository } from "../../src/db/featureFlagRepository";
import { SqliteSessionToolSelectionRepository } from "../../src/db/sessionToolSelectionRepository";
import { nowIso } from "../../src/db/nowIso";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await db.destroy();
});

test("nowIso renders the injected timer's clock", () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.UTC(2026, 0, 2, 3, 4, 5));
  expect(nowIso(timer)).toBe("2026-01-02T03:04:05.000Z");
});

test("PredictionHistoryRepository stamps rows from the injected timer", async () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.UTC(2026, 5, 7, 8, 9, 10));
  const repo = new PredictionHistoryRepository({ db, timer });
  await repo.recordOutcome({
    appId: "com.example",
    predictionId: "p1",
    timestamp: 1,
    fromScreen: "A",
    predictedScreen: "B",
    actualScreen: "B",
    toolName: "tapOn",
    predictedElements: [],
    foundElements: [],
    confidence: 0.5,
    matchScore: 1,
    correct: true,
    partialMatch: false,
  });
  const row = await db
    .selectFrom("prediction_outcomes")
    .select("created_at")
    .executeTakeFirstOrThrow();
  expect(row.created_at).toBe("2026-06-07T08:09:10.000Z");
});

test("SqliteFeatureFlagRepository stamps ensureFlags and upsertFlag from the injected timer", async () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.UTC(2026, 1, 3, 4, 5, 6));
  const repo = new SqliteFeatureFlagRepository({ db, timer });
  await repo.ensureFlags([
    {
      key: "accessibility-audit",
      label: "A",
      description: "d",
      defaultValue: true,
      defaultConfig: undefined,
    },
  ]);
  expect((await repo.listFlags())[0]?.updatedAt).toBe("2026-02-03T04:05:06.000Z");

  timer.setCurrentTime(Date.UTC(2026, 1, 4, 0, 0, 0));
  await repo.upsertFlag("accessibility-audit", false);
  expect((await repo.listFlags())[0]?.updatedAt).toBe("2026-02-04T00:00:00.000Z");
});

test("SqliteSessionToolSelectionRepository stamps set and setMany conflict updates from the injected timer", async () => {
  const timer = new FakeTimer();
  const repo = new SqliteSessionToolSelectionRepository({ resolveDatabase: () => db, timer });
  const stamp = async (): Promise<string | undefined> =>
    (
      await db
        .selectFrom("session_tool_overrides")
        .select("updated_at")
        .where("tool_name", "=", "sendKeys")
        .executeTakeFirst()
    )?.updated_at;

  await repo.set("s1", "sendKeys", true);
  timer.setCurrentTime(Date.UTC(2026, 2, 3, 4, 5, 6));
  await repo.set("s1", "sendKeys", false);
  expect(await stamp()).toBe("2026-03-03T04:05:06.000Z");

  timer.setCurrentTime(Date.UTC(2026, 2, 4, 0, 0, 0));
  await repo.setMany("s1", [{ toolName: "sendKeys", enabled: true }]);
  expect(await stamp()).toBe("2026-03-04T00:00:00.000Z");
});
