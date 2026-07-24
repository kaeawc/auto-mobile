import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { ExecResult, BootedDevice, DeviceLockState } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * A factory that returns a single FakeAdbExecutor instance for all create() calls.
 */
class TestAdbClientFactory implements AdbClientFactory {
  constructor(private readonly fakeExecutor: FakeAdbExecutor) {}

  create(_device?: BootedDevice | null): AdbExecutor {
    return this.fakeExecutor;
  }
}

const LOCKED_SWIPE: DeviceLockState = { locked: true, keyguardShowing: true, secure: false };
const UNLOCKED: DeviceLockState = { locked: false, keyguardShowing: false, secure: false };
const DEVICE: BootedDevice = { name: "test-avd", platform: "android", deviceId: "emulator-5554" };

/**
 * The boot-time wakeAndUnlock delegates to the shared WakeAndUnlock feature
 * (#4360). It wakes an asleep device, and only issues `wm dismiss-keyguard` when
 * a keyguard is actually showing — a swipe lock is dismissed; an unlocked device
 * is left alone.
 */
describe("AndroidEmulatorClient wakeAndUnlock", () => {
  let emulatorClient: AndroidEmulatorClient;
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let fakeFactory: TestAdbClientFactory;

  const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });

  const mockExecAsync = async (_command: string): Promise<ExecResult> => {
    return createExecResult("", "");
  };

  function runWakeAndUnlock(): Promise<void> {
    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);
    return wakeAndUnlock(DEVICE);
  }

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeFactory = new TestAdbClientFactory(fakeAdb);
    emulatorClient = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, fakeFactory);
  });

  test("wakes device and dismisses a swipe keyguard when device is Asleep", async () => {
    fakeAdb.setScreenState(false, "Asleep");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    await runWakeAndUnlock();

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
  });

  test("wakes device and dismisses a swipe keyguard when device is Dozing", async () => {
    fakeAdb.setScreenState(false, "Dozing");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    await runWakeAndUnlock();

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
  });

  test("skips KEYCODE_WAKEUP when device is already Awake but still dismisses a swipe keyguard", async () => {
    fakeAdb.setScreenState(true, "Awake");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    await runWakeAndUnlock();

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(false);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
  });

  test("does not dismiss the keyguard when the device is not locked", async () => {
    fakeAdb.setScreenState(false, "Asleep");
    fakeAdb.setDeviceLock(UNLOCKED);

    await runWakeAndUnlock();

    // Waking is enough; there is no keyguard to dismiss.
    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(false);
  });

  test("handles errors gracefully without throwing", async () => {
    fakeAdb.setScreenState(false, "Asleep");
    const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
    fakeAdb.executeCommand = async (command: string) => {
      if (command.includes("KEYCODE_WAKEUP")) {
        throw new Error("Simulated ADB error");
      }
      return originalExecuteCommand(command);
    };

    await expect(runWakeAndUnlock()).resolves.toBeUndefined();
  });

  test("treats unknown wakefulness as not-awake and still wakes the device", async () => {
    (fakeAdb as any).wakefulness = null;
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    await runWakeAndUnlock();

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
  });
});
