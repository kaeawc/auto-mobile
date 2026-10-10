import { afterEach, expect, test } from "bun:test";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { BootedDevice } from "../../../src/models";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";

// Inventory contract: an unknown never fails open. iOS has two discovery sources (simctl and
// devicectl); the ide/* lookup refuses an absent serial only when the aggregate iOS platform
// failed, so a physical serial absent because devicectl failed (simctl fine) reads as a plain
// "Device not found" instead of the retryable discovery_incomplete refusal (#11122).

const simulator: BootedDevice = {
  platform: "ios",
  name: "iPhone 16",
  deviceId: "11111111-2222-3333-4444-555555555555",
};

afterEach(() => PlatformDeviceManagerFactory.setInstance(null));

test("a physical iOS serial absent from a devicectl-failed sweep is refused as discovery_incomplete", async () => {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("ios", [simulator]);
  manager.failedSources.add("ios-physical");
  PlatformDeviceManagerFactory.setInstance(manager);

  const lookup = (
    UnixSocketServer.prototype as unknown as {
      listBootedDevicesForIdeAction(platform: "ios", serial: string): Promise<BootedDevice[]>;
    }
  ).listBootedDevicesForIdeAction;

  await expect(lookup.call({}, "ios", "00008110-001A2B3C4D5E6F78")).rejects.toMatchObject({
    code: "discovery_incomplete",
  });
});
