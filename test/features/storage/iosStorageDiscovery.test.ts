import { describe, expect, test } from "bun:test";
import {
  parseIosStorageDiscovery,
  unavailableIosStorageDiscovery,
  type KeychainCapabilityState,
  type StoreState,
} from "../../../src/features/storage/iosStorageDiscovery";

// Shape the SDK's storage_capabilities payload carries (#5161).
const enabledKeychain = {
  schemaVersion: 1,
  capability: "storage.keychain",
  inspection: "unavailable",
  deletion: "enabled",
  reason: null,
  deletionScopes: [
    {
      itemClass: "genericPassword",
      service: "fixture.service",
      account: "fixture.account",
      accessGroup: "TEAMID.fixture",
    },
  ],
} satisfies KeychainCapabilityState;

const stores: StoreState[] = [
  {
    kind: "user_defaults_suite",
    identifier: "group.fixture",
    sharing: "app_group",
    appGroup: "group.fixture",
    coordination: "host_coordinated",
    query: "supported",
  },
  {
    kind: "core_data",
    identifier: "Main",
    sharing: "app_private",
    coordination: "single_process",
    query: "unsupported",
    reason: "core_data_query_unavailable",
  },
];

describe("parseIosStorageDiscovery", () => {
  test("reads the Keychain capability and store states from the SDK payload", () => {
    const discovery = parseIosStorageDiscovery({
      readOnly: true,
      keychain: enabledKeychain,
      stores,
    });
    expect(discovery.keychain).toEqual(enabledKeychain);
    expect(discovery.stores).toEqual(stores);
  });

  test("never carries fields outside the contract, so no Keychain value can pass through", () => {
    const leaky = {
      keychain: {
        ...enabledKeychain,
        value: "secret-bytes",
        deletionScopes: [{ ...enabledKeychain.deletionScopes[0], password: "secret-bytes" }],
      },
      stores: [{ ...stores[0], contents: { token: "secret-bytes" } }],
    };
    const discovery = parseIosStorageDiscovery(leaky);
    expect(JSON.stringify(discovery)).not.toContain("secret-bytes");
  });

  test("reports an SDK without the #5161 fields as too old rather than guessing", () => {
    const discovery = parseIosStorageDiscovery({
      readOnly: true,
      registeredAppGroupSuites: ["group.fixture"],
      unavailableStores: ["keychain"],
    });
    expect(discovery.keychain).toMatchObject({
      capability: "storage.keychain",
      deletion: "unknown",
      reason: "SDK_TOO_OLD",
      deletionScopes: [],
    });
    expect(discovery.stores).toEqual([]);
  });

  test("rejects a malformed Keychain capability instead of trusting it", () => {
    const discovery = parseIosStorageDiscovery({
      keychain: { ...enabledKeychain, deletion: "everything" },
      stores,
    });
    expect(discovery.keychain.deletion).toBe("unknown");
    expect(discovery.keychain.reason).toBe("SDK_TOO_OLD");
  });

  test("an unreachable SDK yields a typed unavailable state", () => {
    expect(unavailableIosStorageDiscovery()).toEqual({
      keychain: {
        schemaVersion: 1,
        capability: "storage.keychain",
        inspection: "unavailable",
        deletion: "unknown",
        reason: "BRIDGE_UNAVAILABLE",
        deletionScopes: [],
      },
      stores: [],
    });
  });
});
