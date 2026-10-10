import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import {
  InMemoryProvisionedDeviceTransportFence,
  resetProvisionedDeviceTransportFenceForTests,
  setProvisionedDeviceTransportFenceForTests,
} from "../../src/utils/provisionedDeviceTransportFence";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeWindow } from "../fakes/FakeWindow";

describe("DeviceSessionManager retired transport tombstones (#11134)", () => {
  afterEach(() => resetProvisionedDeviceTransportFenceForTests());

  function setup(liveName: string) {
    const live: BootedDevice = { deviceId: "emulator-5554", name: liveName, platform: "android" };
    const adb = new FakeAdbExecutor();
    adb.setDevices([live]);
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [live]);
    const fence = new InMemoryProvisionedDeviceTransportFence();
    setProvisionedDeviceTransportFenceForTests(fence);
    const window = new FakeWindow();
    window.configureActiveWindow({
      appId: "com.example.app",
      activityName: "MainActivity",
      layoutSeqSum: 0,
    });
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(adb, deviceUtils, new FakeSimctl() as never, { window }),
    );
    return { manager, fence };
  }

  test("a new emulator incarnation on a retired serial is usable and clears the tombstone", async () => {
    const { manager, fence } = setup("phone-api-36-b");
    await fence.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });

    // An aborted signal stops readiness right after the tombstone gate, which is all this
    // test exercises; the gate must not surface DeviceLostError for the new incarnation.
    const outcome = await manager
      .ensureDeviceReady("android", "emulator-5554", { signal: AbortSignal.abort() })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(outcome).not.toBeInstanceOf(DeviceLostError);
    expect(await fence.get("emulator-5554")).toBeUndefined();
  });

  test("the same retired incarnation stays fenced", async () => {
    const { manager, fence } = setup("phone-api-36-a");
    await fence.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });

    await expect(manager.ensureDeviceReady("android", "emulator-5554")).rejects.toThrow(
      DeviceLostError,
    );
  });
});
