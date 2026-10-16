import { afterEach, beforeEach, expect, test } from "bun:test";
import { PredictionHistoryRepository } from "../../src/db/predictionHistoryRepository";
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
  const repo = new PredictionHistoryRepository(db, timer);
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
