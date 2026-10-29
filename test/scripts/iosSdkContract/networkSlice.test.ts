import { describe, expect, test } from "bun:test";
import { formatFindings } from "../../../scripts/ios/sdk-contract/boundaries";
import type {
  ExpectedNetworkEvent,
  SdkContractManifest,
} from "../../../scripts/ios/sdk-contract/manifest";
import {
  judgeManifest,
  judgeNetworkCase,
  matchSdkPayload,
  networkFieldMismatches,
  networkRecordKey,
  recordDifferences,
  type NetworkCaseObservation,
} from "../../../scripts/ios/sdk-contract/networkSlice";

const expected: ExpectedNetworkEvent = {
  caseName: "urlsession",
  url: "http://127.0.0.1:5000/contract/run-1/urlsession",
  method: "GET",
  protocolName: "http",
  direction: "response",
  requestId: "req-1",
  connectionId: "contract-urlsession-run-1",
  statusCode: 200,
  responseBodySize: 13,
  responseBody: "ok:urlsession",
  metadata: { contract_case: "urlsession" },
  redactedRequestHeaders: ["Authorization"],
};

const payload = {
  url: expected.url,
  method: "GET",
  protocolName: "http",
  direction: "response",
  requestId: "req-1",
  connectionId: expected.connectionId,
  statusCode: 200,
  responseBodySize: 13,
  responseBody: "ok:urlsession",
  metadata: { contract_case: "urlsession", duration_ms: "4.2" },
  requestHeaders: { Authorization: "<redacted>", "X-Contract-Run": "run-1" },
};

const surface = { ...payload, protocol: "http", protocolName: undefined, id: 7 };

function observation(overrides: Partial<NetworkCaseObservation> = {}): NetworkCaseObservation {
  return {
    expected,
    sdkPayload: payload,
    reference: { row: surface, detail: surface },
    live: { ...surface, id: 99 },
    queuedInCtrlProxy: undefined,
    ...overrides,
  };
}

describe("judgeNetworkCase", () => {
  test("passes when every layer agrees", () => {
    expect(judgeNetworkCase(observation(), ["contract-secret"])).toBeUndefined();
  });

  test("blames SDK serialization when no envelope was encoded", () => {
    expect(judgeNetworkCase(observation({ sdkPayload: undefined }))?.boundary).toBe(
      "sdk-serialization",
    );
  });

  test("blames SDK serialization for a field the adapter was given but not encoded", () => {
    const result = judgeNetworkCase(
      observation({ sdkPayload: { ...payload, connectionId: null } }),
    );
    expect(result?.boundary).toBe("sdk-serialization");
    expect(result?.message).toContain("connectionId");
  });

  test("blames SDK serialization for an unredacted secret", () => {
    const leaky = { ...payload, error: "Bearer contract-secret" };
    const result = judgeNetworkCase(observation({ sdkPayload: leaky }), ["contract-secret"]);
    expect(result?.boundary).toBe("sdk-serialization");
    expect(result?.message).toContain("unredacted");
  });

  test("blames the iOS client when the production ingestor drops the SDK bytes", () => {
    expect(judgeNetworkCase(observation({ reference: undefined }))?.boundary).toBe("ios-client");
  });

  test("blames the iOS client when the persisted row loses a field", () => {
    const row = { ...surface, protocol: null };
    const result = judgeNetworkCase(observation({ reference: { row, detail: surface } }));
    expect(result?.boundary).toBe("ios-client");
    expect(result?.message).toContain("protocol");
  });

  test("blames the MCP surface when the row is right but the resource is not", () => {
    const detail = { ...surface, metadata: null };
    const result = judgeNetworkCase(observation({ reference: { row: surface, detail } }));
    expect(result?.boundary).toBe("mcp-surface");
  });

  test("blames the iOS client when CtrlProxy still holds an undrained event", () => {
    const result = judgeNetworkCase(observation({ live: undefined, queuedInCtrlProxy: true }));
    expect(result?.boundary).toBe("ios-client");
  });

  test("blames the SDK endpoint when neither CtrlProxy nor the daemon has the event", () => {
    const result = judgeNetworkCase(observation({ live: undefined, queuedInCtrlProxy: false }));
    expect(result?.boundary).toBe("sdk-endpoint");
  });

  test("blames CtrlProxy when live differs from the replay of the same SDK bytes", () => {
    const result = judgeNetworkCase(
      observation({ live: { ...surface, id: 99, sequenceNumber: 4 } }),
    );
    expect(result?.boundary).toBe("ctrlproxy-command");
    expect(result?.message).toContain("sequenceNumber");
  });
});

describe("field helpers", () => {
  test("uses the wire spelling for SDK payloads and the surface spelling for records", () => {
    expect(networkFieldMismatches(expected, payload, "wire")).toEqual([]);
    expect(networkFieldMismatches(expected, surface, "surface")).toEqual([]);
    expect(networkFieldMismatches(expected, surface, "wire")).toEqual([
      'protocolName: expected "http", got undefined',
    ]);
  });

  test("leaves unasserted fields alone", () => {
    const frame: ExpectedNetworkEvent = {
      caseName: "websocket-sent",
      url: "ws://127.0.0.1:1/contract/run-1/websocket",
      method: "text",
      protocolName: "websocket",
      direction: "sent",
    };
    expect(networkFieldMismatches(frame, { ...frame, statusCode: 101 }, "wire")).toEqual([]);
  });

  test("ignores the database id when comparing replay and live records", () => {
    expect(recordDifferences({ id: 1, url: "a" }, { id: 2, url: "a" })).toEqual([]);
    expect(recordDifferences({ id: 1, url: "a" }, { id: 2, url: "b" })).toHaveLength(1);
  });

  test("matches payloads by request id, or by frame identity when the SDK generated the id", () => {
    const sent = {
      url: "ws://x",
      method: "text",
      protocolName: "websocket",
      direction: "sent",
      connectionId: "c",
    };
    const received = { ...sent, direction: "received" };
    const frame: ExpectedNetworkEvent = {
      caseName: "websocket-received",
      url: "ws://x",
      method: "text",
      protocolName: "websocket",
      direction: "received",
      connectionId: "c",
    };
    expect(matchSdkPayload(expected, [sent, payload])).toBe(payload);
    expect(matchSdkPayload(frame, [sent, received])).toBe(received);
    expect(matchSdkPayload(frame, [sent])).toBeUndefined();
  });

  test("matches a URLProtocol record, which has no protocol, direction or connection", () => {
    const record = { url: "http://h/contract/r/x", method: "GET", connectionId: null };
    const decision = { ...record, method: "SEND" };
    const urlProtocol: ExpectedNetworkEvent = {
      caseName: "fault-urlsession-fail",
      url: "http://h/contract/r/x",
      method: "GET",
    };
    expect(matchSdkPayload(urlProtocol, [decision, record])).toBe(record);
  });

  test("asserts an absent error with null and leaves an undefined error unasserted", () => {
    const noError: ExpectedNetworkEvent = { ...expected, error: null };
    expect(networkFieldMismatches(noError, payload, "wire")).toEqual([]);
    expect(networkFieldMismatches(noError, { ...surface, error: null }, "surface")).toEqual([]);
    expect(networkFieldMismatches(noError, { ...payload, error: "fault:f:error" }, "wire")).toEqual(
      ['error: expected null, got "fault:f:error"'],
    );
    expect(networkFieldMismatches(expected, { ...payload, error: "x" }, "wire")).toEqual([]);
  });

  test("keys records by request id, else by method and URL", () => {
    expect(networkRecordKey({ requestId: "r-1", url: "u", method: "GET" })).toBe("r-1");
    expect(networkRecordKey({ requestId: "", url: "u", method: "GET" })).toBe("url:GET u");
    expect(networkRecordKey({ requestId: null })).toBeUndefined();
  });

  test("reports case findings under the observation's slice", () => {
    const result = judgeNetworkCase(observation({ sdkPayload: undefined, slice: "faults" }));
    expect(result?.slice).toBe("faults");
  });
});

describe("judgeManifest", () => {
  const manifest: SdkContractManifest = {
    schemaVersion: 3,
    runId: "run-1",
    scenario: "network",
    status: "complete",
    network: [expected],
    faults: [],
    events: [],
    undecodableBatches: 0,
  };

  test("reports nothing for a completed run", () => {
    expect(judgeManifest(manifest)).toEqual([]);
  });

  test("blames the fixture host for a failed scenario", () => {
    const findings = judgeManifest({ ...manifest, status: "failed", failure: "listener failed" });
    expect(findings).toEqual([
      { slice: "network", caseName: "run", boundary: "fixture-host", message: "listener failed" },
    ]);
  });

  test("needs recorded cases for the scenario that ran", () => {
    expect(judgeManifest({ ...manifest, network: [] })[0].message).toContain("network scenario");
    const faults = { ...manifest, scenario: "faults", network: [] };
    expect(judgeManifest(faults, "faults")[0]).toMatchObject({
      slice: "faults",
      boundary: "fixture-host",
    });
    const withCapabilities = {
      ...faults,
      capabilities: { beforeRegistration: [], afterRegistration: [] },
    };
    expect(judgeManifest(withCapabilities, "capabilities")).toEqual([]);
  });

  test("blames SDK serialization for batches the public type cannot decode", () => {
    expect(judgeManifest({ ...manifest, undecodableBatches: 2 })[0].boundary).toBe(
      "sdk-serialization",
    );
  });

  test("formats findings with the boundary meaning", () => {
    const text = formatFindings(judgeManifest({ ...manifest, status: "failed", failure: "x" }));
    expect(text).toContain("FAIL [fixture-host] network/run: x");
    expect(text).toContain("Playground could not run the scenario");
    expect(formatFindings([])).toStartWith("PASS");
  });
});
