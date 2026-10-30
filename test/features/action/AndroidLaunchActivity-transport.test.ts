import { expect, test } from "bun:test";
import { AndroidLaunchActivity } from "../../../src/features/action/AndroidLaunchActivity";
import { AdbDeviceTransportUnavailableError } from "../../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { DefaultPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

test.each([false, "unknown"] as const)(
  "Android launch stops before fallback mutations with dispatch %s",
  async (dispatched) => {
    const adb = new FakeAdbExecutor();
    const typed = new AdbDeviceTransportUnavailableError(
      "emulator-5554",
      new Error("device offline"),
      1000,
      dispatched,
    );
    adb.setCommandError("resolve-activity", typed);
    const launch = new AndroidLaunchActivity({
      device: { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
      adb,
      failFastWhenPackageRemoved: async () => {},
    });
    await expect(
      launch.performLaunch("com.example.app", undefined, 0, {
        perf: new DefaultPerformanceTracker(new FakeTimer()),
      }),
    ).rejects.toBe(typed);
    expect(adb.getExecutedCommands()).toHaveLength(1);
  },
);
