import { afterEach, describe, expect, test } from "bun:test";
import {
  registerDataStoreResources,
  clearDataStoreResourceCacheForTesting,
  type DataStoreResourceReader,
} from "../../src/server/dataStoreResources";
import { registerStorageResources } from "../../src/server/storageResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { BootedDevice } from "../../src/models";
import type { PreferenceFile, KeyValueEntry } from "../../src/features/storage/storageTypes";

// DataStore resources project the existing Android DataStore CtrlProxy chain
// (AndroidCtrlProxyClient.listDataStores / getDataStore) into the MCP storage
// resource family (issue #5603). The read path is injected via a
// DataStoreResourceReader so routing, typed diagnostics, and update behavior are
// exercised with only a FakeDeviceManager + fake reader — no DB, clock, or socket.
describe("dataStoreResources", () => {
  const androidEmulator: BootedDevice = {
    name: "Pixel_7",
    platform: "android",
    deviceId: "emulator-5554",
  };
  const iosSimulator: BootedDevice = {
    name: "iPhone",
    platform: "ios",
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  };

  const LIST_URI =
    "automobile:devices/emulator-5554/storage/com.example.app/datastore/settings/stores";
  const ENTRIES_URI =
    "automobile:devices/emulator-5554/storage/com.example.app/datastore/settings/user_prefs/entries";

  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
    ResourceRegistry.clearResources();
    clearDataStoreResourceCacheForTesting();
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  function setup(devices: BootedDevice[], reader?: Partial<DataStoreResourceReader>): void {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], devices));
    const fullReader: DataStoreResourceReader = {
      listDataStores: reader?.listDataStores ?? (async () => []),
      getDataStore: reader?.getDataStore ?? (async () => []),
    };
    registerDataStoreResources(fullReader);
  }

  function readResource(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match) {
      throw new Error(`no template matched: ${uri}`);
    }
    return match.template.handler(match.params);
  }

  async function readBody(uri: string): Promise<Record<string, unknown>> {
    const content = await readResource(uri);
    expect(content.mimeType).toBe("application/json");
    return JSON.parse(content.text ?? "{}");
  }

  // --- Routing (AC3) ---------------------------------------------------------

  test("registers both DataStore templates and routes their URIs", () => {
    setup([]);
    const templates = ResourceRegistry.getAllTemplates()
      .map((t) => t.uriTemplate)
      .filter((t) => t.includes("/datastore/"));
    expect(templates).toEqual([
      "automobile:devices/{deviceId}/storage/{packageName}/datastore/{adapterName}/stores",
      "automobile:devices/{deviceId}/storage/{packageName}/datastore/{adapterName}/{storeName}/entries",
    ]);
    expect(ResourceRegistry.matchTemplate(LIST_URI)).toBeDefined();
    expect(ResourceRegistry.matchTemplate(ENTRIES_URI)).toBeDefined();
  });

  test("DataStore URIs are not shadowed by the sibling storage files/entries templates", () => {
    // Register the key-value storage resources first (as src/server/index.ts
    // does), then the DataStore resources. The extra /datastore/ segments must
    // keep DataStore URIs from matching the shorter files/entries templates.
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], []));
    registerStorageResources();
    registerDataStoreResources();
    const listMatch = ResourceRegistry.matchTemplate(LIST_URI);
    const entriesMatch = ResourceRegistry.matchTemplate(ENTRIES_URI);
    expect(listMatch?.template.uriTemplate).toContain("/datastore/");
    expect(entriesMatch?.template.uriTemplate).toContain("/datastore/");
  });

  test("params are percent-decoded and the canonical URI round-trips", async () => {
    setup([]);
    const uri =
      "automobile:devices/dev1/storage/com.example%20app/datastore/my%20adapter/my%20store/entries";
    const content = await readResource(uri);
    expect(content.uri).toBe(uri);
  });

  // --- Enumerate + read happy path (AC1) -------------------------------------

  test("enumerates DataStore instances for a booted Android device", async () => {
    serverConfig.setEmbeddedSdkEnabled(true);
    const stores: PreferenceFile[] = [
      { name: "user_prefs", path: "", entryCount: 3 },
      { name: "flags", path: "", entryCount: 1 },
    ];
    setup([androidEmulator], { listDataStores: async () => stores });
    const body = await readBody(LIST_URI);
    expect(body.status).toBe("available");
    expect(body.kind).toBe("datastore");
    expect(body.deviceId).toBe("emulator-5554");
    expect(body.packageName).toBe("com.example.app");
    expect(body.adapterName).toBe("settings");
    expect(body.platform).toBe("android");
    expect(body.stores).toEqual(stores);
    expect(body.totalCount).toBe(2);
    // Capability integration: key_value list is supported once the SDK is present.
    expect((body.capability as { state: string }).state).toBe("supported");
  });

  test("reads entries from a named DataStore instance", async () => {
    serverConfig.setEmbeddedSdkEnabled(true);
    const entries: KeyValueEntry[] = [
      { key: "theme", value: '"dark"', type: "STRING" },
      { key: "count", value: "5", type: "INT" },
    ];
    const captured: string[] = [];
    setup([androidEmulator], {
      getDataStore: async (_device, packageName, adapterName, storeName) => {
        captured.push(packageName, adapterName, storeName);
        return entries;
      },
    });
    const body = await readBody(ENTRIES_URI);
    expect(body.status).toBe("available");
    expect(body.kind).toBe("datastore");
    expect(body.adapterName).toBe("settings");
    expect(body.name).toBe("user_prefs");
    expect(body.entries).toEqual(entries);
    expect(body.totalCount).toBe(2);
    expect(captured).toEqual(["com.example.app", "settings", "user_prefs"]);
  });

  // --- Typed diagnostics (AC2 + AC3) -----------------------------------------

  test("reports unavailable when the device is not booted", async () => {
    setup([]);
    const body = await readBody(LIST_URI);
    expect(body.status).toBe("unavailable");
    expect(body.kind).toBe("datastore");
    expect(body.reason).toContain("emulator-5554");
  });

  test("reports unsupported on iOS (DataStore is Android-only)", async () => {
    serverConfig.setEmbeddedSdkEnabled(true);
    setup([iosSimulator]);
    const body = await readBody(
      "automobile:devices/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/storage/com.example.app/datastore/settings/stores",
    );
    expect(body.status).toBe("unsupported");
    expect(body.kind).toBe("datastore");
    expect(String(body.reason)).toContain("Android");
  });

  test("reports disabled when the embedded SDK is not enabled", async () => {
    serverConfig.setEmbeddedSdkEnabled(false);
    // The reader must never be called when the SDK is disabled.
    let called = false;
    setup([androidEmulator], {
      listDataStores: async () => {
        called = true;
        return [];
      },
    });
    const body = await readBody(LIST_URI);
    expect(body.status).toBe("disabled");
    expect(body.kind).toBe("datastore");
    expect(called).toBe(false);
    expect(body.capability).toBeDefined();
  });

  test("reports unavailable when the adapter/app integration is absent (read throws)", async () => {
    serverConfig.setEmbeddedSdkEnabled(true);
    setup([androidEmulator], {
      listDataStores: async () => {
        throw new Error("No DataStore adapter registered under 'settings'");
      },
    });
    const body = await readBody(LIST_URI);
    expect(body.status).toBe("unavailable");
    expect(body.kind).toBe("datastore");
    expect(String(body.reason)).toContain("adapter");
  });

  // --- Update behavior (AC3) -------------------------------------------------

  test("notifies subscribers when the DataStore listing changes between reads", async () => {
    serverConfig.setEmbeddedSdkEnabled(true);
    let call = 0;
    setup([androidEmulator], {
      listDataStores: async () => {
        call += 1;
        return call === 1
          ? [{ name: "user_prefs", path: "", entryCount: 1 }]
          : [{ name: "user_prefs", path: "", entryCount: 2 }];
      },
    });

    const notify = [] as string[];
    const original = ResourceRegistry.notifyResourceUpdated;
    ResourceRegistry.notifyResourceUpdated = (async (uri: string) => {
      notify.push(uri);
    }) as typeof ResourceRegistry.notifyResourceUpdated;
    try {
      await readResource(LIST_URI); // seeds cache, no notify
      expect(notify).toEqual([]);
      await readResource(LIST_URI); // changed data -> notify
      expect(notify).toEqual([LIST_URI]);
    } finally {
      ResourceRegistry.notifyResourceUpdated = original;
    }
  });
});
