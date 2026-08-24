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

  function setDevices(devices: BootedDevice[]): void {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], devices));
    registerStorageCapabilityResources();
  }

  function readResource(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match) {
      throw new Error(`no template matched: ${uri}`);
    }
    return match.template.handler(match.params);
  }

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
    registerStorageCapabilityResources();
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
      const ctx = resolveStorageCapabilityContext(androidEmulator, "com.x");
      expect(ctx.platform).toBe("android");
      expect(ctx.deviceType).toBe("emulator");
      expect(ctx.embeddedSdk).toBe(false);
      expect(ctx.sessionActive).toBe(true);
      expect(ctx.appId).toBe("com.x");
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });
});
