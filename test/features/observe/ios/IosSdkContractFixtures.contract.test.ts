import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import {
  DefaultIosSdkEventIngestor,
  type IosTelemetryRecorder,
} from "../../../../src/features/observe/ios/IosSdkEventIngestor";
import { FakeFailureRecorder } from "../../../fakes/FakeFailureRecorder";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";

interface FixtureBatch {
  bundleId: string;
  timestamp: number;
  events: Array<{ eventType: string; payload: string }>;
}

interface DecodedEvent {
  eventType: string;
  applicationId?: string;
  timestamp: number;
  sequenceNumber?: number;
  payload: Record<string, unknown>;
}

function decodeFixture(name: string): DecodedEvent {
  const batch = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../fixtures/ios-contract", `${name}.json`), "utf8"),
  ) as FixtureBatch;
  expect(batch.bundleId).toBe("fixture.app");
  expect(batch.timestamp).toBe(1_700_000_000_000);
  expect(batch.events).toHaveLength(1);

  const timer = new FakeTimer();
  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: "fixture-device", platform: "ios", name: "Fixture iPhone" },
    8765,
    createSuccessWebSocketFactory(timer),
    timer,
  );
  const decoder = client as unknown as {
    decodeSdkEventBatches(batches: FixtureBatch[], generation: number): DecodedEvent[];
  };
  const events = decoder.decodeSdkEventBatches([batch], 0);
  expect(events).toHaveLength(1);
  expect(events[0].applicationId).toBe(batch.bundleId);
  expect(events[0].eventType).toBe(batch.events[0].eventType);
  return events[0];
}

async function ingest(event: DecodedEvent): Promise<{
  navigation: Record<string, unknown>[];
  graph: Record<string, unknown>[];
  os: Record<string, unknown>[];
  storage: Record<string, unknown>[];
}> {
  const calls = {
    navigation: [] as Record<string, unknown>[],
    graph: [] as Record<string, unknown>[],
    os: [] as Record<string, unknown>[],
    storage: [] as Record<string, unknown>[],
  };
  let context: { deviceId: string | null; sessionId: string | null } = {
    deviceId: null,
    sessionId: null,
  };
  const recorder = {
    getContext: () => context,
    setContext: (deviceId: string | null, sessionId: string | null) => {
      context = { deviceId, sessionId };
    },
    recordNavigationEvent: async (value: Record<string, unknown>) => {
      calls.navigation.push(value);
    },
    recordOsEvent: async (value: Record<string, unknown>) => {
      calls.os.push(value);
    },
    recordStorageEvent: async (value: Record<string, unknown>) => {
      calls.storage.push(value);
    },
  } as unknown as IosTelemetryRecorder;
  const ingestor = new DefaultIosSdkEventIngestor({
    deviceId: "fixture-device",
    getNavigationGraphManager: () => ({
      recordNavigationEvent: async (value) => {
        calls.graph.push(value as unknown as Record<string, unknown>);
      },
      updateNodeScreenshot: async () => {},
    }),
    captureScreenshot: async () => ({ success: false }),
    telemetryRecorder: recorder,
    failureRecorder: new FakeFailureRecorder(),
    navigationScreenshotsEnabled: () => false,
  });
  await ingestor.recordSdkEvent(
    { type: event.eventType, timestamp: event.timestamp, payload: event.payload },
    event.applicationId ?? null,
  );
  expect(context).toEqual({ deviceId: null, sessionId: null });
  return calls;
}

test("SDK navigation batch preserves every encoded field through client decode and routes navigation", async () => {
  const event = decodeFixture("navigation");
  expect(event.sequenceNumber).toBe(7);
  expect(event.payload).toEqual({
    eventType: "navigation",
    timestamp: 1_700_000_000_001,
    sequenceNumber: 7,
    sessionId: "fixture-session",
    sessionEpoch: 2,
    trackingGeneration: 3,
    destination: "Details",
    source: "deep_link",
    arguments: { item: "42" },
    metadata: { origin: "fixture" },
    screenIdentity: "details-42",
    sceneIdentifier: "fixture-scene",
    transitionIdentifier: "transition-7",
    transitionCompleted: true,
  });
  const calls = await ingest(event);
  expect(calls.graph).toEqual([
    {
      applicationId: "fixture.app",
      destination: "Details",
      source: "deep_link",
      arguments: { item: "42" },
      metadata: { origin: "fixture" },
      triggeringInteraction: null,
      deviceId: "fixture-device",
    },
  ]);
  // The graph manager owns the navigation telemetry record (#10195): the ingestor records none
  // beside it.
  expect(calls.navigation).toEqual([]);
});

test("SDK WebView batch preserves every encoded field and routes event details", async () => {
  const event = decodeFixture("webview");
  expect(event.sequenceNumber).toBeUndefined();
  expect(event.payload).toEqual({
    eventType: "webview",
    timestamp: 1_700_000_000_002,
    webViewId: "fixture-webview",
    name: "request_started",
    url: "https://example.com/items/42",
    frameId: "main-frame",
    requestId: "request-42",
    metadata: { method: "GET" },
  });
  const calls = await ingest(event);
  expect(calls.os).toEqual([
    {
      timestamp: event.timestamp,
      applicationId: "fixture.app",
      category: "webview",
      kind: "request_started",
      details: {
        webViewId: "fixture-webview",
        url: "https://example.com/items/42",
        frameId: "main-frame",
        requestId: "request-42",
        method: "GET",
      },
    },
  ]);
});

test("SDK storage batch preserves every encoded field and maps change metadata", async () => {
  const event = decodeFixture("storage-changed");
  expect(event.sequenceNumber).toBe(8);
  expect(event.payload).toEqual({
    eventType: "storage_changed",
    timestamp: 1_700_000_000_003,
    suiteName: "fixture.defaults",
    key: "selectedItem",
    newValue: "42",
    previousValue: "41",
    valueType: "String",
    changeType: "modify",
    sequenceNumber: 8,
  });
  const calls = await ingest(event);
  expect(calls.storage).toEqual([
    {
      timestamp: event.timestamp,
      applicationId: "fixture.app",
      fileName: "fixture.defaults",
      key: "selectedItem",
      value: "42",
      previousValue: "41",
      valueType: "String",
      changeType: "modify",
    },
  ]);
});
