import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import {
  recordNetworkEvent,
  getNetworkEvents,
  getNetworkEventById,
} from "../../src/db/networkEventRepository";

function makeInput(overrides: Record<string, any> = {}) {
  return {
    deviceId: "d1",
    timestamp: 1000,
    applicationId: null,
    sessionId: null,
    url: "https://api.example.com/data",
    method: "GET",
    statusCode: 200,
    durationMs: 100,
    requestBodySize: 0,
    responseBodySize: 50,
    protocol: "h2",
    host: "api.example.com",
    path: "/data",
    error: null,
    ...overrides,
  };
}

describe("networkEventRepository extended queries", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("recordNetworkEvent returns inserted id", async () => {
    const id = await recordNetworkEvent(makeInput(), db);
    expect(id).toBeGreaterThan(0);
  });

  test("getNetworkEventById returns full event with id", async () => {
    const id = await recordNetworkEvent(
      makeInput({
        requestHeaders: { Authorization: "Bearer tok" },
        responseHeaders: { "Content-Type": "application/json" },
        requestBody: '{"q":"test"}',
        responseBody: '{"results":[]}',
        contentType: "application/json",
      }),
      db,
    );

    const event = await getNetworkEventById(id, db);
    expect(event).not.toBeNull();
    expect(event!.id).toBe(id);
    expect(event!.url).toBe("https://api.example.com/data");
    expect(event!.requestHeaders).toEqual({ Authorization: "Bearer tok" });
    expect(event!.requestBody).toBe('{"q":"test"}');
    expect(event!.responseBody).toBe('{"results":[]}');
  });

  test("getNetworkEventById returns null for missing id", async () => {
    const event = await getNetworkEventById(99999, db);
    expect(event).toBeNull();
  });

  test("getNetworkEventById truncates bodies over 10KB", async () => {
    const largeBody = "x".repeat(20_000);
    const id = await recordNetworkEvent(
      makeInput({ responseBody: largeBody, responseBodySize: 20_000 }),
      db,
    );

    const event = await getNetworkEventById(id, db);
    expect(event!.responseBody!.length).toBe(10_240);
  });

  test("getNetworkEvents truncates bodies over 10KB", async () => {
    const largeRequest = "q".repeat(15_000);
    const largeResponse = "r".repeat(20_000);
    await recordNetworkEvent(
      makeInput({
        requestBody: largeRequest,
        responseBody: largeResponse,
        requestBodySize: 15_000,
        responseBodySize: 20_000,
      }),
      db,
    );

    const events = await getNetworkEvents({}, db);
    expect(events).toHaveLength(1);
    expect(events[0].requestBody!.length).toBe(10_240);
    expect(events[0].responseBody!.length).toBe(10_240);
  });

  test("getNetworkEvents leaves sub-10KB bodies unchanged and null bodies null", async () => {
    const small = '{"ok":true}';
    await recordNetworkEvent(makeInput({ requestBody: small, responseBody: null }), db);

    const events = await getNetworkEvents({}, db);
    expect(events[0].requestBody).toBe(small);
    expect(events[0].responseBody).toBeNull();
  });

  test("getNetworkEvents and getNetworkEventById agree on the truncated body", async () => {
    const largeBody = "z".repeat(50_000);
    const id = await recordNetworkEvent(
      makeInput({ responseBody: largeBody, responseBodySize: 50_000 }),
      db,
    );

    const single = await getNetworkEventById(id, db);
    const listed = (await getNetworkEvents({}, db)).find((e) => e.id === id);
    expect(listed).toBeDefined();
    expect(listed!.responseBody).toBe(single!.responseBody!);
    expect(listed!.responseBody!.length).toBe(10_240);
  });

  test("getNetworkEvents truncation does not split a surrogate pair", async () => {
    // Place a 😀 (surrogate pair) so its high surrogate lands at the 10_240th
    // code unit — a naive slice would leave a lone surrogate (mojibake).
    const body = "x".repeat(10_239) + "😀" + "y".repeat(5_000);
    const id = await recordNetworkEvent(
      makeInput({ responseBody: body, responseBodySize: body.length }),
      db,
    );

    const listed = (await getNetworkEvents({}, db)).find((e) => e.id === id);
    expect(listed!.responseBody!.length).toBe(10_239);
    expect(listed!.responseBody!.isWellFormed()).toBe(true);
  });

  test("backfill payload shrinks ~10x once list bodies are capped", async () => {
    // 100 rows each carrying a 100KB body: the serialized list should drop from
    // ~10MB (raw) to ~1MB (100 x 10KB) — the win the issue measures.
    const bigBody = "b".repeat(100_000);
    for (let i = 0; i < 100; i++) {
      await recordNetworkEvent(
        makeInput({ timestamp: 1000 + i, responseBody: bigBody, responseBodySize: 100_000 }),
        db,
      );
    }
    const events = await getNetworkEvents({ limit: 100 }, db);
    expect(events).toHaveLength(100);
    const serializedBytes = JSON.stringify(events).length;
    const rawBytes = 100 * 100_000;
    // Capped payload is ~1MB (100 x 10KB) vs ~10MB raw — assert the ~10x win
    // with margin for the non-body JSON scaffolding per row.
    expect(serializedBytes).toBeLessThan(rawBytes / 8);
    expect(events.every((e) => e.responseBody!.length === 10_240)).toBe(true);
  });

  test("getNetworkEvents returns id on each event", async () => {
    await recordNetworkEvent(makeInput({ timestamp: 100 }), db);
    await recordNetworkEvent(makeInput({ timestamp: 200 }), db);

    const events = await getNetworkEvents({}, db);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBeDefined();
    expect(events[1].id).toBeDefined();
    expect(events[0].id).not.toBe(events[1].id);
  });

  test("getNetworkEvents filters by host", async () => {
    await recordNetworkEvent(makeInput({ host: "api.example.com", timestamp: 100 }), db);
    await recordNetworkEvent(makeInput({ host: "cdn.example.com", timestamp: 200 }), db);

    const events = await getNetworkEvents({ host: "cdn.example.com" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].host).toBe("cdn.example.com");
  });

  test("getNetworkEvents filters by method", async () => {
    await recordNetworkEvent(makeInput({ method: "GET", timestamp: 100 }), db);
    await recordNetworkEvent(makeInput({ method: "POST", timestamp: 200 }), db);

    const events = await getNetworkEvents({ method: "POST" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("POST");
  });

  test("getNetworkEvents filters by exact status code", async () => {
    await recordNetworkEvent(makeInput({ statusCode: 200, timestamp: 100 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 404, timestamp: 200 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 500, timestamp: 300 }), db);

    const events = await getNetworkEvents({ statusCode: "404" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].statusCode).toBe(404);
  });

  test("getNetworkEvents filters by status code class (4xx)", async () => {
    await recordNetworkEvent(makeInput({ statusCode: 200, timestamp: 100 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 400, timestamp: 200 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 404, timestamp: 300 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 500, timestamp: 400 }), db);

    const events = await getNetworkEvents({ statusCode: "4xx" }, db);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.statusCode >= 400 && e.statusCode < 500)).toBe(true);
  });

  test("getNetworkEvents filters by status code class (5xx)", async () => {
    await recordNetworkEvent(makeInput({ statusCode: 200, timestamp: 100 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 500, timestamp: 200 }), db);
    await recordNetworkEvent(makeInput({ statusCode: 503, timestamp: 300 }), db);

    const events = await getNetworkEvents({ statusCode: "5xx" }, db);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.statusCode >= 500 && e.statusCode < 600)).toBe(true);
  });

  test("getNetworkEvents combines multiple filters", async () => {
    await recordNetworkEvent(
      makeInput({ host: "api.com", method: "GET", statusCode: 200, timestamp: 100 }),
      db,
    );
    await recordNetworkEvent(
      makeInput({ host: "api.com", method: "POST", statusCode: 500, timestamp: 200 }),
      db,
    );
    await recordNetworkEvent(
      makeInput({ host: "cdn.com", method: "GET", statusCode: 500, timestamp: 300 }),
      db,
    );

    const events = await getNetworkEvents({ host: "api.com", statusCode: "5xx" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("POST");
  });
});
