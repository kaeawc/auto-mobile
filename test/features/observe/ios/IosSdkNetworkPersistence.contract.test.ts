import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { Database } from "../../../../src/db/types";
import {
  getNetworkEventById,
  getNetworkEvents,
  recordNetworkEvent,
} from "../../../../src/db/networkEventRepository";
import { getLogEvents, recordLogEvent } from "../../../../src/db/logEventRepository";
import { InMemoryDbWriteBarrier } from "../../../../src/db/dbWriteBarrier";
import {
  DefaultIosSdkEventIngestor,
  IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS,
} from "../../../../src/features/observe/ios/IosSdkEventIngestor";
import {
  decodeSdkEventBatches,
  type SdkEventBatchWire,
} from "../../../../src/features/observe/ios/decodeSdkEventBatches";
import {
  IOS_SDK_NETWORK_SCHEMA_VERSION,
  IOS_SDK_NETWORK_DIAGNOSTIC_TAG,
} from "../../../../src/features/observe/ios/IosSdkNetworkWire";
import {
  TelemetryRecorder,
  getNoOpTelemetryRepository,
  type TelemetryEvent,
} from "../../../../src/features/telemetry/TelemetryRecorder";
import { NetworkState } from "../../../../src/server/NetworkState";
import { registerNetworkResources } from "../../../../src/server/networkResources";
import { ResourceRegistry } from "../../../../src/server/resourceRegistry";
import { logger } from "../../../../src/utils/logger";
import { FakeFailureRecorder } from "../../../fakes/FakeFailureRecorder";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createTestDatabase } from "../../../db/testDbHelper";

// Explicit column map: any new serialized Swift key requires a mapping decision here.
// Control fields select the route/version; they are not network row columns.
const columns = {
  eventType: "routing control",
  schemaVersion: "version control",
  timestamp: "timestamp",
  url: "url",
  method: "method",
  requestId: "request_id",
  connectionId: "connection_id",
  direction: "direction",
  protocolName: "protocol",
  metadata: "metadata_json",
  sequenceNumber: "sequence_number",
  requestHeaders: "request_headers_json",
  requestBodySize: "request_body_size",
  statusCode: "status_code",
  responseHeaders: "response_headers_json",
  responseBodySize: "response_body_size",
  durationMs: "duration_ms",
  error: "error",
  host: "host",
  path: "path",
  requestBody: "request_body",
  responseBody: "response_body",
  contentType: "content_type",
} as const;

const directory = join(import.meta.dir, "../../../fixtures/ios-sdk-network");
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    batch: JSON.parse(readFileSync(join(directory, name), "utf8")) as SdkEventBatchWire,
  }));
let db: Kysely<Database>;
let ingestor: DefaultIosSdkEventIngestor;
let pushed: TelemetryEvent[];
let state: NetworkState;
let timer: FakeTimer;
let stateSpy: ReturnType<typeof spyOn<typeof NetworkState, "getInstance">>;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.deleteFrom("network_events").execute();
  await db.deleteFrom("log_events").execute();
  pushed = [];
  timer = new FakeTimer();
  state = new NetworkState({
    timer: new FakeTimer(),
    notifier: { notifyResourceUpdated: () => {} },
  });
  state.setCapture(true);
  stateSpy = spyOn(NetworkState, "getInstance").mockReturnValue(state);
  const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
  const recorder = new TelemetryRecorder(
    {
      ...getNoOpTelemetryRepository(),
      recordNetworkEvent: (event) => recordNetworkEvent(event, db),
      recordLogEvent: (event) => recordLogEvent(event, db),
    },
    () => ({
      pushTelemetryEvent: (event) => {
        pushed.push(event);
      },
    }),
    () => barrier,
  );
  ingestor = new DefaultIosSdkEventIngestor({
    deviceId: "fixture-device",
    timer,
    getNavigationGraphManager: () => ({
      recordNavigationEvent: async () => {},
      updateNodeScreenshot: async () => {},
    }),
    captureScreenshot: async () => ({ success: false }),
    telemetryRecorder: recorder,
    failureRecorder: new FakeFailureRecorder(),
    navigationScreenshotsEnabled: () => false,
  });
  registerNetworkResources({
    getNetworkEvents: (query) => getNetworkEvents(query, db),
    getNetworkEventById: (id) => getNetworkEventById(id, db),
  });
});
afterEach(() => {
  stateSpy.mockRestore();
  state.dispose();
  ResourceRegistry.clearResources();
});

async function ingest(batch: SdkEventBatchWire) {
  const decoded = decodeSdkEventBatches([batch], () => 123);
  expect(decoded.malformedErrors).toEqual([]);
  for (const event of decoded.events) {
    await ingestor.recordSdkEvent(
      { type: event.eventType, timestamp: event.timestamp, payload: event.payload },
      event.applicationId ?? null,
    );
  }
  return decoded.events;
}

function deriveBatch(payload: Record<string, unknown>): SdkEventBatchWire {
  // A test-derived variant of real SDK JSON, never presented as an SDK-emitted fixture.
  return {
    bundleId: fixtures[0].batch.bundleId,
    events: [
      {
        eventType: "network_request",
        payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
    ],
  };
}

for (const { name, batch } of fixtures) {
  test(`${name}: SDK JSON → CtrlProxy batch decoder → recorder → DB → both MCP resources`, async () => {
    const [event] = await ingest(batch);
    expect(event.eventType).toBe("network_request");
    const payload = event.payload;
    for (const key of Object.keys(payload)) {
      expect(Object.keys(columns)).toContain(key);
    }
    const [row] = await getNetworkEvents({ deviceId: "fixture-device" }, db);
    expect(row).toBeDefined();
    expect(await getNetworkEventById(row.id, db)).toEqual(row);
    const traffic = await ResourceRegistry.getResource("automobile:network/traffic")!.handler();
    const match = ResourceRegistry.matchTemplate(`automobile:network/request/${row.id}`)!;
    const detail = await match.template.handler(match.params);
    const surfaces = [row, JSON.parse(detail.text!), pushed[0].data];
    const metricDuration = Number(
      (payload.metadata as Record<string, string> | undefined)?.duration_ms,
    );
    const expected = {
      timestamp: payload.timestamp,
      url: payload.url,
      method: payload.method,
      protocol: payload.protocolName ?? null,
      requestId: payload.requestId ?? null,
      connectionId: payload.connectionId ?? null,
      direction: payload.direction ?? null,
      metadata: payload.metadata ?? null,
      sequenceNumber: payload.sequenceNumber ?? null,
      host: payload.host ?? null,
      path: payload.path ?? null,
      statusCode: payload.statusCode ?? 0,
      error: payload.error ?? null,
      durationMs: payload.durationMs ?? (Number.isFinite(metricDuration) ? metricDuration : 0),
      requestHeaders: payload.requestHeaders ?? null,
      responseHeaders: payload.responseHeaders ?? null,
      requestBodySize: payload.requestBodySize ?? -1,
      responseBodySize: payload.responseBodySize ?? -1,
      requestBody: payload.requestBody ?? null,
      responseBody: payload.responseBody ?? null,
      contentType: payload.contentType ?? null,
    };
    for (const surface of surfaces) {
      expect(surface).toMatchObject(expected);
    }
    const summary = JSON.parse(traffic.text!).events[0];
    const detailKeys = [
      "requestHeaders",
      "responseHeaders",
      "requestBody",
      "responseBody",
      "requestBodySize",
      "responseBodySize",
    ];
    for (const [key, value] of Object.entries(expected)) {
      if (detailKeys.includes(key)) {
        expect(summary).not.toHaveProperty(key);
      } else {
        expect(summary[key]).toEqual(value);
      }
    }
    expect(row.applicationId).toBe(batch.bundleId);
    expect(row.deviceId).toBe("fixture-device");
    if (name.startsWith("urlsession")) {
      expect(row.requestHeaders?.Authorization).toBe("<redacted>");
      expect(row.url).toContain("token=<redacted>");
    }
    if (name === "urlsession-full.json" || name === "urlsession-error.json") {
      expect(row.requestBody).toBe("q".repeat(16));
      expect(row.responseBody).toBe("r".repeat(16));
      expect(row.requestBodySize).toBe(64);
      expect(row.responseBodySize).toBe(64);
      expect(row.responseHeaders?.["Set-Cookie"]).toBe("<redacted>");
      expect(row.durationMs).toBe(22.5); // Top-level timing wins over metadata.duration_ms.
    }
  });
}

test("serialized fixtures exercise every Swift field with non-null values", () => {
  const keys = new Set<string>();
  for (const { batch } of fixtures) {
    const decoded = decodeSdkEventBatches([batch], () => 123);
    for (const { payload } of decoded.events) {
      for (const [key, value] of Object.entries(payload)) {
        if (value !== null) {
          keys.add(key);
        }
      }
      expect(payload.schemaVersion).toBe(IOS_SDK_NETWORK_SCHEMA_VERSION);
    }
  }
  expect([...keys].sort()).toEqual(Object.keys(columns).sort());
  expect(fixtures.map(({ name }) => name)).toContain("urlsession-full.json");
  expect(fixtures.map(({ name }) => name)).toContain("urlsession-error.json");
});

const realPayload = decodeSdkEventBatches([fixtures[0].batch], () => 123).events[0].payload;
for (const version of [0, IOS_SDK_NETWORK_SCHEMA_VERSION, undefined]) {
  test(`accepts derived SDK version ${version ?? "absent legacy"} and legacy protocol spelling`, async () => {
    const payload = { ...realPayload, schemaVersion: version, protocol: "legacy-protocol" };
    delete (payload as Record<string, unknown>).protocolName;
    if (version === undefined) {
      delete (payload as Record<string, unknown>).schemaVersion;
    }
    await ingest(deriveBatch(payload));
    expect((await getNetworkEvents({}, db))[0].protocol).toBe("legacy-protocol");
    expect(await getLogEvents({}, db)).toEqual([]);
  });
}
for (const version of [2, -1, "1", null, 1.5]) {
  test(`rejects schemaVersion=${JSON.stringify(version)} with persisted/pushed diagnostic and warning`, async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await ingest(deriveBatch({ ...realPayload, schemaVersion: version }));
      expect(await getNetworkEvents({}, db)).toEqual([]);
      const [log] = await getLogEvents({ tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG }, db);
      const diagnostic = {
        code: "sdk_network_schema_unsupported",
        receivedVersion: version,
        supportedVersion: 1,
        bundleId: fixtures[0].batch.bundleId,
      };
      expect(JSON.parse(log.message)).toEqual(diagnostic);
      expect(warning).toHaveBeenCalledWith(
        "[IosSdkEventIngestor] Unsupported network schema",
        diagnostic,
      );
      expect(pushed).toHaveLength(1);
      expect(pushed[0].category).toBe("log");
      expect(pushed[0].data).toMatchObject({
        tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG,
        message: log.message,
      });
    } finally {
      warning.mockRestore();
    }
  });
}

test("version diagnostics remain observable with network capture disabled", async () => {
  state.setCapture(false);
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await ingest(deriveBatch({ ...realPayload, schemaVersion: 2 }));
    expect(await getNetworkEvents({}, db)).toEqual([]);
    expect(await getLogEvents({ tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG }, db)).toHaveLength(1);
    expect(pushed[0].category).toBe("log");
  } finally {
    warning.mockRestore();
  }
});

test("future-version flood is rejected with one diagnostic per version/window", async () => {
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const batch = deriveBatch({ ...realPayload, schemaVersion: 2 });
    for (let i = 0; i < 100; i += 1) {
      await ingest(batch);
    }
    expect(await getNetworkEvents({}, db)).toEqual([]);
    const logs = await getLogEvents({ tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG }, db);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].message)).not.toHaveProperty("suppressedCount");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveLength(1);
    await ingest(deriveBatch({ ...realPayload, schemaVersion: 3 }));
    expect(await getLogEvents({ tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG }, db)).toHaveLength(2);
    timer.advanceTime(IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS + 1);
    await ingest(batch);
    expect(pushed).toHaveLength(3);
    expect(JSON.parse((pushed[2].data as { message: string }).message).suppressedCount).toBe(99);
    expect(warning).toHaveBeenCalledTimes(3);
    await ingest(batch);
    timer.advanceTime(IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS);
    await ingest(batch);
    expect(JSON.parse((pushed[3].data as { message: string }).message).suppressedCount).toBe(1);
    expect(await getNetworkEvents({}, db)).toEqual([]);
  } finally {
    warning.mockRestore();
  }
});

test("oversized version diagnostics and dedupe keys share a bounded value", async () => {
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await ingest(deriveBatch({ ...realPayload, schemaVersion: "v".repeat(10000) }));
    await ingest(deriveBatch({ ...realPayload, schemaVersion: "v".repeat(10000) + "different" }));
    const logs = await getLogEvents({ tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG }, db);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].message).receivedVersion).toBe("v".repeat(31) + "…");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(await getNetworkEvents({}, db)).toEqual([]);
  } finally {
    warning.mockRestore();
  }
});

test("diagnostic keys separate apps and rate-limit all overflow versions together", async () => {
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const batch = deriveBatch({ ...realPayload, schemaVersion: 2 });
    await ingest(batch);
    await ingest({ ...batch, bundleId: "another-app" });
    expect(pushed).toHaveLength(2);
    for (let version = 3; version < 103; version += 1) {
      await ingest(deriveBatch({ ...realPayload, schemaVersion: version }));
    }
    expect(warning).toHaveBeenCalledTimes(64);
    expect(await getLogEvents({ tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG }, db)).toHaveLength(64);
    timer.advanceTime(IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS);
    await ingest(deriveBatch({ ...realPayload, schemaVersion: 104 }));
    expect(JSON.parse((pushed[64].data as { message: string }).message).suppressedCount).toBe(38);
    expect(await getNetworkEvents({}, db)).toEqual([]);
  } finally {
    warning.mockRestore();
  }
});
