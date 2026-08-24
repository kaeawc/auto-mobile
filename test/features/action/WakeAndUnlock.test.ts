import { beforeEach, describe, expect, test } from "bun:test";
import { WakeAndUnlock } from "../../../src/features/action/WakeAndUnlock";
import type {
  DeviceLockType,
  IosScreenUnlocker,
  LockCredentialStore,
} from "../../../src/features/action/WakeAndUnlock";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, DeviceLockState } from "../../../src/models";

const LOCKED_SECURE: DeviceLockState = { locked: true, keyguardShowing: true, secure: true };
const LOCKED_SWIPE: DeviceLockState = { locked: true, keyguardShowing: true, secure: false };
// `secure` unreadable (dumpsys emitted showing= but not secure=): stays undefined.
const LOCKED_UNKNOWN_SECURE: DeviceLockState = { locked: true, keyguardShowing: true };
const UNLOCKED: DeviceLockState = { locked: false, keyguardShowing: false, secure: true };

class FakeCredentialStore implements LockCredentialStore {
  recorded: string | null = null;
  remembered: Array<{ deviceId: string; lockType: DeviceLockType; credential: string | null }> = [];
  async getRecordedCredential(): Promise<string | null> {
    return this.recorded;
  }
  async rememberLock(
    deviceId: string,
    lockType: DeviceLockType,
    credential: string | null,
  ): Promise<void> {
    this.remembered.push({ deviceId, lockType, credential });
  }
}

class FakeIosUnlocker implements IosScreenUnlocker {
  calls = 0;
  result: { success: boolean; error?: string } = { success: true };
  async wakeAndDismiss(): Promise<{ success: boolean; error?: string }> {
    this.calls++;
    return this.result;
  }
}

const androidDevice: BootedDevice = {
  deviceId: "wau-android",
  platform: "android",
  name: "Android",
};
const iosDevice: BootedDevice = { deviceId: "wau-ios", platform: "ios", name: "iOS" };

const SECURE_PIN_COMMANDS = [
  "shell input keyevent KEYCODE_WAKEUP",
  "shell wm dismiss-keyguard",
  "shell input keyevent KEYCODE_1",
  "shell input keyevent KEYCODE_2",
  "shell input keyevent KEYCODE_3",
  "shell input keyevent KEYCODE_4",
  "shell input keyevent KEYCODE_ENTER",
];

describe("WakeAndUnlock", () => {
  let adb: FakeAdbExecutor;
  let timer: FakeTimer;
  let store: FakeCredentialStore;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(35);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    store = new FakeCredentialStore();
  });

  function android(): WakeAndUnlock {
    return new WakeAndUnlock(androidDevice, adb, { timer, credentialStore: store });
  }

  test("awake and unlocked: reports success without sending any input", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(UNLOCKED);

    const result = await android().execute();

    expect(result).toMatchObject({
      success: true,
      wasAsleep: false,
      wasLocked: false,
      unlocked: true,
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("asleep and unlocked: wakes the device only", async () => {
    adb.setScreenState(false, "Asleep");
    adb.setDeviceLock(UNLOCKED);

    const result = await android().execute();

    expect(result).toMatchObject({
      success: true,
      wasAsleep: true,
      wasLocked: false,
      unlocked: true,
    });
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_WAKEUP"]);
  });

  test("swipe lock: dismisses via wm dismiss-keyguard and remembers the lock type", async () => {
    adb.setScreenState(false, "Asleep");
    adb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);

    const result = await android().execute();

    expect(result).toMatchObject({ success: true, wasLocked: true, secure: false, unlocked: true });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
    ]);
    expect(store.remembered).toEqual([
      { deviceId: "wau-android", lockType: "swipe", credential: null },
    ]);
  });

  test("swipe lock that does not dismiss: reports failure, remembers nothing", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(LOCKED_SWIPE);

    const result = await android().execute();

    expect(result.success).toBe(false);
    expect(result.unlocked).toBe(false);
    expect(result.error).toContain("did not dismiss");
    expect(store.remembered).toEqual([]);
  });

  test("secure lock with pin: raises bouncer, types PIN, submits, and remembers the pin", async () => {
    adb.setScreenState(false, "Asleep");
    adb.setDeviceLockSequence([LOCKED_SECURE, LOCKED_SECURE, UNLOCKED]);

    const result = await android().execute("1234");

    expect(result).toMatchObject({ success: true, wasLocked: true, secure: true, unlocked: true });
    expect(result.usedRecordedCredential).toBe(false);
    expect(adb.getExecutedCommands()).toEqual(SECURE_PIN_COMMANDS);
    expect(store.remembered).toEqual([
      { deviceId: "wau-android", lockType: "pin", credential: "1234" },
    ]);
  });

  test("secure lock, no pin, nothing recorded: throws an actionable error, sends no keys", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(LOCKED_SECURE);

    await expect(android().execute()).rejects.toThrow(/secure-locked/i);
    // dismiss-keyguard was issued before we knew a pin was required, but no digits.
    expect(adb.getExecutedCommands().some((c) => c.includes("KEYCODE_1"))).toBe(false);
  });

  test("secure lock, no pin, recorded credential: unlocks with it and does not re-remember", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLockSequence([LOCKED_SECURE, UNLOCKED]);
    store.recorded = "1234";

    const result = await android().execute();

    expect(result.success).toBe(true);
    expect(result.usedRecordedCredential).toBe(true);
    expect(store.remembered).toEqual([]); // recorded pins are not re-persisted
  });

  test("secure lock, pin does not work: reports keyguard failure and remembers nothing", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(LOCKED_SECURE); // never clears

    const result = await android().execute("0000");

    expect(result.success).toBe(false);
    expect(result.unlocked).toBe(false);
    expect(result.error).toContain("remained locked");
    expect(store.remembered).toEqual([]);
  });

  test("secure lock, non-key-event-mappable credential: throws without echoing the credential", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(LOCKED_SECURE);

    const promise = android().execute("你好");
    await expect(promise).rejects.toThrow(/cannot be sent as a key event/i);
    // The offending character must be described by position, never echoed (leak).
    await expect(promise).rejects.toThrow(/position 1/);
    await promise.catch((error: unknown) => {
      expect(String((error as Error).message)).not.toContain("你");
    });
  });

  test("unreadable lock state: reports failure, never a false unlock, and issues no keyguard commands", async () => {
    adb.setScreenState(false, "Asleep");
    adb.setDeviceLock(null); // getDeviceLock() returns null (dumpsys unavailable)

    const result = await android().execute("1234");

    expect(result.success).toBe(false);
    expect(result.unlocked).toBe(false);
    expect(result.error).toMatch(/lock state/i);
    // Woke the device, but never guessed at the keyguard.
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_WAKEUP"]);
  });

  test("unknown secure status with a pin: attempts the credential path and unlocks", async () => {
    adb.setScreenState(true, "Awake");
    adb.setAndroidApiLevel(35);
    adb.setDeviceLockSequence([LOCKED_UNKNOWN_SECURE, UNLOCKED]);

    const result = await android().execute("1234");

    expect(result.success).toBe(true);
    expect(result.unlocked).toBe(true);
    expect(result.secure).toBe(true); // a credential unlocked it → it was secure
    expect(adb.getExecutedCommands()).toEqual([
      "shell wm dismiss-keyguard",
      "shell input keyevent KEYCODE_1",
      "shell input keyevent KEYCODE_2",
      "shell input keyevent KEYCODE_3",
      "shell input keyevent KEYCODE_4",
      "shell input keyevent KEYCODE_ENTER",
    ]);
  });

  test("unknown secure status, no pin, dismiss-keyguard clears it: treated as a swipe unlock", async () => {
    adb.setScreenState(true, "Awake");
    // dismiss-keyguard cleared it → the disambiguation poll sees it unlocked.
    adb.setDeviceLockSequence([LOCKED_UNKNOWN_SECURE, UNLOCKED]);

    const result = await android().execute();

    expect(result.success).toBe(true);
    expect(result.unlocked).toBe(true);
    expect(result.secure).toBeUndefined(); // never guessed
    expect(store.remembered).toEqual([
      { deviceId: "wau-android", lockType: "swipe", credential: null },
    ]);
    expect(adb.getExecutedCommands().some((c) => c.includes("KEYCODE_1"))).toBe(false);
  });

  test("unknown secure status, no pin, stays locked: throws asking for a pin", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(LOCKED_UNKNOWN_SECURE); // never clears

    await expect(android().execute()).rejects.toThrow(/secure status could not be read/i);
  });

  test("a recorded pin that fails is forgotten (avoids re-submitting a stale pin into lockout)", async () => {
    adb.setScreenState(true, "Awake");
    adb.setAndroidApiLevel(35);
    adb.setDeviceLock(LOCKED_SECURE); // never clears → recorded pin fails
    store.recorded = "1234";

    const result = await android().execute();

    expect(result.success).toBe(false);
    expect(result.usedRecordedCredential).toBe(true);
    // The stale recorded credential is cleared so it is not retried next time.
    expect(store.remembered).toEqual([
      { deviceId: "wau-android", lockType: "pin", credential: null },
    ]);
  });

  test("iOS: delegates to the iOS unlocker and ignores the pin", async () => {
    const ios = new FakeIosUnlocker();
    const result = await new WakeAndUnlock(iosDevice, adb, { timer, iosUnlocker: ios }).execute(
      "1234",
    );

    expect(ios.calls).toBe(1);
    expect(result).toMatchObject({ success: true, platform: "ios", unlocked: true });
    // The pin is ignored on iOS: no Android key events are sent.
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
