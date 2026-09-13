import { afterEach, describe, expect, test } from "bun:test";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { registerStorageResources } from "../../src/server/storageResources";
import { getLocalizationResource } from "../../src/server/localizationResources";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice } from "../../src/models";

/**
 * A device-addressed MCP resource read is device-addressed WORK: it discovers the
 * serial and then reads that runtime's preferences, databases, DataStore
 * contents, app files, locale or shared storage. Exempting resources from the two
 * funnels on the grounds that they "publish no pooled identity" confused not
 * PUBLISHING a pooled label with not ACTING on a pooled identity, so a URI naming
 * AVD A could return replacement B's data, and a resource read that was the FIRST
 * discovery to see the placeholder never quarantined the pool
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
describe("device-addressed resource reads pass both funnels", () => {
  const SERIAL = "emulator-5554";
  const DEVICE: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };

  afterEach(() => {
    PlatformDeviceManagerFactory.reset();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    AndroidCtrlProxyClient.resetInstances();
  });

  async function livePool(): Promise<DevicePool> {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [DEVICE]);
    const pool = new DevicePool(manager, "daemon-test", timer, undefined, utils);
    await pool.initializeWithDevices([DEVICE]);
    DaemonState.getInstance().initialize(manager, pool);
    return pool;
  }

  // FUNNEL 1.
  test("quarantines the pool when a resource read is the first to see the placeholder", async () => {
    const pool = await livePool();
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ ...DEVICE, name: `Unknown (${SERIAL})` }]),
    );

    await getLocalizationResource(SERIAL, () => ({
      getLocalizationSettings: async () => ({ success: true }),
    }));

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  // FUNNEL 2, reached through the device-client seam rather than a per-resource
  // gate: the read resolves the serial to a CtrlProxy client, and that binding is
  // refused.
  test("refuses to read a storage resource addressed to a quarantined serial", async () => {
    const pool = await livePool();
    await pool.reconcileDiscoveryObservation(
      [{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }],
      "test",
    );
    // Discovery still sees the serial; what it cannot read is the AVD name, which
    // is exactly the state the quarantine describes.
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ ...DEVICE, name: `Unknown (${SERIAL})` }]),
    );
    registerStorageResources();
    const uri = `automobile:devices/${SERIAL}/storage/com.example/files`;
    const matched = ResourceRegistry.matchTemplate(uri);
    expect(matched).toBeDefined();

    const content = await matched!.template.handler(matched!.params);

    expect(JSON.parse(content.text ?? "{}").error).toMatch(/identity is unresolved/);
  });
});
