import { expect, test } from "bun:test";
import { parseSdkContractManifest } from "../../../scripts/ios/sdk-contract/manifest";

// Shape written by SdkContractManifestWriter (sorted keys, nil optionals omitted).
const swiftManifest = {
  bundleId: "dev.jasonpearson.automobile.Playground",
  events: [{ eventType: "network_request", payload: "e30=" }],
  faults: [],
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
  schemaVersion: 4,
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

test("parses URLProtocol records, fault observations and capability descriptors", () => {
  const manifest = {
    ...swiftManifest,
    scenario: "faults",
    network: [
      { caseName: "urlsession", url: "http://127.0.0.1:5000/contract/run-1/x", method: "GET" },
    ],
    faults: [
      {
        caseName: "fault-urlsession-fail",
        clientError: "NSURLErrorDomain:-1001",
        elapsedMs: 3.5,
        url: "http://127.0.0.1:5000/contract/run-1/fault-urlsession-fail",
      },
    ],
    capabilities: {
      afterRegistration: [
        {
          faultActions: ["closeConnection"],
          faultEnforcement: "ENFORCED",
          id: "network.transport.websocket",
          state: "SUPPORTED",
        },
      ],
      beforeRegistration: [],
    },
  };
  const result = parseSdkContractManifest(JSON.stringify(manifest));
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.manifest.network[0].protocolName).toBeUndefined();
    expect(result.manifest.faults[0].clientError).toBe("NSURLErrorDomain:-1001");
    expect(result.manifest.capabilities?.afterRegistration[0].reason).toBeUndefined();
  }
});

test("rejects a manifest from a newer schema", () => {
  const result = parseSdkContractManifest(JSON.stringify({ ...swiftManifest, schemaVersion: 5 }));
  expect(result).toMatchObject({ success: false });
  if (!result.success) {
    expect(result.error).toContain("schemaVersion");
  }
});

test("rejects text that is not JSON", () => {
  expect(parseSdkContractManifest("{")).toMatchObject({ success: false });
});

test("reads the observation host log and the storage registration", () => {
  const result = parseSdkContractManifest(
    JSON.stringify({
      ...swiftManifest,
      observation: {
        actions: [{ elementId: "contract-save", kind: "tap", observationIdentity: 3 }],
        captures: 4,
      },
      storage: {
        allowKeychainDeletion: true,
        coreDataStores: [{ identifier: "ContractPrivate-run-1", queryable: false }],
        hostCoordinatedSuites: [],
        keychainEntries: [{ accessGroup: "g", account: "a", service: "s" }],
        secretWritten: true,
        uncoordinatedSuites: ["group.contract"],
      },
    }),
  );
  expect(result).toMatchObject({ success: true });
  if (result.success) {
    expect(result.manifest.observation?.actions[0]).toEqual({
      kind: "tap",
      elementId: "contract-save",
      observationIdentity: 3,
    });
    expect(result.manifest.storage?.coreDataStores[0].appGroup).toBeUndefined();
  }
});

test("Core Data registrations require an explicit queryable flag", () => {
  const storage = {
    allowKeychainDeletion: false,
    coreDataStores: [{ identifier: "store" }],
    hostCoordinatedSuites: [],
    uncoordinatedSuites: [],
    keychainEntries: [],
    secretWritten: false,
  };
  expect(parseSdkContractManifest(JSON.stringify({ ...swiftManifest, storage })).success).toBe(
    false,
  );
  for (const queryable of [true, false]) {
    expect(
      parseSdkContractManifest(
        JSON.stringify({
          ...swiftManifest,
          storage: { ...storage, coreDataStores: [{ identifier: "store", queryable }] },
        }),
      ).success,
    ).toBe(true);
  }
});
