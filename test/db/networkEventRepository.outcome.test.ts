import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import {
  getNetworkEvents,
  recordNetworkEvent,
  type RecordNetworkEventInput,
} from "../../src/db/networkEventRepository";
import { isFailedNetworkRequest } from "../../src/utils/networkRequestOutcome";
import { createTestDatabase } from "./testDbHelper";

let db: Kysely<Database>;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

test("errorsOnly mirrors the classifier and composes with explicit status filters", async () => {
  const outcomes = [
    { statusCode: 0, error: "timed out" },
    { statusCode: 0, error: null },
    { statusCode: 200, error: "cancelled" },
    { statusCode: 404, error: null },
    { statusCode: 500, error: null },
    { statusCode: 200, error: null },
    { statusCode: 301, error: null },
    { statusCode: 200, error: "" },
    { statusCode: 200, error: " \t\n\u00a0\ufeff" },
    { statusCode: -1, error: null },
    { statusCode: 200, error: "mocked:mock-1" },
    { statusCode: 201, error: " mocked:mock-1" },
    { statusCode: 503, error: "mocked:mock-1" },
    { statusCode: 200, error: "simulated:timeout" },
    { statusCode: 200, error: "Mocked:mock-1" },
  ];
  const expectedIds: number[] = [];
  for (const outcome of outcomes) {
    const input: RecordNetworkEventInput = {
      deviceId: null,
      timestamp: 1000,
      applicationId: null,
      sessionId: null,
      url: "https://api.example.com/data",
      method: "GET",
      durationMs: 100,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: "api.example.com",
      path: "/data",
      ...outcome,
    };
    const id = await recordNetworkEvent(input, db);
    if (isFailedNetworkRequest(outcome)) {
      expectedIds.push(id);
    }
  }
  const errors = await getNetworkEvents({ errorsOnly: true }, db);
  expect(errors.map((event) => event.id).sort((a, b) => a - b)).toEqual(expectedIds);
  expect(errors).toHaveLength(9);
  expect(errors.some((event) => event.statusCode === 200 && event.error === "mocked:mock-1")).toBe(
    false,
  );
  expect(
    (await getNetworkEvents({ errorsOnly: true, minStatusCode: 400 }, db))
      .map((event) => event.statusCode)
      .sort(),
  ).toEqual([404, 500, 503]);
  expect(
    (await getNetworkEvents({ errorsOnly: true, statusCode: "200" }, db))
      .map((event) => event.error)
      .sort(),
  ).toEqual(["Mocked:mock-1", "cancelled", "simulated:timeout"]);
});
