import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

class FailingDiscoveryAdbExecutor extends FakeAdbExecutor {
  override async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    throw new Error("adb server unavailable");
  }
}

describe("AndroidEmulatorClient.getBootedDevicesChecked", () => {
  test("preserves transport identity when AVD-name lookup fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([{
      name: "ignored",
      platform: "android",
      deviceId: "emulator-5554",
      transportId: "42",
    } satisfies BootedDevice]);
    adb.setCommandError("emu avd name", new Error("emulator console unavailable"));
    const client = new AndroidEmulatorClient(null, null, new FakeTimer(), new FakeAdbClientFactory(adb));

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([{
      name: "Unknown (emulator-5554)",
      platform: "android",
      deviceId: "emulator-5554",
      transportId: "42",
      source: "local",
    }]);
  });

  test("propagates discovery failures during shutdown", async () => {
    const adb = new FailingDiscoveryAdbExecutor();
    const client = new AndroidEmulatorClient(null, null, new FakeTimer(), new FakeAdbClientFactory(adb));

    await expect(client.killDevice({
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    })).rejects.toThrow("adb server unavailable");
  });
});
