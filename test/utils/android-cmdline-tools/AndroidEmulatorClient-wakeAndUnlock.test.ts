import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { AndroidWakeAndUnlock } from "../../../src/utils/android-cmdline-tools/AndroidWakeAndUnlock";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { ExecResult, BootedDevice, DeviceLockState } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DeviceLockStore } from "../../../src/devices/DeviceLockStore";

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
const LOCKED_SECURE: DeviceLockState = { locked: true, keyguardShowing: true, secure: true };
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
  let credentialSpies: Array<{ mockRestore(): void }>;

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

  function runWakeAndUnlock(signal?: AbortSignal): Promise<void> {
    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);
    return wakeAndUnlock(DEVICE, signal);
  }

  beforeEach(() => {
    // Keep every boot-time lock lookup/write off the real file-backed database.
    credentialSpies = [
      spyOn(DeviceLockStore.prototype, "getRecordedCredential").mockResolvedValue(null),
      spyOn(DeviceLockStore.prototype, "rememberLock").mockResolvedValue(undefined),
    ];
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeFactory = new TestAdbClientFactory(fakeAdb);
    emulatorClient = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, fakeFactory);
  });

  afterEach(() => {
    for (const spy of credentialSpies) {
      spy.mockRestore();
    }
  });

  test("an already-aborted boot request rejects without waking or unlocking the device", async () => {
    fakeAdb.setScreenState(false, "Asleep");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);
    const controller = new AbortController();
    controller.abort(new Error("boot request cancelled"));

    await expect(runWakeAndUnlock(controller.signal)).rejects.toBe(controller.signal.reason);

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(false);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    expect(fakeTimer.now()).toBe(0);
  });

  test("shared wake/unlock rejects an already-aborted signal before any ADB call", async () => {
    fakeAdb.setScreenState(false, "Asleep");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);
    const controller = new AbortController();
    controller.abort();
    const wakeAndUnlock = new AndroidWakeAndUnlock(DEVICE, fakeAdb, { timer: fakeTimer });

    await expect(wakeAndUnlock.execute(undefined, controller.signal)).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    expect(fakeTimer.now()).toBe(0);
  });

  test("a live boot signal still wakes the device and dismisses a swipe keyguard", async () => {
    fakeAdb.setScreenState(false, "Asleep");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);
    const controller = new AbortController();

    await expect(runWakeAndUnlock(controller.signal)).resolves.toBeUndefined();

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
    expect(controller.signal.aborted).toBe(false);
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

  test.each([{ locked: false, keyguardShowing: false, secure: true }, null])(
    "boot never replays a remembered PIN after dismissal or an unknown lock read (%j)",
    async (lock) => {
      fakeAdb.setScreenState(true, "Awake");
      fakeAdb.setAndroidApiLevel(35);
      fakeAdb.setDeviceLockSequence([LOCKED_SECURE, lock]);
      const recorded = spyOn(DeviceLockStore.prototype, "getRecordedCredential").mockResolvedValue(
        "1234",
      );
      const remember = spyOn(DeviceLockStore.prototype, "rememberLock").mockResolvedValue(
        undefined,
      );
      try {
        await runWakeAndUnlock();

        expect(recorded).toHaveBeenCalledWith(DEVICE.deviceId);
        expect(fakeAdb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
        expect(remember).not.toHaveBeenCalled();
      } finally {
        recorded.mockRestore();
        remember.mockRestore();
      }
    },
  );

  test("boot still submits a remembered PIN when the pre-entry read remains secure-locked", async () => {
    fakeAdb.setScreenState(true, "Awake");
    fakeAdb.setAndroidApiLevel(35);
    fakeAdb.setDeviceLockSequence([
      LOCKED_SECURE,
      LOCKED_SECURE,
      { locked: false, keyguardShowing: false, secure: true },
    ]);
    const recorded = spyOn(DeviceLockStore.prototype, "getRecordedCredential").mockResolvedValue(
      "1234",
    );
    const remember = spyOn(DeviceLockStore.prototype, "rememberLock").mockResolvedValue(undefined);
    try {
      await runWakeAndUnlock();

      expect(fakeAdb.getExecutedCommands()).toEqual([
        "shell wm dismiss-keyguard",
        "shell input keyevent KEYCODE_1",
        "shell input keyevent KEYCODE_2",
        "shell input keyevent KEYCODE_3",
        "shell input keyevent KEYCODE_4",
        "shell input keyevent KEYCODE_ENTER",
      ]);
      expect(remember).not.toHaveBeenCalled();
    } finally {
      recorded.mockRestore();
      remember.mockRestore();
    }
  });

  test("waits for direct boot to finish unlocking the primary user", async () => {
    fakeAdb.setDeviceLock(UNLOCKED);
    fakeAdb.setUsersSequence([
      [
        {
          userId: 0,
          name: "Owner",
          flags: 0x4c13,
          profileType: "primary",
          running: true,
          startState: "RUNNING_LOCKED",
        },
      ],
      [
        {
          userId: 0,
          name: "Owner",
          flags: 0x4c13,
          profileType: "primary",
          running: true,
          startState: "RUNNING_UNLOCKED",
        },
      ],
    ]);

    await runWakeAndUnlock();

    expect(fakeTimer.now()).toBe(250);
  });

  test("a failed wake keyevent aborts before wm dismiss-keyguard (single-try)", async () => {
    // REWRITE-1: the previous test asserted only that the boot wrapper swallows
    // the error ("does not throw"), which passes for any behavior. The load-
    // bearing property is that the wake and the unlock share one try: a thrown
    // KEYCODE_WAKEUP short-circuits, so `wm dismiss-keyguard` is never sent. The
    // positive control above ("wakes device and dismisses a swipe keyguard when
    // device is Asleep") proves dismiss-keyguard DOES run on the happy path.
    fakeAdb.setScreenState(false, "Asleep");
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);
    fakeAdb.setCommandError("KEYCODE_WAKEUP", new Error("Simulated ADB error"));

    // The boot wrapper still swallows the failure (the device is usable)...
    await expect(runWakeAndUnlock()).resolves.toBeUndefined();
    // ...but the keyguard dismissal is never attempted once the wake threw.
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(false);
  });

  test("treats unknown wakefulness as not-awake and still wakes the device", async () => {
    (fakeAdb as any).wakefulness = null;
    fakeAdb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    await runWakeAndUnlock();

    expect(fakeAdb.wasCommandExecuted("KEYCODE_WAKEUP")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("wm dismiss-keyguard")).toBe(true);
  });
});
