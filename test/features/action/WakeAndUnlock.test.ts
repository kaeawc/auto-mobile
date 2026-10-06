import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import { wakeAndUnlockResultSchema } from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { WakeAndUnlock } from "../../../src/features/action/WakeAndUnlock";
import type {
  DeviceLockType,
  IosScreenUnlocker,
  IosRunnerRecovery,
  LockCredentialStore,
} from "../../../src/features/action/WakeAndUnlock";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, DeviceLockState } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import type { IosLockStateProbe } from "../../../src/features/observe/ios/IosLockStateProbe";
import {
  IosLockScreenUnlocker,
  type IosUnlockActions,
} from "../../../src/features/action/IosLockScreenUnlocker";

const LOCKED_SECURE: DeviceLockState = { locked: true, keyguardShowing: true, secure: true };
const LOCKED_SWIPE: DeviceLockState = { locked: true, keyguardShowing: true, secure: false };
// `secure` unreadable (dumpsys emitted showing= but not secure=): stays undefined.
const LOCKED_UNKNOWN_SECURE: DeviceLockState = { locked: true, keyguardShowing: true };
const UNLOCKED: DeviceLockState = { locked: false, keyguardShowing: false, secure: true };
// Keyguard still up behind a show-when-locked activity (call, alarm, secure camera):
// `dumpsys window policy` reports showing=true occluded=true.
const OCCLUDED_SECURE: DeviceLockState = { locked: false, keyguardShowing: true, secure: true };

const OCCLUDED_SWIPE: DeviceLockState = { locked: false, keyguardShowing: true, secure: false };

class FakeCredentialStore implements LockCredentialStore {
  recorded: string | null = null;
  /** When set, `recorded` is only replayed on this identity (like the real store). */
  learnedOn: string | undefined;
  lookups: Array<{ deviceId: string; identity: string | undefined }> = [];
  remembered: Array<{ deviceId: string; lockType: DeviceLockType; credential: string | null }> = [];
  rememberedIdentities: Array<string | undefined> = [];
  async getRecordedCredential(
    deviceId: string,
    identity: string | undefined,
  ): Promise<string | null> {
    this.lookups.push({ deviceId, identity });
    if (this.learnedOn !== undefined && identity !== this.learnedOn) {
      return null;
    }
    return this.recorded;
  }
  async rememberLock(
    deviceId: string,
    lockType: DeviceLockType,
    credential: string | null,
    identity: string | undefined,
  ): Promise<void> {
    this.remembered.push({ deviceId, lockType, credential });
    this.rememberedIdentities.push(identity);
  }
}

class FakeIosUnlocker implements IosScreenUnlocker {
  calls = 0;
  result: { success: boolean; error?: string } = { success: true };
  results?: Array<{ success: boolean; error?: string }>;
  async wakeAndDismiss(): Promise<{ success: boolean; error?: string }> {
    this.calls++;
    return this.results?.shift() ?? this.result;
  }
}

class FakeIosLockProbe implements IosLockStateProbe {
  reads = 0;
  states: Array<DeviceLockState | undefined | Error> = [];
  state: DeviceLockState | undefined = LOCKED_SWIPE;
  async read(): Promise<DeviceLockState | undefined> {
    this.reads++;
    const state = this.states.length > 0 ? this.states.shift() : this.state;
    if (state instanceof Error) {
      throw state;
    }
    return state;
  }
}

class TimedLockProbe implements IosLockStateProbe {
  constructor(
    private readonly timer: FakeTimer,
    private readonly unlockAtMs: number,
  ) {}
  async read(): Promise<DeviceLockState> {
    return this.timer.now() >= this.unlockAtMs ? UNLOCKED : LOCKED_SWIPE;
  }
}

class FakeIosRecovery implements IosRunnerRecovery {
  connected = true;
  starts = 0;
  budgets: number[] = [];
  outcomes: Array<"recovered" | "not_recovering" | "failed" | "timed_out"> = [];
  connectResult = false;
  connects = 0;
  recoveryDelayMs = 0;
  timer?: FakeTimer;
  isConnected(): boolean {
    return this.connected;
  }
  ensureRecoveryStarted(): void {
    this.starts++;
  }
  async ensureConnected(): Promise<boolean> {
    this.connects++;
    this.connected = this.connectResult;
    return this.connected;
  }
  async awaitRecovery(
    budgetMs: number,
  ): Promise<"recovered" | "not_recovering" | "failed" | "timed_out"> {
    this.budgets.push(budgetMs);
    if (this.recoveryDelayMs > 0) {
      await this.timer?.sleep(this.recoveryDelayMs);
    }
    const outcome = this.outcomes.shift() ?? "not_recovering";
    if (outcome === "recovered") {
      this.connected = true;
    }
    return outcome;
  }
}

const androidDevice: BootedDevice = {
  deviceId: "wau-android",
  platform: "android",
  name: "Android",
};
const iosDevice: BootedDevice = {
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  platform: "ios",
  name: "iOS Simulator",
};
const physicalIosDevice: BootedDevice = {
  deviceId: "00008030-001C2D3E1234567A",
  platform: "ios",
  name: "iPhone",
};

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

  function recoveringIos(outcome: "timed_out" | "failed" | "not_recovering" = "timed_out") {
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = [outcome];
    const action = new WakeAndUnlock(iosDevice, adb, {
      timer,
      wallClockNow: () => 10_000,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    });
    return { action, ios, lock, recovery };
  }

  describe("recovery failure lock-state recheck", () => {
    let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
    beforeEach(() => {
      warn = spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    test.each(["timed_out", "failed", "not_recovering"] as const)(
      "%s recovery accepts unlocked state without a swipe",
      async (outcome) => {
        const { action, ios, lock } = recoveringIos(outcome);
        lock.states = [LOCKED_SWIPE, UNLOCKED];
        const result = await action.execute();
        expect(result).toMatchObject({ success: true, unlocked: true, wasLocked: true });
        expect(result).toHaveProperty("warning");
        const warning = result.warning;
        expect(warning).toContain(`runner recovery ${outcome}`);
        expect(warning).toContain("next observe");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
        expect(ios.calls).toBe(0);
        expect(lock.reads).toBe(2);
      },
    );

    test.each([LOCKED_SWIPE, undefined])(
      "timeout preserves failure for state %j",
      async (state) => {
        const { action, ios, lock } = recoveringIos();
        lock.states = [LOCKED_SWIPE, state];
        await expect(action.execute()).rejects.toThrow(
          "wakeAndUnlock: iOS runner recovery timed_out while lock state is locked; retry after the runner reconnects",
        );
        expect(lock.reads).toBe(2);
        expect(ios.calls).toBe(0);
      },
    );

    test("timeout preserves recovery error and warns when the recheck throws", async () => {
      const { action, ios, lock } = recoveringIos();
      const probeError = new Error("probe unavailable");
      lock.states = [LOCKED_SWIPE, probeError];
      await expect(action.execute()).rejects.toThrow("runner recovery timed_out");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("probe unavailable"), probeError);
      expect(lock.reads).toBe(2);
      expect(ios.calls).toBe(0);
    });

    test("deadline rejection accepts unlocked state after the full recovery wait", async () => {
      const { action, ios, lock, recovery } = recoveringIos();
      lock.states = [LOCKED_SWIPE, UNLOCKED];
      recovery.recoveryDelayMs = 21_000;
      recovery.timer = timer;
      const result = await action.execute();
      expect(result).toMatchObject({ success: true, unlocked: true, wasLocked: true });
      expect(result.warning).toContain("timed out after 20000ms");
      expect(recovery.budgets).toEqual([20_000]);
      expect(timer.now()).toBe(20_000);
      expect(ios.calls).toBe(0);
    });

    test("exhausted transport budget permits one bounded unlocked recheck", async () => {
      const { action, ios, lock, recovery } = recoveringIos();
      lock.states = [LOCKED_SWIPE, UNLOCKED];
      recovery.recoveryDelayMs = 21_000;
      recovery.timer = timer;
      const result = await action.execute(undefined, 14_000);
      expect(result).toMatchObject({ success: true, unlocked: true, wasLocked: true });
      expect(lock.reads).toBe(2);
      expect(recovery.budgets[0]).toBeLessThanOrEqual(1_000);
      expect(ios.calls).toBe(0);
    });

    test("exhausted recheck is bounded to 250ms and preserves recovery failure", async () => {
      const { action, ios, lock, recovery } = recoveringIos();
      recovery.recoveryDelayMs = 21_000;
      recovery.timer = timer;
      let reads = 0;
      const read = spyOn(lock, "read").mockImplementation(async () => {
        reads++;
        return reads === 1 ? LOCKED_SWIPE : new Promise(() => {});
      });
      try {
        await expect(action.execute(undefined, 14_000)).rejects.toThrow(
          /runner recovery.*timed out/,
        );
        expect(reads).toBe(2);
        expect(timer.now()).toBe((recovery.budgets[0] ?? 0) + 250);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("probe"),
          expect.any(ActionableError),
        );
        expect(ios.calls).toBe(0);
      } finally {
        read.mockRestore();
      }
    });

    test("reconnection budget exhaustion accepts unlocked state", async () => {
      const { action, ios, lock, recovery } = recoveringIos("not_recovering");
      lock.states = [LOCKED_SWIPE, UNLOCKED];
      const connect = spyOn(recovery, "ensureConnected").mockImplementation(async () => {
        timer.setCurrentTime(20_000);
        return false;
      });
      try {
        const result = await action.execute();
        expect(result.success).toBe(true);
        expect(result.warning).toContain("recovery budget exhausted before swipe");
        expect(ios.calls).toBe(0);
      } finally {
        connect.mockRestore();
      }
    });

    test("caller abort during recovery skips the unlocked recheck", async () => {
      const { action, ios, lock, recovery } = recoveringIos();
      lock.states = [LOCKED_SWIPE, UNLOCKED];
      const controller = new AbortController();
      recovery.timer = timer;
      recovery.recoveryDelayMs = 1_000;
      const wait = spyOn(recovery, "awaitRecovery").mockImplementation(async () => {
        timer.setTimeout(() => controller.abort(), 10);
        await timer.sleep(1_000);
        return "timed_out";
      });
      try {
        await expect(action.execute(undefined, undefined, controller.signal)).rejects.toThrow(
          "cancelled",
        );
        expect(lock.reads).toBe(1);
        expect(ios.calls).toBe(0);
      } finally {
        wait.mockRestore();
      }
    });

    test("caller abort during the unlocked recheck cannot return success", async () => {
      const { action, ios, lock } = recoveringIos();
      const controller = new AbortController();
      let reads = 0;
      const read = spyOn(lock, "read").mockImplementation(async () => {
        if (++reads === 1) {
          return LOCKED_SWIPE;
        }
        controller.abort();
        return UNLOCKED;
      });
      try {
        await expect(action.execute(undefined, undefined, controller.signal)).rejects.toThrow(
          "cancelled",
        );
        expect(reads).toBe(2);
        expect(ios.calls).toBe(0);
      } finally {
        read.mockRestore();
      }
    });

    test("Android wake and swipe unlock never invokes iOS recovery or probe", async () => {
      adb.setScreenState(false, "Asleep");
      adb.setDeviceLockSequence([LOCKED_SWIPE, UNLOCKED]);
      const ios = new FakeIosUnlocker();
      const lock = new FakeIosLockProbe();
      const recovery = new FakeIosRecovery();
      recovery.connected = false;
      const result = await new WakeAndUnlock(androidDevice, adb, {
        timer,
        iosUnlocker: ios,
        iosLockStateProbe: lock,
        iosRunnerRecovery: recovery,
      }).execute();
      expect(result).toMatchObject({
        success: true,
        wasAsleep: true,
        wasLocked: true,
        unlocked: true,
      });
      expect(adb.getExecutedCommands()).toEqual([
        "shell input keyevent KEYCODE_WAKEUP",
        "shell wm dismiss-keyguard",
      ]);
      expect(result.warning).toBeUndefined();
      expect([ios.calls, lock.reads, recovery.starts]).toEqual([0, 0, 0]);
    });

    test("successful recovery still swipes then confirms without a warning", async () => {
      const { action, ios, lock, recovery } = recoveringIos();
      recovery.outcomes = ["recovered"];
      lock.states = [LOCKED_SWIPE, UNLOCKED];
      const swipe = spyOn(ios, "wakeAndDismiss").mockImplementation(async () => {
        expect(recovery.connected).toBe(true);
        expect(lock.reads).toBe(1);
        return { success: true };
      });
      try {
        const result = await action.execute();
        expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
        expect(result.warning).toBeUndefined();
        expect(swipe).toHaveBeenCalledTimes(1);
        expect(lock.reads).toBe(2);
      } finally {
        swipe.mockRestore();
      }
    });
  });

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
    adb.setDeviceLockSequence([LOCKED_SECURE, LOCKED_SECURE, UNLOCKED]);
    store.recorded = "1234";

    const result = await android().execute();

    expect(result.success).toBe(true);
    expect(result.usedRecordedCredential).toBe(true);
    expect(adb.getExecutedCommands()).toEqual(SECURE_PIN_COMMANDS.slice(1));
    expect(store.remembered).toEqual([]); // recorded pins are not re-persisted
  });

  test("dismiss-keyguard clears secure lock: explicit PIN is neither typed nor remembered", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLockSequence([LOCKED_SECURE, UNLOCKED]);

    const result = await android().execute("1234");

    expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
    expect(result).toMatchObject({ success: true, secure: true, unlocked: true });
    expect(result.usedRecordedCredential).toBe(false);
    expect(store.remembered).toEqual([]);
  });

  test("dismiss-keyguard clears secure lock: recorded PIN is not replayed into the app", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLockSequence([LOCKED_SECURE, UNLOCKED]);
    store.recorded = "1234";

    const result = await android().execute();

    expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
    expect(result).toMatchObject({ success: true, secure: true, unlocked: true });
    expect(result.usedRecordedCredential).toBe(false);
    expect(store.remembered).toEqual([]);
    expect(store.recorded).toBe("1234");
  });

  test.each([false, true])(
    "lock state unknown after dismiss-keyguard: no credential input (recorded=%s)",
    async (recorded) => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLockSequence([LOCKED_SECURE, null]);
      store.recorded = recorded ? "1234" : null;

      const result = await android().execute(recorded ? undefined : "1234");

      expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
      expect(result).toMatchObject({ success: false, unlocked: false });
      expect(result.error).toMatch(/lock state.*unknown/i);
      expect(store.remembered).toEqual([]);
    },
  );

  test.each([
    OCCLUDED_SECURE, // occluded by an app
    LOCKED_SWIPE,
  ])("keyguard no longer needs credential input: sends no PIN (%j)", async (lock) => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLockSequence([LOCKED_SECURE, lock]);

    const result = await android().execute("1234");

    expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
    expect(result).toMatchObject({ success: false, unlocked: false });
    expect(store.remembered).toEqual([]);
  });

  test("secure lock, pin does not work: reports keyguard failure and remembers nothing", async () => {
    adb.setScreenState(true, "Awake");
    adb.setDeviceLock(LOCKED_SECURE); // never clears

    const result = await android().execute("0000");

    expect(result.success).toBe(false);
    expect(result.unlocked).toBe(false);
    expect(result.error).toContain("remained locked");
    expect(adb.getExecutedCommands()).toEqual([
      "shell wm dismiss-keyguard",
      ...Array<string>(4).fill("shell input keyevent KEYCODE_0"),
      "shell input keyevent KEYCODE_ENTER",
    ]);
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
    adb.setDeviceLockSequence([LOCKED_UNKNOWN_SECURE, LOCKED_UNKNOWN_SECURE, UNLOCKED]);

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

  describe("occluded keyguard (#10064)", () => {
    test("showing but occluded is not unlocked: no dismissal, no PIN, nothing remembered", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock(OCCLUDED_SECURE);

      const result = await android().execute("1234");

      expect(result).toMatchObject({
        success: false,
        wasLocked: true,
        secure: true,
        unlocked: false,
      });
      expect(result.error).toMatch(/occluded by a foreground show-when-locked activity/);
      expect(adb.getExecutedCommands()).toEqual([]);
      expect(store.remembered).toEqual([]);
    });

    test("an occluded swipe keyguard needs no credential: it is dismissed, not refused", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLockSequence([OCCLUDED_SWIPE, UNLOCKED]);

      const result = await android().execute();

      expect(result).toMatchObject({ success: true, unlocked: true });
      expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
    });

    test("an occluded swipe keyguard that does not dismiss is reported, never as unlocked", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock(OCCLUDED_SWIPE);

      const result = await android().execute();

      expect(result).toMatchObject({ success: false, unlocked: false });
      expect(result.error).toContain("did not dismiss");
      expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
    });

    test("an occluded keyguard whose security could not be read is still refused", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock({ locked: false, keyguardShowing: true });

      const result = await android().execute("1234");

      expect(result).toMatchObject({ success: false, wasLocked: true, unlocked: false });
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("an occluder arriving mid-poll after PIN entry does not count as unlocked or remember the PIN", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLockSequence([LOCKED_SECURE, LOCKED_SECURE, OCCLUDED_SECURE]);

      const result = await android().execute("1234");

      expect(result.success).toBe(false);
      expect(result.unlocked).toBe(false);
      expect(result.error).toContain("remained locked");
      expect(store.remembered).toEqual([]);
    });

    test("an occluder arriving mid-poll after swipe dismissal is not a dismissed keyguard", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLockSequence([LOCKED_SWIPE, OCCLUDED_SECURE]);

      const result = await android().execute();

      expect(result).toMatchObject({ success: false, unlocked: false });
      expect(result.error).toContain("did not dismiss");
      expect(store.remembered).toEqual([]);
    });

    test("keyguard not showing is still reported unlocked with no commands", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock(UNLOCKED);

      const result = await android().execute("1234");

      expect(result).toMatchObject({ success: true, wasLocked: false, unlocked: true });
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });

  describe("recorded credential is bound to the device it was learned on (#10065)", () => {
    const avdA: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "avd-a" };
    const avdB: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "avd-b" };

    function on(device: BootedDevice): WakeAndUnlock {
      return new WakeAndUnlock(device, adb, { timer, credentialStore: store });
    }

    test("a different AVD behind the same serial fails up front and sends no key events", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock(LOCKED_SECURE);
      store.recorded = "1234";
      store.learnedOn = "avd-a";

      await expect(on(avdB).execute()).rejects.toThrow(ActionableError);
      await expect(on(avdB).execute()).rejects.toThrow(/provide `pin`/);

      expect(adb.getExecutedCommands().some((c) => c.includes("KEYCODE_"))).toBe(false);
      expect(store.lookups[0]).toEqual({ deviceId: "emulator-5554", identity: "avd-b" });
    });

    test("the AVD the PIN was learned on still replays it", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLockSequence([LOCKED_SECURE, LOCKED_SECURE, UNLOCKED]);
      store.recorded = "1234";
      store.learnedOn = "avd-a";

      const result = await on(avdA).execute();

      expect(result).toMatchObject({ success: true, usedRecordedCredential: true });
      expect(adb.wasCommandExecuted("KEYCODE_1")).toBe(true);
    });

    test("an emulator whose AVD name is unresolved never replays a recorded PIN", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock(LOCKED_SECURE);
      store.recorded = "1234";
      store.learnedOn = "avd-a";
      const unresolved: BootedDevice = { ...avdA, name: "emulator-5554" };

      await expect(on(unresolved).execute()).rejects.toThrow(/provide `pin`/);

      expect(store.lookups[0]?.identity).toBeUndefined();
      expect(adb.wasCommandExecuted("KEYCODE_")).toBe(false);
    });

    test("a PIN is remembered under the device's stable identity", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLockSequence([LOCKED_SECURE, LOCKED_SECURE, UNLOCKED]);

      await on(avdA).execute("1234");

      expect(store.rememberedIdentities).toEqual(["avd-a"]);
    });

    test("a handset is identified by its serial, which is never reassigned", async () => {
      adb.setScreenState(true, "Awake");
      adb.setDeviceLock(LOCKED_SECURE);

      await expect(android().execute()).rejects.toThrow(/provide `pin`/);

      expect(store.lookups).toEqual([{ deviceId: "wau-android", identity: "wau-android" }]);
    });
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

  test("iOS: already unlocked sends no home or swipe request", async () => {
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    lock.state = UNLOCKED;
    const recovery = new FakeIosRecovery();
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    }).execute("1234");

    expect(result).toMatchObject({ success: true, wasLocked: false, unlocked: true });
    expect(ios.calls).toBe(0);
    expect(recovery.starts).toBe(0);
    expect(lock.reads).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("iOS: locked and connected swipes then confirms unlocked", async () => {
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, UNLOCKED];
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
      iosRunnerRecovery: new FakeIosRecovery(),
    }).execute();

    expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(ios.calls).toBe(1);
    expect(lock.reads).toBe(2);
  });

  test("iOS: unlocked after Home succeeds without a swipe or another confirmation probe", async () => {
    const calls: string[] = [];
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, UNLOCKED];
    const read = lock.read.bind(lock);
    lock.read = async () => {
      calls.push("read");
      return read();
    };
    const actions: IosUnlockActions = {
      async pressHome() {
        calls.push("home");
        return { success: true };
      },
      async swipeUp() {
        calls.push("swipe");
        return { success: false };
      },
    };
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: lock,
    }).execute();
    expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
    expect(result.warning).toContain("no swipe was needed");
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(["read", "home", "read"]);
    expect(lock.reads).toBe(2);
  });

  test("iOS: late unlocked pre-swipe probe cannot turn a failed swipe into success", async () => {
    let reads = 0;
    const late = Promise.withResolvers<DeviceLockState>();
    const lock: IosLockStateProbe = {
      async read() {
        return ++reads === 2 ? late.promise : LOCKED_SWIPE;
      },
    };
    let swipes = 0;
    const actions: IosUnlockActions = {
      async pressHome() {
        return { success: true };
      },
      async swipeUp() {
        swipes++;
        late.resolve(UNLOCKED);
        return { success: false, error: "runner_busy" };
      },
    };
    await expect(
      new WakeAndUnlock(iosDevice, adb, {
        timer,
        iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
        iosLockStateProbe: lock,
      }).execute(),
    ).rejects.toThrow("runner_busy");
    expect(swipes).toBe(1);
    expect(reads).toBeGreaterThan(2);
  });

  test("iOS: disconnected runner waits for recovery before swiping", async () => {
    const manualTimer = new FakeTimer();
    manualTimer.enableAutoAdvance();
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, UNLOCKED];
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = ["recovered"];
    recovery.recoveryDelayMs = 1_000;
    recovery.timer = manualTimer;
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer: manualTimer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    }).execute();

    expect(result).toMatchObject({ success: true, wasLocked: true });
    expect(ios.calls).toBe(1);
    expect(recovery.starts).toBe(1);
    expect(recovery.budgets).toEqual([20_000]);
  });

  test("iOS: recovery with no active promise starts normal connection", async () => {
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, UNLOCKED];
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = ["not_recovering"];
    recovery.connectResult = true;
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    }).execute();

    expect(result.success).toBe(true);
    expect(recovery.connects).toBe(1);
    expect(ios.calls).toBe(1);
  });

  test("iOS: recovery timeout identifies the failure and sends no gesture", async () => {
    const manualTimer = new FakeTimer();
    manualTimer.enableAutoAdvance();
    const ios = new FakeIosUnlocker();
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = ["timed_out"];
    recovery.recoveryDelayMs = 20_000;
    recovery.timer = manualTimer;
    const action = new WakeAndUnlock(iosDevice, adb, {
      timer: manualTimer,
      iosUnlocker: ios,
      iosLockStateProbe: new FakeIosLockProbe(),
      iosRunnerRecovery: recovery,
    });

    await expect(action.execute()).rejects.toThrow(/runner recovery.*(timed out|timed_out)/);
    expect(ios.calls).toBe(0);
    expect(recovery.budgets).toEqual([20_000]);
  });

  test("iOS: successful swipe that leaves lock showing reports observed state", async () => {
    const ios = new FakeIosUnlocker();
    const action = new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: new FakeIosLockProbe(),
    });

    const failure = action.execute();
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow(/still locked/);
    expect(ios.calls).toBe(1);
    expect(timer.now()).toBe(2_500);
  });

  test("iOS: physical device skips simctl lock probe and retains unknown wasLocked", async () => {
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    lock.state = undefined;
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = ["recovered"];
    const result = await new WakeAndUnlock(physicalIosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    }).execute();

    expect(result).toMatchObject({ success: true, wasLocked: false, unlocked: true });
    expect(lock.reads).toBe(0);
    expect(ios.calls).toBe(1);
    expect(recovery.starts).toBe(1);
  });

  test("iOS: unreadable simulator pre-check fails without a runner request", async () => {
    const ios = new FakeIosUnlocker();
    const lock = new FakeIosLockProbe();
    lock.state = undefined;
    await expect(
      new WakeAndUnlock(iosDevice, adb, {
        timer,
        iosUnlocker: ios,
        iosLockStateProbe: lock,
      }).execute(),
    ).rejects.toThrow(/could not read.*before unlock/);
    expect(ios.calls).toBe(0);
    expect(lock.reads).toBe(1);
  });

  test("iOS: failed Home continues to swipe and post-swipe state determines success", async () => {
    const calls: string[] = [];
    const actions: IosUnlockActions = {
      async pressHome() {
        calls.push("home");
        return { success: false, error: "hierarchy unavailable" };
      },
      async swipeUp() {
        calls.push("swipe");
        return { success: true };
      },
    };
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, LOCKED_SWIPE, UNLOCKED];
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: lock,
    }).execute();
    expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
    expect(calls).toEqual(["home", "swipe"]);
    expect(lock.reads).toBe(3);
  });

  test("iOS: late recovery shares the overall budget with Home, swipe, and poll", async () => {
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = ["recovered"];
    recovery.recoveryDelayMs = 19_000;
    recovery.timer = timer;
    const calls: number[] = [];
    const actions: IosUnlockActions = {
      async pressHome(timeoutMs) {
        calls.push(timeoutMs);
        await timer.sleep(1_500);
        return { success: false };
      },
      async swipeUp(timeoutMs) {
        calls.push(timeoutMs);
        await timer.sleep(3_000);
        return { success: true };
      },
    };
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, undefined];
    lock.state = undefined;
    const action = new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    });
    await expect(action.execute()).rejects.toThrow(/could not read.*after the swipe/);
    expect(calls).toEqual([2_000, 2_250, 2_250]);
    expect(timer.now()).toBe(25_000);
    expect(lock.reads).toBeGreaterThan(1);
  });

  test("iOS: unreadable post-swipe probes report unknown state, not still locked", async () => {
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, undefined];
    lock.state = undefined;
    const action = new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new FakeIosUnlocker(),
      iosLockStateProbe: lock,
    });
    await expect(action.execute()).rejects.toThrow(/could not read.*after the swipe.*re-observe/);
    expect(timer.now()).toBe(2_500);
  });

  test("iOS: Display-changed swipe error then unlocked probe reports success", async () => {
    const ios = new FakeIosUnlocker();
    ios.result = {
      success: false,
      error:
        "Display changed since these coordinates were chosen. Re-observe the active panel and choose a new point before retrying.",
    };
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, UNLOCKED];
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
    }).execute();
    expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
    expect(result.error).toBeUndefined();
    expect(result.warning).toContain(ios.result.error);
    expect(ios.calls).toBe(1);
  });

  test("iOS: swipe timeout and never-unlocking probe names both and respects the deadline", async () => {
    const ios = new FakeIosUnlocker();
    ios.result = { success: false, error: "iOS lock-screen swipe timed out after 5000ms" };
    const failure = new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: new FakeIosLockProbe(),
    }).execute();
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow(
      /still locked.*timed out after 5000ms|timed out after 5000ms.*still locked/,
    );
    expect(ios.calls).toBe(1);
    expect(timer.now()).toBe(25_000);
  });

  test("iOS: queued request uses the transport deadline across recovery, Home, swipe, and poll", async () => {
    const wallClockStart = 1_800_000_000_000;
    const transportDeadline = wallClockStart + 12_000;
    const recovery = new FakeIosRecovery();
    recovery.connected = false;
    recovery.outcomes = ["recovered"];
    recovery.recoveryDelayMs = 1_000;
    recovery.timer = timer;
    const budgets: number[] = [];
    const actions: IosUnlockActions = {
      async pressHome(timeoutMs) {
        budgets.push(timeoutMs);
        await timer.sleep(1_000);
        return { success: true };
      },
      async swipeUp(timeoutMs) {
        budgets.push(timeoutMs);
        await timer.sleep(timeoutMs);
        return { success: false, error: "swipe failed" };
      },
    };
    const failure = new WakeAndUnlock(iosDevice, adb, {
      timer,
      wallClockNow: () => wallClockStart,
      iosRunnerRecovery: recovery,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: new FakeIosLockProbe(),
    }).execute(undefined, transportDeadline);
    await expect(failure).rejects.toThrow(/still locked.*swipe failed/);
    expect(budgets).toEqual([2_000, 2_500, 2_500]);
    expect(timer.now()).toBe(9_000);
    expect(wallClockStart + timer.now()).toBe(transportDeadline - 3_000);
  });

  test("iOS: swipe failure and unreadable probe includes the swipe reason", async () => {
    const ios = new FakeIosUnlocker();
    ios.result = { success: false, error: "swipe boom" };
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE];
    lock.state = undefined;
    await expect(
      new WakeAndUnlock(iosDevice, adb, {
        timer,
        iosUnlocker: ios,
        iosLockStateProbe: lock,
      }).execute(),
    ).rejects.toThrow(
      /could not read the iOS lock state after the swipe \(swipe failed: swipe boom\); re-observe/,
    );
    expect(timer.now()).toBe(25_000);
  });

  test("iOS: locked post-wake state cannot confirm a failed swipe when later probes are unreadable", async () => {
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, LOCKED_SWIPE];
    lock.state = undefined;
    let swipes = 0;
    const error = "Swipe timed out after 2500ms";
    const actions: IosUnlockActions = {
      async pressHome() {
        return { success: true };
      },
      async swipeUp() {
        swipes++;
        return { success: false, error };
      },
    };
    const failure = new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: lock,
    }).execute();
    await expect(failure).rejects.toThrow(
      "could not read the iOS lock state after the swipe (swipe failed: Swipe timed out after 2500ms)",
    );
    await expect(failure).rejects.not.toThrow("still locked");
    expect(swipes).toBe(1);
    expect(lock.reads).toBeGreaterThan(2);
    expect(timer.now()).toBe(25_000);
  });

  test("iOS: late recovery after a failed swipe is accepted before the deadline", async () => {
    let swipes = 0;
    const actions: IosUnlockActions = {
      async pressHome() {
        return { success: true };
      },
      swipeUp() {
        swipes++;
        return new Promise(() => {});
      },
    };
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: new TimedLockProbe(timer, 19_000),
    }).execute();
    expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
    expect(result.error).toBeUndefined();
    expect(swipes).toBe(2);
    expect(timer.now()).toBeGreaterThanOrEqual(19_000);
    expect(timer.now()).toBeLessThan(25_000);
  });

  test("iOS: physical device failed swipe still returns failure", async () => {
    const ios = new FakeIosUnlocker();
    ios.result = { success: false, error: "x" };
    const lock = new FakeIosLockProbe();
    const result = await new WakeAndUnlock(physicalIosDevice, adb, {
      timer,
      iosUnlocker: ios,
      iosLockStateProbe: lock,
    }).execute();
    expect(result).toMatchObject({ success: false, wasLocked: false, unlocked: false, error: "x" });
    expect(lock.reads).toBe(0);
    expect(ios.calls).toBe(1);
  });

  test("iOS: swipe timeout then unlocked probe reports success", async () => {
    let swipes = 0;
    const actions: IosUnlockActions = {
      async pressHome() {
        return { success: true };
      },
      swipeUp() {
        swipes++;
        return new Promise(() => {});
      },
    };
    const lock = new FakeIosLockProbe();
    lock.states = [LOCKED_SWIPE, LOCKED_SWIPE, UNLOCKED];
    const recovery = new FakeIosRecovery();
    const result = await new WakeAndUnlock(iosDevice, adb, {
      timer,
      iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
      iosLockStateProbe: lock,
      iosRunnerRecovery: recovery,
    }).execute();
    expect(result).toMatchObject({ success: true, wasLocked: true, unlocked: true });
    expect(result.error).toBeUndefined();
    expect(result.warning).toContain("swipe did not complete");
    expect(result.warning).toContain("timed out after 2500ms");
    expect(swipes).toBe(1);
    expect(lock.reads).toBe(3);
    expect(recovery.starts).toBe(0);
    expect(recovery.connects).toBe(0);
    expect(recovery.budgets).toEqual([]);
    expect(timer.now()).toBe(2_500);
  });
});

describe("iOS two-stage unlock", () => {
  for (const fastUnlocks of [true, false]) {
    test(`fast swipe ${fastUnlocks ? "unlocks without fallback" : "has no effect and legacy fallback unlocks"}`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const lock = new FakeIosLockProbe();
      lock.states = fastUnlocks
        ? [LOCKED_SWIPE, LOCKED_SWIPE, UNLOCKED]
        : [LOCKED_SWIPE, LOCKED_SWIPE, LOCKED_SWIPE, UNLOCKED];
      const flags: Array<true | undefined> = [];
      const budgets: number[] = [];
      const actions: IosUnlockActions = {
        async pressHome() {
          return { success: true };
        },
        async swipeUp(timeoutMs, options) {
          budgets.push(timeoutMs);
          flags.push(options?.lockScreen);
          return { success: true };
        },
      };
      const result = await new WakeAndUnlock(iosDevice, new FakeAdbExecutor(), {
        timer,
        iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
        iosLockStateProbe: lock,
      }).execute();
      expect(result.unlocked).toBe(true);
      expect(flags).toEqual(fastUnlocks ? [true] : [true, undefined]);
      expect(budgets).toEqual(fastUnlocks ? [2500] : [2500, 5000]);
      expect(result.warning).toBe(
        fastUnlocks
          ? undefined
          : "unlocked by the fallback swipe after the fast swipe had no effect",
      );
    });
  }

  for (const throws of [false, true]) {
    test(`non-busy fast failure still falls back (throws=${throws})`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const lock = new FakeIosLockProbe();
      lock.states = [LOCKED_SWIPE, LOCKED_SWIPE, undefined, UNLOCKED];
      const flags: Array<true | undefined> = [];
      const actions: IosUnlockActions = {
        async pressHome() {
          return { success: true };
        },
        async swipeUp(_timeoutMs, options) {
          flags.push(options?.lockScreen);
          if (flags.length === 1) {
            if (throws) {
              throw new Error("fast gesture failed");
            }
            return { success: false, error: "fast gesture failed" };
          }
          return { success: true };
        },
      };
      const result = await new WakeAndUnlock(iosDevice, new FakeAdbExecutor(), {
        timer,
        iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
        iosLockStateProbe: lock,
      }).execute();
      expect(flags).toEqual([true, undefined]);
      expect(result.warning).toContain("fallback swipe");
      expect(result.unlocked).toBe(true);
    });
  }

  test("stage-1 probe consumes swipe budget: no fallback and existing still-locked failure", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let probes = 0;
    const lock: IosLockStateProbe = {
      async read() {
        if (++probes === 3) {
          await timer.sleep(5000);
        }
        return LOCKED_SWIPE;
      },
    };
    let swipes = 0;
    const actions: IosUnlockActions = {
      async pressHome() {
        return { success: true };
      },
      async swipeUp() {
        swipes++;
        return { success: true };
      },
    };
    await expect(
      new WakeAndUnlock(iosDevice, new FakeAdbExecutor(), {
        timer,
        iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
        iosLockStateProbe: lock,
      }).execute(),
    ).rejects.toThrow(/still locked/);
    expect(swipes).toBe(1);
    expect(timer.now()).toBeLessThanOrEqual(25000);
  });

  for (const error of [
    "Command request_swipe exceeded execution bound 2500ms in phase gesture after 2500ms; XCUITest call is still executing and the runner stays busy until it returns",
    "iOS runner is busy executing request_swipe for 2.5s; retry shortly",
    "runner_busy",
    "Swipe timed out after 2500ms",
  ]) {
    for (const throws of [false, true]) {
      test(`busy/transport error prevents fallback (${error}, throws=${throws})`, async () => {
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const lock = new FakeIosLockProbe();
        let swipes = 0;
        const actions: IosUnlockActions = {
          async pressHome() {
            return { success: true };
          },
          async swipeUp() {
            swipes++;
            if (throws) {
              throw new ActionableError(error);
            }
            return { success: false, error };
          },
        };
        await expect(
          new WakeAndUnlock(iosDevice, new FakeAdbExecutor(), {
            timer,
            iosUnlocker: new IosLockScreenUnlocker(iosDevice, actions, timer),
            iosLockStateProbe: lock,
          }).execute(),
        ).rejects.toThrow(error);
        expect(swipes).toBe(1);
        expect(timer.now()).toBe(25000);
      });
    }
  }
});

// Validate the actual fake-backed branch results before and after finalization.
const executeForOutputSchema = WakeAndUnlock.prototype.execute;
let executeOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  executeOutputSchemaSpy = spyOnOutputSchema(WakeAndUnlock.prototype, "execute").mockImplementation(
    async function (this: WakeAndUnlock, ...args: Parameters<WakeAndUnlock["execute"]>) {
      const result = await executeForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(wakeAndUnlockResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "wakeAndUnlock",
        outputSchema: wakeAndUnlockResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(wakeAndUnlockResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => executeOutputSchemaSpy.mockRestore());
