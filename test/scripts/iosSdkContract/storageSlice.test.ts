import { describe, expect, test } from "bun:test";
import {
  parseIosStorageDiscovery,
  unavailableIosStorageDiscovery,
  type IosStorageDiscovery,
} from "../../../src/features/storage/iosStorageDiscovery";
import { computeStorageCapabilities } from "../../../src/features/storage/storageCapabilities";
import type {
  SdkContractManifest,
  StorageRegistration,
} from "../../../scripts/ios/sdk-contract/manifest";
import {
  expectedKeychain,
  judgeStorageReport,
  judgeUnreachableStorageReport,
} from "../../../scripts/ios/sdk-contract/storageSlice";

const suite = "group.contract.run-1";
const coordinatedSuite = "group.contract.coordinated.run-1";

/** What the Swift scenario records for the registered configuration (sorted-key JSON order). */
const registered: StorageRegistration = {
  allowKeychainDeletion: true,
  keychainEntries: [
    { accessGroup: "contract.group", account: "contract-run-1", service: "contract" },
  ],
  uncoordinatedSuites: [suite],
  hostCoordinatedSuites: [coordinatedSuite],
  coreDataStores: [
    { identifier: "ContractPrivate-run-1" },
    { identifier: "ContractShared-run-1", appGroup: suite, coordination: "host_coordinated" },
  ],
  secretWritten: true,
};

const defaults: StorageRegistration = {
  allowKeychainDeletion: false,
  keychainEntries: [],
  uncoordinatedSuites: [],
  hostCoordinatedSuites: [],
  coreDataStores: [],
  secretWritten: false,
};

function manifest(scenario: string, storage?: StorageRegistration): SdkContractManifest {
  return {
    schemaVersion: 4,
    runId: "run-1",
    scenario,
    status: "complete",
    network: [],
    faults: [],
    storage,
    events: [],
    undecodableBatches: 0,
  };
}

/** The SDK payload the Swift route encodes for the registered configuration. */
const registeredSdkPayload = {
  keychain: {
    schemaVersion: 1,
    capability: "storage.keychain",
    inspection: "unavailable",
    deletion: "enabled",
    deletionScopes: [
      {
        itemClass: "genericPassword",
        service: "contract",
        account: "contract-run-1",
        accessGroup: "contract.group",
      },
    ],
  },
  stores: [
    {
      kind: "user_defaults_suite",
      identifier: coordinatedSuite,
      sharing: "app_group",
      appGroup: coordinatedSuite,
      coordination: "host_coordinated",
      query: "supported",
    },
    {
      kind: "user_defaults_suite",
      identifier: suite,
      sharing: "app_group",
      appGroup: suite,
      coordination: "uncoordinated",
      query: "supported",
    },
    {
      kind: "core_data",
      identifier: "ContractPrivate-run-1",
      sharing: "app_private",
      coordination: "single_process",
      query: "unsupported",
      reason: "core_data_query_unavailable",
    },
    {
      kind: "core_data",
      identifier: "ContractShared-run-1",
      sharing: "app_group",
      appGroup: suite,
      coordination: "host_coordinated",
      query: "unsupported",
      reason: "core_data_query_unavailable",
    },
  ],
};

/** The MCP resource exactly as the daemon builds it from an SDK discovery. */
function report(iosStorage: IosStorageDiscovery): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(
      computeStorageCapabilities({
        providerCoverage: [],
        platform: "ios",
        deviceType: "simulator",
        embeddedSdk: true,
        sessionActive: true,
        iosStorage,
        appId: "dev.jasonpearson.automobile.Playground",
      }),
    ),
  );
}

describe("storage slice (#5164 phase D)", () => {
  test("the registered configuration matches at every field", () => {
    const live = report(parseIosStorageDiscovery(registeredSdkPayload));
    expect(judgeStorageReport(manifest("storage", registered), live)).toEqual([]);
  });

  test("the default configuration reports deletion disabled and no stores", () => {
    const live = report(
      parseIosStorageDiscovery({
        keychain: {
          ...registeredSdkPayload.keychain,
          deletion: "disabled",
          reason: "DISABLED",
          deletionScopes: [],
        },
        stores: [],
      }),
    );
    expect(expectedKeychain(defaults)).toEqual({
      deletion: "disabled",
      reason: "DISABLED",
      deletionScopes: [],
    });
    expect(judgeStorageReport(manifest("storage-default", defaults), live)).toEqual([]);
  });

  test("a wrong coordination and an unexpected store name the SDK adapter", () => {
    const stores = registeredSdkPayload.stores.map((store) =>
      store.identifier === suite ? { ...store, coordination: "host_coordinated" } : store,
    );
    const live = report(
      parseIosStorageDiscovery({
        ...registeredSdkPayload,
        stores: [...stores, { ...stores[0], identifier: "group.other", appGroup: "group.other" }],
      }),
    );
    const findings = judgeStorageReport(manifest("storage", registered), live);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ caseName: "stores", boundary: "sdk-adapter" });
    expect(findings[0].message).toContain(`${suite} coordination host_coordinated`);
    expect(findings[0].message).toContain("unexpected store group.other");
  });

  test("a deletion scope the host did not allowlist names the SDK adapter", () => {
    const live = report(
      parseIosStorageDiscovery({
        ...registeredSdkPayload,
        keychain: {
          ...registeredSdkPayload.keychain,
          deletionScopes: [
            { ...registeredSdkPayload.keychain.deletionScopes[0], account: "other" },
          ],
        },
      }),
    );
    expect(judgeStorageReport(manifest("storage", registered), live)).toEqual([
      expect.objectContaining({ caseName: "keychain", boundary: "sdk-adapter" }),
    ]);
  });

  test("an unreachable or unparsable SDK names the endpoint or the serialization", () => {
    expect(
      judgeStorageReport(manifest("storage", registered), report(unavailableIosStorageDiscovery())),
    ).toEqual([expect.objectContaining({ boundary: "sdk-endpoint" })]);
    expect(
      judgeStorageReport(manifest("storage", registered), report(parseIosStorageDiscovery({}))),
    ).toEqual([expect.objectContaining({ boundary: "sdk-serialization" })]);
  });

  test("a stored value anywhere in the resource is a leak", () => {
    const live = report(parseIosStorageDiscovery(registeredSdkPayload));
    const leaked = { ...live, note: "contract-storage-secret" };
    expect(judgeStorageReport(manifest("storage", registered), leaked)).toEqual([
      expect.objectContaining({ caseName: "redaction", boundary: "mcp-surface" }),
    ]);
  });

  test("a manifest without a registration is a fixture-host failure", () => {
    expect(judgeStorageReport(manifest("storage"), {})).toEqual([
      expect.objectContaining({ boundary: "fixture-host" }),
    ]);
  });

  test("after the app is gone the SDK is unreachable and no store state survives", () => {
    expect(
      judgeUnreachableStorageReport("storage", report(unavailableIosStorageDiscovery())),
    ).toEqual([]);
    const stale = report(parseIosStorageDiscovery(registeredSdkPayload));
    expect(judgeUnreachableStorageReport("storage", stale)).toEqual([
      expect.objectContaining({ caseName: "unreachable", boundary: "ios-client" }),
    ]);
  });
});
