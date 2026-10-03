import { FakeKeystoreDiscovery } from "../fakes/FakeKeystoreDiscovery";
import { afterEach, describe, expect, test } from "bun:test";
import {
  registerStorageCapabilityResources,
  resolveDeviceType,
  resolveStorageCapabilityContext,
} from "../../src/server/storageCapabilityResources";
import { registerStorageResources } from "../../src/server/storageResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { BootedDevice } from "../../src/models";
import type { StorageCapabilityDependencies } from "../../src/server/storageCapabilityResources";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { AndroidUserTargetUnavailableError } from "../../src/utils/android-cmdline-tools/AndroidUserTargetResolver";

// Like storageResources, the handler builds a URI, resolves a booted device, and
// returns a JSON envelope. With no booted device it returns "device not found"
// without touching any CtrlProxy client — so URI matching, the not-found path,
// and the happy path (via a seeded FakeDeviceManager) exercise with only a fake:
// no DB, no clock, no device, no sockets.
describe("storageCapabilityResources", () => {
  const androidEmulator: BootedDevice = {
    name: "Pixel_7",
    platform: "android",
    deviceId: "emulator-5554",
  };
  const iosPhysical: BootedDevice = {
    name: "iPhone",
    platform: "ios",
    // 25-char device UDID (not a simulator UUID) => physical.
    deviceId: "00008110-000A1B2C3D4E5F60",
  };

  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
    ResourceRegistry.clearResources();
  });

  function setDevices(
    devices: BootedDevice[],
    dependencies: StorageCapabilityDependencies = {
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      createKeystoreDiscovery: () => new FakeKeystoreDiscovery(),
      createUserResolver: () => ({
        resolve: async () => ({ userId: 0, source: "currentUser" }),
      }),
    },
  ): void {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], devices));
    registerStorageCapabilityResources(dependencies);
  }

  function readResource(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match) {
      throw new Error(`no template matched: ${uri}`);
    }
    return match.template.handler(match.params);
  }

  test.each([
    "ok",
    "disabled",
    "unavailable",
    "unsupported",
    "locked",
    "authentication_required",
  ] as const)("Keystore discovery reports typed %s outcome", async (outcome) => {
    const previous = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(true);
    try {
      const fake = new FakeKeystoreDiscovery();
      fake.state.outcome = outcome;
      if (outcome === "unavailable") {
        fake.state.reason = "BRIDGE_NOT_INSTALLED";
        fake.state.bridgeAvailable = false;
      }
      setDevices([androidEmulator], {
        adbFactory: new FakeAdbClientFactory(),
        createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "currentUser" }) }),
        createKeystoreDiscovery: () => fake,
      });
      const content = await readResource(
        "automobile:devices/emulator-5554/storage/capabilities?appId=com.x",
      );
      const body = JSON.parse(content.text ?? "{}");
      expect(
        body.domains.find((d: { domain: string }) => d.domain === "secure_state").capabilities,
      ).toEqual([fake.state]);
      expect(fake.calls).toEqual(["com.x"]);
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });

  test("failed Keystore transport becomes unavailable while other capabilities remain", async () => {
    const previous = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(true);
    try {
      const fake = new FakeKeystoreDiscovery();
      fake.failure = new Error("transport down");
      setDevices([androidEmulator], {
        adbFactory: new FakeAdbClientFactory(),
        createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "currentUser" }) }),
        createKeystoreDiscovery: () => fake,
      });
      const content = await readResource(
        "automobile:devices/emulator-5554/storage/capabilities?appId=com.x",
      );
      const body = JSON.parse(content.text ?? "{}");
      expect(body.domains).toHaveLength(6);
      const state = body.domains.find((d: { domain: string }) => d.domain === "secure_state")
        .capabilities[0];
      expect(state.outcome).toBe("unavailable");
      expect(state.reason).toBe("BRIDGE_UNAVAILABLE");
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });

  test("Keystore discovery requires app scope and enabled SDK and Android", async () => {
    const previous = serverConfig.isEmbeddedSdkEnabled();
    const fake = new FakeKeystoreDiscovery();
    try {
      setDevices([androidEmulator, iosPhysical], {
        adbFactory: new FakeAdbClientFactory(),
        createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "currentUser" }) }),
        createKeystoreDiscovery: () => fake,
      });
      serverConfig.setEmbeddedSdkEnabled(true);
      await readResource("automobile:devices/emulator-5554/storage/capabilities");
      await readResource(
        `automobile:devices/${iosPhysical.deviceId}/storage/capabilities?appId=com.x`,
      );
      serverConfig.setEmbeddedSdkEnabled(false);
      await readResource("automobile:devices/emulator-5554/storage/capabilities?appId=com.x");
      expect(fake.calls).toEqual([]);
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });

  test("registers a single query-variant template that matches bare and app-scoped URIs", () => {
    setDevices([]);
    const templates = ResourceRegistry.getAllTemplates().filter((t) =>
      t.uriTemplate.includes("storage/capabilities"),
    );
    expect(templates.map((t) => t.uriTemplate)).toEqual([
      "automobile:devices/{deviceId}/storage/capabilities{?appId}",
    ]);
    // Both the bare and the ?appId= form resolve to this template.
    expect(
      ResourceRegistry.matchTemplate("automobile:devices/dev1/storage/capabilities"),
    ).toBeDefined();
    expect(
      ResourceRegistry.matchTemplate("automobile:devices/dev1/storage/capabilities?appId=com.x"),
    ).toBeDefined();
  });

  test("capabilities URI is not shadowed by the sibling storage files/entries templates", async () => {
    // Register the sibling storage resources first (as src/server/index.ts does),
    // then the capability resource. The FILES/ENTRIES templates require a trailing
    // /files or /{fileName}/entries segment, so the capabilities URI must still
    // route to this handler regardless of registration order. Guards against a
    // future template on this prefix greedily capturing `capabilities`.
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], []));
    registerStorageResources();
    registerStorageCapabilityResources({ adbFactory: new FakeAdbClientFactory() });
    const content = await readResource("automobile:devices/emulator-5554/storage/capabilities");
    const body = JSON.parse(content.text ?? "{}");
    // The capability handler emits schemaVersion; the files/entries handlers do not.
    expect(body.schemaVersion).toBe(1);
  });

  test("reports device-not-found when no device is booted", async () => {
    setDevices([]);
    const content = await readResource("automobile:devices/emulator-5554/storage/capabilities");
    const body = JSON.parse(content.text ?? "{}");
    expect(content.mimeType).toBe("application/json");
    expect(body.error).toBe("Device not found or not booted: emulator-5554");
    // The versioned envelope is present even in the error case.
    expect(body.schemaVersion).toBe(1);
  });

  test("returns a versioned capability report for a booted Android emulator", async () => {
    const previous = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(true);
    try {
      setDevices([androidEmulator]);
      const content = await readResource(
        "automobile:devices/emulator-5554/storage/capabilities?appId=com.example.app",
      );
      const body = JSON.parse(content.text ?? "{}");
      expect(body.deviceId).toBe("emulator-5554");
      expect(body.schemaVersion).toBe(1);
      expect(body.platform).toBe("android");
      expect(body.deviceType).toBe("emulator");
      expect(body.appId).toBe("com.example.app");
      expect(body.context.embeddedSdk).toBe(true);
      // key_value write is supported once the SDK + session are present.
      const keyValue = body.domains.find((d: { domain: string }) => d.domain === "key_value");
      const write = keyValue.operations.find((o: { operation: string }) => o.operation === "write");
      expect(write.state).toBe("supported");
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });

  test("physical iOS device qualifies app-container access as unsupported", async () => {
    setDevices([iosPhysical]);
    const content = await readResource(
      "automobile:devices/00008110-000A1B2C3D4E5F60/storage/capabilities",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(body.platform).toBe("ios");
    expect(body.deviceType).toBe("physical");
    const appContainers = body.domains.find(
      (d: { domain: string }) => d.domain === "app_containers",
    );
    for (const op of appContainers.operations) {
      expect(op.state).toBe("unsupported");
    }
  });

  test("iOS Simulator user_files reports pending installation without claiming picker visibility", async () => {
    const simulator = { ...iosPhysical, deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" };
    setDevices([simulator]);
    const body = JSON.parse(
      (await readResource(`automobile:devices/${simulator.deviceId}/storage/capabilities`)).text ??
        "{}",
    );
    const userFiles = body.domains.find(
      (domain: { domain: string }) => domain.domain === "user_files",
    );
    expect(userFiles.operations.map((op: { state: string }) => op.state)).toEqual([
      "unavailable",
      "unavailable",
      "partial",
      "partial",
      "unsupported",
    ]);
    expect(userFiles.note).toContain("picker visibility");
    expect(body.context.iosFilesFixtureInstalled).toBeUndefined();
  });

  test("iOS Simulator user_files is unavailable with no registered write provider", async () => {
    const simulator = { ...iosPhysical, deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" };
    setDevices([simulator], { appFileCoverage: { describeProviderCoverage: () => [] } });
    const body = JSON.parse(
      (await readResource(`automobile:devices/${simulator.deviceId}/storage/capabilities`)).text ??
        "{}",
    );
    const userFiles = body.domains.find(
      (domain: { domain: string }) => domain.domain === "user_files",
    );
    expect(userFiles.operations.map((op: { state: string }) => op.state)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unsupported",
    ]);
  });

  test("resolveDeviceType classifies device identities", () => {
    expect(resolveDeviceType(androidEmulator)).toBe("emulator");
    expect(resolveDeviceType({ name: "d", platform: "android", deviceId: "1A2B3C4D" })).toBe(
      "physical",
    );
    expect(resolveDeviceType(iosPhysical)).toBe("physical");
    expect(
      resolveDeviceType({
        name: "sim",
        platform: "ios",
        deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      }),
    ).toBe("simulator");
  });

  test("resolveStorageCapabilityContext reflects server SDK config and booted session", () => {
    const previous = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(false);
    try {
      const ctx = resolveStorageCapabilityContext(androidEmulator, "com.x", true);
      expect(ctx.platform).toBe("android");
      expect(ctx.deviceType).toBe("emulator");
      expect(ctx.embeddedSdk).toBe(false);
      expect(ctx.sessionActive).toBe(true);
      expect(ctx.appId).toBe("com.x");
      expect(ctx.activeUserProfile).toBe(true);
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });

  test("probes the current Android user and supports shared-storage operations", async () => {
    const adb = new FakeAdbExecutor();
    // Captured current-user output reused from AndroidUserTargetResolver.test.ts.
    adb.setCommandResponse("am get-current-user", {
      stdout: "0",
      stderr: "",
      toString: () => "0",
      trim: () => "0",
      includes: (value) => value === "0",
    });
    const factory = new FakeAdbClientFactory(adb);
    setDevices([androidEmulator], { adbFactory: factory });
    const content = await readResource("automobile:devices/emulator-5554/storage/capabilities");
    const body = JSON.parse(content.text ?? "{}");
    expect(factory.wasCalledForDevice(androidEmulator.deviceId)).toBe(true);
    expect(adb.getExecutedCommands()).toEqual(["shell am get-current-user"]);
    expect(body.context.activeUserProfile).toBe(true);
    const userFiles = body.domains.find(
      (domain: { domain: string }) => domain.domain === "user_files",
    );
    expect(userFiles.operations.map((operation: { state: string }) => operation.state)).toEqual([
      "supported",
      "supported",
      "supported",
      "supported",
      "supported",
    ]);
  });

  test("injected provider coverage controls capability resources independently of shared reads", async () => {
    const coverageCalls: string[] = [];
    setDevices([androidEmulator], {
      adbFactory: new FakeAdbClientFactory(),
      createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "currentUser" }) }),
      appFileCoverage: {
        describeProviderCoverage: () => {
          coverageCalls.push("providers");
          return [];
        },
      },
      sharedStorageReadCoverage: (platform) => {
        coverageCalls.push(platform);
        return { list: true, read: false };
      },
    });
    const content = await readResource("automobile:devices/emulator-5554/storage/capabilities");
    const body = JSON.parse(content.text ?? "{}");
    const userFiles = body.domains.find(
      (domain: { domain: string }) => domain.domain === "user_files",
    );
    expect(userFiles.operations.map((operation: { state: string }) => operation.state)).toEqual([
      "supported",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(coverageCalls).toEqual(["providers", "android"]);
    expect(userFiles.operations[1].reason).toContain("SharedStorageReadService read provider");
  });

  test("reports unavailable when no Android user can be selected", async () => {
    setDevices([androidEmulator], {
      adbFactory: new FakeAdbClientFactory(),
      createUserResolver: () => ({
        resolve: async () => {
          throw new AndroidUserTargetUnavailableError("no selectable user");
        },
      }),
    });
    const content = await readResource("automobile:devices/emulator-5554/storage/capabilities");
    const body = JSON.parse(content.text ?? "{}");
    expect(body.context.activeUserProfile).toBe(false);
    const userFiles = body.domains.find(
      (domain: { domain: string }) => domain.domain === "user_files",
    );
    expect(userFiles.operations.map((operation: { state: string }) => operation.state)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  test("keeps the profile unverified when the device probe fails", async () => {
    setDevices([androidEmulator], {
      adbFactory: new FakeAdbClientFactory(),
      createUserResolver: () => ({
        resolve: async () => {
          throw new Error("adb disconnected");
        },
      }),
    });
    const content = await readResource("automobile:devices/emulator-5554/storage/capabilities");
    const body = JSON.parse(content.text ?? "{}");
    expect(body.context.activeUserProfile).toBeUndefined();
    const userFiles = body.domains.find(
      (domain: { domain: string }) => domain.domain === "user_files",
    );
    expect(userFiles.operations.map((operation: { state: string }) => operation.state)).toEqual([
      "partial",
      "partial",
      "partial",
      "partial",
      "partial",
    ]);
  });

  test("does not probe iOS devices", async () => {
    const factory = new FakeAdbClientFactory();
    setDevices([iosPhysical], { adbFactory: factory });
    const content = await readResource(
      "automobile:devices/00008110-000A1B2C3D4E5F60/storage/capabilities",
    );
    expect(JSON.parse(content.text ?? "{}").context.activeUserProfile).toBeUndefined();
    expect(factory.getCallCount()).toBe(0);
  });

  // Regression: the resource registry already percent-decodes query params via
  // URLSearchParams, so the handler must NOT decode appId a second time (#5686).
  describe("appId query param is not double-decoded (#5686)", () => {
    test("registry hands the handler an already-decoded query param (mechanism)", () => {
      setDevices([androidEmulator]);
      const match = ResourceRegistry.matchTemplate(
        "automobile:devices/emulator-5554/storage/capabilities?appId=%2541",
      );
      // URI value %2541 → registry decodes once → "%41". A handler decode would
      // wrongly turn this into "A".
      expect(match?.params.appId).toBe("%41");
    });

    test("a %-bearing appId round-trips through the report (identity contract)", async () => {
      const previous = serverConfig.isEmbeddedSdkEnabled();
      serverConfig.setEmbeddedSdkEnabled(true);
      try {
        setDevices([androidEmulator]);
        const intended = "%41";
        const content = await readResource(
          `automobile:devices/emulator-5554/storage/capabilities?appId=${encodeURIComponent(intended)}`,
        );
        const body = JSON.parse(content.text ?? "{}");
        expect(body.appId).toBe(intended);
      } finally {
        serverConfig.setEmbeddedSdkEnabled(previous);
      }
    });

    test("a literal-% appId returns a graceful JSON envelope, not an unhandled throw", async () => {
      setDevices([androidEmulator]);
      // URI value 100%25 → registry decodes → "100%". A second decodeURIComponent
      // would throw URIError outside the try/catch, bypassing the error envelope.
      const content = await readResource(
        "automobile:devices/emulator-5554/storage/capabilities?appId=100%25",
      );
      expect(content.mimeType).toBe("application/json");
      const body = JSON.parse(content.text ?? "{}");
      expect(body.appId).toBe("100%");
    });
  });
});
