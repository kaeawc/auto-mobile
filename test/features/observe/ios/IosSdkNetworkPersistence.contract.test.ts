import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { Database } from "../../../../src/db/types";
import {
  getNetworkEventById,
  getNetworkEvents,
  recordNetworkEvent,
} from "../../../../src/db/networkEventRepository";
import {
  DefaultIosSdkEventIngestor,
  type IosTelemetryRecorder,
} from "../../../../src/features/observe/ios/IosSdkEventIngestor";
import { FakeFailureRecorder } from "../../../fakes/FakeFailureRecorder";
import { createTestDatabase } from "../../../db/testDbHelper";

interface SdkFixtureBatch {
  bundleId: string;
  events: Array<{ eventType: string; payload: string }>;
}

let db: Kysely<Database>;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.destroy();
});

test("real SDK-serialized network batches round-trip through iOS ingestion and DB reads", async () => {
  let context = { deviceId: null as string | null, sessionId: null as string | null };
  const recorder = {
    getContext: () => context,
    setContext: (deviceId: string | null, sessionId: string | null) => {
      context = { deviceId, sessionId };
    },
    recordNetworkEvent: async (
      event: Parameters<IosTelemetryRecorder["recordNetworkEvent"]>[0],
    ) => {
      await recordNetworkEvent({ ...event, ...context }, db);
    },
  } as IosTelemetryRecorder;
  const ingestor = new DefaultIosSdkEventIngestor({
    deviceId: "fixture-device",
    getNavigationGraphManager: () => ({
      recordNavigationEvent: async () => {},
      updateNodeScreenshot: async () => {},
    }),
    captureScreenshot: async () => ({ success: false }),
    telemetryRecorder: recorder,
    failureRecorder: new FakeFailureRecorder(),
    navigationScreenshotsEnabled: () => false,
  });

  for (const name of ["urlsession", "websocket", "nwconnection"]) {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../fixtures/ios-sdk-network", `${name}.json`),
        "utf8",
      ),
    ) as SdkFixtureBatch;
    expect(fixture.events).toHaveLength(1);
    const envelope = fixture.events[0];
    expect(envelope.eventType).toBe("network_request");
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(payload.protocolName).toBe(
      { urlsession: "http", websocket: "websocket", nwconnection: "nwconnection" }[name],
    );
    expect(payload.requestId).toBe("fixture-request");
    expect(payload.sequenceNumber).toBeGreaterThan(0);
    await ingestor.recordSdkEvent(
      { type: envelope.eventType, timestamp: payload.timestamp as number, payload },
      fixture.bundleId,
    );

    const listed = await getNetworkEvents({ deviceId: "fixture-device", limit: 3 }, db);
    const row = listed.find((event) => event.sequenceNumber === payload.sequenceNumber);
    expect(row).toBeDefined();
    const byId = await getNetworkEventById(row!.id, db);
    expect(byId).toEqual(row);
    expect(row).toMatchObject({
      deviceId: "fixture-device",
      applicationId: fixture.bundleId,
      timestamp: payload.timestamp,
      url: payload.url,
      method: payload.method,
      protocol: payload.protocolName,
      requestId: payload.requestId,
      connectionId: payload.connectionId,
      direction: payload.direction,
      sequenceNumber: payload.sequenceNumber,
      host: payload.host,
      path: payload.path,
      statusCode: payload.statusCode ?? 0,
      error: payload.error ?? null,
      durationMs:
        payload.durationMs ??
        Number((payload.metadata as Record<string, string> | undefined)?.duration_ms ?? 0),
    });
    expect(row!.metadata).toEqual(payload.metadata ?? null);
    expect(row!.requestHeaders).toEqual(payload.requestHeaders ?? null);
    expect(row!.responseHeaders).toEqual(payload.responseHeaders ?? null);
    expect(row!.requestBodySize).toBe(payload.requestBodySize ?? -1);
    expect(row!.responseBodySize).toBe(payload.responseBodySize ?? -1);
    expect(row!.requestBody).toBe(payload.requestBody ?? null);
    expect(row!.responseBody).toBe(payload.responseBody ?? null);
    expect(row!.contentType).toBe(payload.contentType ?? null);
    if (name === "urlsession") {
      expect(row!.durationMs).toBe(12.5);
      expect(row!.requestHeaders).toEqual({ Authorization: "<redacted>" });
      expect(row!.url).toContain("token=<redacted>");
    }
  }
});
