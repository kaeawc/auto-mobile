import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DefaultEmulatorBootUnlock } from "../../../src/utils/android-cmdline-tools/EmulatorBootUnlock";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DeviceLockStore } from "../../../src/devices/DeviceLockStore";
import type { AndroidUser, BootedDevice, DeviceLockState } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE: BootedDevice = { name: "test-avd", platform: "android", deviceId: "emulator-5554" };
const LOCKED_SWIPE: DeviceLockState = { locked: true, keyguardShowing: true, secure: false };
const UNLOCKED: DeviceLockState = { locked: false, keyguardShowing: false, secure: false };

const primaryUser = (startState: string): AndroidUser => ({
  userId: 0,
  name: "Owner",
  flags: 0x4c13,
  profileType: "primary",
  running: true,
  startState,
});

describe("DefaultEmulatorBootUnlock", () => {
  let adb: FakeAdbExecutor;
  let timer: FakeTimer;
  let unlock: DefaultEmulatorBootUnlock;
  let spies: Array<{ mockRestore(): void }>;

  beforeEach(() => {
    spies = [
      spyOn(DeviceLockStore.prototype, "getRecordedCredential").mockResolvedValue(null),
      spyOn(DeviceLockStore.prototype, "rememberLock").mockResolvedValue(undefined),
    ];
    adb = new FakeAdbExecutor();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    const factory: AdbClientFactory = { create: (): AdbExecutor => adb };
    unlock = new DefaultEmulatorBootUnlock({ timer: () => timer, adbFactory: () => factory });
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("wakes the device and dismisses a swipe keyguard", async () => {
    adb.setScreenState(false, "Asleep");
    adb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    await unlock.wakeAndUnlock(DEVICE);

    expect(adb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(adb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
  });

  test("polls until the primary user leaves RUNNING_LOCKED", async () => {
    adb.setDeviceLock(UNLOCKED);
    adb.setUsersSequence([[primaryUser("RUNNING_LOCKED")], [primaryUser("RUNNING_UNLOCKED")]]);

    await unlock.wakeAndUnlock(DEVICE);

    expect(timer.now()).toBe(250);
  });

  test("gives up waiting for the primary user after 5s without failing", async () => {
    adb.setDeviceLock(UNLOCKED);
    adb.setUsers([primaryUser("RUNNING_LOCKED")]);

    await expect(unlock.wakeAndUnlock(DEVICE)).resolves.toBeUndefined();

    expect(timer.now()).toBe(5_000);
  });

  test("an already-aborted signal rejects with the abort reason before any ADB call", async () => {
    adb.setDeviceLock(UNLOCKED);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(unlock.wakeAndUnlock(DEVICE, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("swallows a failed wake so a ready device is not reported as failed", async () => {
    adb.setScreenState(false, "Asleep");
    adb.setCommandError("KEYCODE_WAKEUP", new Error("adb exploded"));

    await expect(unlock.wakeAndUnlock(DEVICE)).resolves.toBeUndefined();
    expect(adb.wasCommandExecuted("wm dismiss-keyguard")).toBe(false);
  });
});
