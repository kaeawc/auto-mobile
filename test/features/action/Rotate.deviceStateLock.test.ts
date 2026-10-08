import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Rotate, unlockDeviceStateRotationEntry } from "../../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

const device = { deviceId: "lock-device", name: "Resizable", platform: "android" as const };
const output = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s) => stdout.includes(s),
});

const BASELINE = "0:1:1:2:2:0";
const LOCKED_STATE_1 = "0:1:1:1:2:0";

/**
 * Models the am-resizable window manager (mt-0083 D1): turning auto-rotate off records a lock
 * for the committed device state in `secure device_state_rotation_lock`, and while that entry
 * is locked an `accelerometer_rotation=1` write is reverted to 0. `lock: null` models a device
 * without the setting.
 */
class DeviceStateLockAdb extends FakeAdbExecutor {
  auto = 1;
  user = 0;
  live = 0;
  committedState = 1;
  lock: string | null = BASELINE;
  failLockWrite = false;
  override async executeCommand(command: string): Promise<ExecResult> {
    await super.executeCommand(command);
    const words = command.split(" ");
    if (command === "shell cmd device_state state") {
      return output(`Committed state: DeviceState{identifier=${this.committedState}, name='X'}`);
    }
    if (command === "shell settings get secure device_state_rotation_lock") {
      return output(this.lock ?? "null");
    }
    if (command.startsWith("shell settings put secure device_state_rotation_lock")) {
      if (this.failLockWrite) {
        throw new Error("secure settings write refused");
      }
      this.lock = words[5];
      return output("");
    }
    if (command.startsWith("shell settings get system")) {
      return output(String(words[4] === "user_rotation" ? this.user : this.auto));
    }
    if (command.startsWith("shell settings put system")) {
      const value = Number(words[5]);
      if (words[4] === "user_rotation") {
        this.user = value;
      } else {
        this.auto = value;
        this.applyLock();
      }
      if (this.auto === 0) {
        this.live = this.user;
      }
      return output("");
    }
    if (command.includes("dumpsys window")) {
      return output(`mRotation=${this.live}`);
    }
    if (command === "shell wm size") {
      return output("Physical size: 1080x1920");
    }
    return output("");
  }
  private applyLock() {
    if (this.lock === null) {
      return;
    }
    const entries = this.lock.split(":");
    const index = entries.findIndex((e, i) => i % 2 === 0 && e === String(this.committedState));
    if (this.auto === 0) {
      entries[index + 1] = "1";
      this.lock = entries.join(":");
    } else if (entries[index + 1] === "1") {
      this.auto = 0;
    }
  }
}

function harness(adb: DeviceStateLockAdb) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const rotate = new Rotate(device, adb, timer);
  const observe = new FakeObserveScreen();
  observe.enableAutoVaryHierarchy();
  observe.setObserveResult(() => ({
    timestamp: timer.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
  }));
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  window.configureActiveWindow({ appId: "com.test.app", activityName: "Main", layoutSeqSum: 1 });
  Object.assign(rotate, { awaitIdle: new FakeAwaitIdle(), observeScreen: observe, window });
  return rotate;
}

const lockCommands = (adb: FakeAdbExecutor) =>
  adb
    .getExecutedCommands()
    .filter(
      (c) =>
        c.includes("device_state_rotation_lock") ||
        c.includes("settings put system accelerometer_rotation") ||
        c === "shell cmd device_state state",
    );

describe("Rotate device_state_rotation_lock handling without a session", () => {
  beforeEach(() => AndroidCtrlProxyClient.resetInstances());
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  test("restores the captured lock before turning auto-rotate back on, then reads it back", async () => {
    const adb = new DeviceStateLockAdb();
    // The device stays landscape after auto-rotate returns, so the result is a plain success.
    adb.user = 0;
    const rotate = harness(adb);
    const commandsBefore = adb.getExecutedCommands().length;
    const result = await rotate.execute("landscape");
    expect(adb.auto).toBe(1);
    expect(adb.lock).toBe(BASELINE);
    expect(lockCommands(adb)).toEqual([
      // Captured before accelerometer_rotation=0 records the lock.
      "shell settings get secure device_state_rotation_lock",
      "shell settings put system accelerometer_rotation 0",
      "shell settings put secure device_state_rotation_lock 0:1:1:2:2:0",
      "shell settings put system accelerometer_rotation 1",
    ]);
    const commands = adb.getExecutedCommands().slice(commandsBefore);
    const restore = commands.indexOf("shell settings put system accelerometer_rotation 1");
    expect(commands[restore + 1]).toBe("shell settings get system accelerometer_rotation");
    expect(result.orientationLockState).toBe("unlocked");
    expect(result.warning ?? "").not.toContain("read back");
  });

  test("a device without the setting writes no lock and adds no read-back", async () => {
    const adb = new DeviceStateLockAdb();
    adb.lock = null;
    const rotate = harness(adb);
    await rotate.execute("landscape");
    expect(adb.auto).toBe(1);
    expect(lockCommands(adb)).toEqual([
      "shell settings get secure device_state_rotation_lock",
      "shell settings put system accelerometer_rotation 0",
      "shell settings put system accelerometer_rotation 1",
    ]);
    const commands = adb.getExecutedCommands();
    const restore = commands.indexOf("shell settings put system accelerometer_rotation 1");
    expect(commands[restore + 1]).not.toBe("shell settings get system accelerometer_rotation");
  });

  test("an explicit unlock of a locked device clears the committed state's lock first", async () => {
    const adb = new DeviceStateLockAdb();
    adb.auto = 0;
    adb.lock = LOCKED_STATE_1;
    const rotate = harness(adb);
    const result = await rotate.execute("landscape", undefined, false);
    expect(adb.auto).toBe(1);
    expect(adb.lock).toBe(BASELINE);
    expect(lockCommands(adb)).toEqual([
      "shell settings put system accelerometer_rotation 0",
      "shell settings get secure device_state_rotation_lock",
      "shell cmd device_state state",
      "shell settings put secure device_state_rotation_lock 0:1:1:2:2:0",
      "shell settings put system accelerometer_rotation 1",
    ]);
    expect(result.orientationLockState).toBe("unlocked");
  });

  test("a failed lock write still turns auto-rotate on and reports the read-back mismatch", async () => {
    const adb = new DeviceStateLockAdb();
    adb.failLockWrite = true;
    const rotate = harness(adb);
    const result = await rotate.execute("landscape");
    // Both the first attempt and the retry wrote accelerometer_rotation=1 after the failed lock write.
    expect(
      adb
        .getExecutedCommands()
        .filter((c) => c === "shell settings put system accelerometer_rotation 1"),
    ).toHaveLength(2);
    expect(adb.auto).toBe(0);
    expect(result.warning).toContain("accelerometer_rotation=1 read back 0");
    expect(result.orientationLockState).toBe("locked");
  });
});

describe("unlockDeviceStateRotationEntry", () => {
  test("unlocks only the given state's locked entry", () => {
    expect(unlockDeviceStateRotationEntry(LOCKED_STATE_1, 1)).toBe(BASELINE);
    expect(unlockDeviceStateRotationEntry("0:1:1:1:2:0", 0)).toBe("0:2:1:1:2:0");
  });

  test("returns null when nothing needs writing", () => {
    expect(unlockDeviceStateRotationEntry(BASELINE, 1)).toBeNull();
    expect(unlockDeviceStateRotationEntry(BASELINE, 2)).toBeNull();
    expect(unlockDeviceStateRotationEntry(LOCKED_STATE_1, -1)).toBeNull();
    expect(unlockDeviceStateRotationEntry("0:1:1", 1)).toBeNull();
  });
});
