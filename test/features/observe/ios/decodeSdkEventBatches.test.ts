import { expect, test } from "bun:test";
import {
  decodeSdkEventBatches,
  decodeSdkEventEnvelope,
} from "../../../../src/features/observe/ios/decodeSdkEventBatches";
import { decodeSdkNetworkVersion } from "../../../../src/features/observe/ios/IosSdkNetworkWire";

function envelope(payload: unknown) {
  return {
    eventType: "network_request",
    payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}

test("retrieval decodes batches in order and preserves payload, bundle, timestamp and sequence", () => {
  const payload = {
    timestamp: 17,
    sequenceNumber: 2,
    schemaVersion: 1,
    protocolName: "http",
    metadata: { duration_ms: "12.5" },
  };
  expect(
    decodeSdkEventBatches(
      [{ bundleId: "app", events: [envelope(payload), envelope({ timestamp: 18 })] }],
      () => 123,
    ),
  ).toEqual({
    events: [
      {
        eventType: "network_request",
        applicationId: "app",
        payload,
        timestamp: 17,
        sequenceNumber: 2,
      },
      {
        eventType: "network_request",
        applicationId: "app",
        payload: { timestamp: 18 },
        timestamp: 18,
        sequenceNumber: undefined,
      },
    ],
    malformedErrors: [],
  });
});

test("invalid timestamp uses the injected clock and unsafe sequence numbers are omitted", () => {
  const result = decodeSdkEventEnvelope(
    undefined,
    envelope({ timestamp: "bad", sequenceNumber: 1.5 }),
    () => 42,
  );
  expect(result.timestamp).toBe(42);
  expect(result.sequenceNumber).toBeUndefined();
});

test("malformed envelopes return errors for the caller to log and do not discard valid neighbors", () => {
  const result = decodeSdkEventBatches(
    [
      {
        events: [
          envelope(null),
          envelope([]),
          { eventType: "log", payload: "not json" },
          envelope({}),
        ],
      },
    ],
    () => 42,
  );
  expect(result.malformedErrors).toHaveLength(3);
  expect(result.events).toHaveLength(1);
});

test("superseded poll generation discards the batch", () => {
  expect(
    decodeSdkEventBatches(
      [{ events: [envelope({})] }],
      () => 42,
      () => false,
    ).events,
  ).toEqual([]);
  expect(decodeSdkEventBatches([{}], () => 42).events).toEqual([]);
});

test("version decoder accepts only integral v0/v1 and returns a typed diagnostic for invalid values", () => {
  expect(decodeSdkNetworkVersion({}, "app")).toEqual({ success: true, schemaVersion: 0 });
  expect(decodeSdkNetworkVersion({ schemaVersion: 1 }, "app")).toEqual({
    success: true,
    schemaVersion: 1,
  });
  for (const version of [NaN, Infinity, undefined, {}, [], true]) {
    expect(decodeSdkNetworkVersion({ schemaVersion: version }, "app")).toEqual({
      success: false,
      diagnostic: {
        code: "sdk_network_schema_unsupported",
        receivedVersion: version,
        supportedVersion: 1,
        bundleId: "app",
      },
    });
  }
});
