import { expect, test } from "bun:test";
import { parseSdkContractManifest } from "../../../scripts/ios/sdk-contract/manifest";

// Shape written by SdkContractManifestWriter (sorted keys, nil optionals omitted).
const swiftManifest = {
  bundleId: "dev.jasonpearson.automobile.Playground",
  events: [{ eventType: "network_request", payload: "e30=" }],
  network: [
    {
      caseName: "websocket-sent",
      connectionId: "contract-websocket-run-1",
      direction: "sent",
      method: "text",
      protocolName: "websocket",
      requestBodySize: 14,
      url: "ws://127.0.0.1:5001/contract/run-1/websocket",
    },
  ],
  runId: "run-1",
  scenario: "network",
  schemaVersion: 1,
  status: "complete",
  undecodableBatches: 0,
};

test("parses the manifest the Swift writer emits", () => {
  const result = parseSdkContractManifest(JSON.stringify(swiftManifest));
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.manifest.network[0].requestId).toBeUndefined();
    expect(result.manifest.events).toHaveLength(1);
  }
});

test("rejects a manifest from a newer schema", () => {
  const result = parseSdkContractManifest(JSON.stringify({ ...swiftManifest, schemaVersion: 2 }));
  expect(result).toMatchObject({ success: false });
  if (!result.success) {
    expect(result.error).toContain("schemaVersion");
  }
});

test("rejects text that is not JSON", () => {
  expect(parseSdkContractManifest("{")).toMatchObject({ success: false });
});
