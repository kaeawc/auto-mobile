import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PLAN_AUTO_RELEASE_REASON, SessionManager } from "../../src/daemon/sessionManager";
import { Rotate } from "../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeWindow } from "../fakes/FakeWindow";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  rotateHandler,
  setRotateFactory,
  resetRotateFactory,
} from "../../src/server/interactionTools";
import type { ExecResult } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { ActionableError } from "../../src/models/ActionableError";
import { RotationSettingManagedError } from "../../src/models/RotationSettingManagedError";
import { readFileSync } from "fs";
import { join } from "path";

// Captured `cmd device_state print-states` output from a foldable and a phone emulator.
const FOLD_STATES = readFileSync(
  join(__dirname, "..", "fixtures", "android-display", "fold-states.txt"),
  "utf8",
);
const PHONE_STATES = readFileSync(
  join(__dirname, "..", "fixtures", "android-display", "phone-states.txt"),
  "utf8",
);

const device = { deviceId: "rotation-device", name: "Pixel", platform: "android" as const };
const flush = async () => {
  for (let i = 0; i < 80; i++) {
    await Promise.resolve();
  }
};
const output = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s) => stdout.includes(s),
});

class RotationAdb extends FakeAdbExecutor {
  auto: number | null = 1;
  user: number | null = 2;
  live = 0;
  mismatch = false;
  /** `cmd device_state print-states` output; empty reads as a single-state device. */
  deviceStates = "";
  blockRead?: () => Promise<void>;
  /**
   * `secure device_state_rotation_lock`; null models a device without the setting. When set,
   * it mirrors the am-resizable window manager (mt-0083 D1): turning auto-rotate off records
   * a lock in the map, and while the map differs from `lockBaseline` it reverts
   * `accelerometer_rotation=1` to 0.
   */
  lock: string | null = null;
  lockBaseline: string | null = null;
  lockedLock = "0:1:1:1:2:0";
  override async executeCommand(command: string): Promise<ExecResult> {
    await super.executeCommand(command);
    if (command === "shell cmd device_state print-states") {
      return output(this.deviceStates);
    }
    const words = command.split(" ");
    const key = words[4];
    if (command === "shell settings get secure device_state_rotation_lock") {
      return output(this.lock ?? "null");
    }
    if (command.startsWith("shell settings put secure device_state_rotation_lock")) {
      this.lock = words[5];
      return output("");
    }
    if (command.startsWith("shell settings get system")) {
      if (this.blockRead) {
        await this.blockRead();
      }
      return output(String(key === "user_rotation" ? this.user : this.auto));
    }
    if (command.startsWith("shell settings put system")) {
      if (!this.mismatch) {
        if (key === "user_rotation") {
          this.user = Number(words[5]);
        } else {
          this.auto = Number(words[5]);
          this.applyRotationLock();
        }
        if (this.auto === 0 && this.user !== null) {
          this.live = this.user;
        }
      }
      return output("");
    }
    if (command.includes("dumpsys window")) {
      return output(`mRotation=${this.live}`);
    }
    return output("");
  }
  writes() {
    return this.getExecutedCommands().filter((c) => c.startsWith("shell settings put system"));
  }
  private applyRotationLock() {
    if (this.lock === null) {
      return;
    }
    if (this.auto === 0) {
      this.lock = this.lockedLock;
    } else if (this.lock !== this.lockBaseline) {
      this.auto = 0;
    }
  }
}

function harness() {
  const timer = new FakeTimer();
  const sleep = timer.sleep.bind(timer);
  // Fake display settles immediately; keep cleanup/retry deadlines manually driven.
  timer.sleep = (ms) => (ms === 150 ? Promise.resolve() : sleep(ms));
  const adb = new RotationAdb();
  const restored: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: async () => {} }),
    () => ({ restore: async () => {} }),
    {
      networkCondition: () => ({ restore: async () => {} }),
      clock: () => ({ restore: async () => {} }),
      rotation: (target) => ({
        restore: async (state, signal) => {
          restored.push(target.deviceId);
          signals.push(signal);
          await new Rotate(target, adb, timer).restoreRotationSettings(state, signal);
        },
      }),
    },
  );
  const rotate = new Rotate(device, adb, timer, {
    sessionRotation: async (mutation) => {
      const { runSessionRotationMutation } = await import("../../src/server/sessionRotation");
      return runSessionRotationMutation(manager, "rotation-session", device.deviceId, mutation);
    },
  });
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
  window.configureActiveWindow({ appId: "com.test.app", activityName: "Main", layoutSeqSum: 123 });
  const idle = new FakeAwaitIdle();
  Object.assign(rotate, { awaitIdle: idle, observeScreen: observe, window });
  return { timer, adb, manager, rotate, restored, signals };
}

describe("session rotation restoration", () => {
  beforeEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });
  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  test("several session rotates capture originals once, and release restores in order with read-back", async () => {
    const h = harness();
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      expect(h.adb.auto).toBe(0);
      await h.rotate.execute("portrait");
      await h.rotate.execute("landscape", undefined, true);
      expect(h.manager.getRotation("rotation-session")).toEqual({
        accelerometerRotation: 1,
        userRotation: 2,
      });
      const start = h.adb.getExecutedCommands().length;
      await h.manager.releaseSession("rotation-session");
      expect(h.adb.getExecutedCommands().slice(start)).toEqual([
        // Compare-and-skip read: user_rotation already differs, so the restore writes.
        "shell settings get system user_rotation",
        "shell settings put system user_rotation 2",
        "shell settings put system accelerometer_rotation 1",
        "shell settings get system user_rotation",
        "shell settings get system accelerometer_rotation",
      ]);
      expect(h.restored).toEqual([device.deviceId]);
      expect(h.adb.auto).toBe(1);
      expect(h.adb.user).toBe(2);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("release restores device_state_rotation_lock before accelerometer_rotation (mt-0083 D1)", async () => {
    const h = harness();
    h.adb.lock = "0:1:1:2:2:0";
    h.adb.lockBaseline = "0:1:1:2:2:0";
    h.adb.deviceStates = FOLD_STATES;
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      expect(h.adb.lock).toBe("0:1:1:1:2:0");
      expect(h.manager.getRotation("rotation-session")).toEqual({
        accelerometerRotation: 1,
        userRotation: 2,
        deviceStateRotationLock: "0:1:1:2:2:0",
      });
      const start = h.adb.getExecutedCommands().length;
      await h.manager.releaseSession("rotation-session");
      expect(h.adb.getExecutedCommands().slice(start)).toEqual([
        "shell settings get system user_rotation",
        "shell settings put secure device_state_rotation_lock 0:1:1:2:2:0",
        "shell settings put system user_rotation 2",
        "shell settings put system accelerometer_rotation 1",
        "shell settings get system user_rotation",
        "shell settings get system accelerometer_rotation",
      ]);
      expect(h.restored).toEqual([device.deviceId]);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(h.adb.lock).toBe("0:1:1:2:2:0");
      expect(h.adb.auto).toBe(1);
      expect(h.adb.user).toBe(2);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a device without device_state_rotation_lock records and restores no lock", async () => {
    const h = harness();
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      expect(h.manager.getRotation("rotation-session")).not.toHaveProperty(
        "deviceStateRotationLock",
      );
      await h.manager.releaseSession("rotation-session");
      expect(
        h.adb.getExecutedCommands().filter((c) => c.startsWith("shell settings put secure")),
      ).toEqual([]);
      expect(h.adb.auto).toBe(1);
      expect(h.adb.user).toBe(2);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("release read-back mismatch quarantines and retries on FakeTimer", async () => {
    const h = harness();
    try {
      const session = await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      h.adb.mismatch = true;
      await h.manager.releaseSession("rotation-session");
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      expect(pending).not.toBeNull();
      expect(session.cacheData.rotation).toBeDefined();
      h.timer.advanceTime(250);
      await flush();
      expect(h.restored).toHaveLength(2);
      h.adb.mismatch = false;
      // Backoff doubles the second retry delay.
      h.timer.advanceTime(500);
      await pending;
      expect(session.cacheData.rotation).toBeUndefined();
      expect(h.adb.user).toBe(2);
      expect(h.adb.auto).toBe(1);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a restore that never verifies is bounded, logs the reason, and finishes cleanup", async () => {
    // After a fold/unfold the window manager can keep the recorded settings from
    // ever verifying. The retry used to run every 250 ms forever, logging `{}`.
    const h = harness();
    const warn = spyOn(logger, "warn");
    try {
      const session = await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      h.adb.mismatch = true;
      await h.manager.releaseSession("rotation-session");
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      expect(pending).not.toBeNull();
      for (const delay of [250, 500, 1000, 2000, 2000]) {
        h.timer.advanceTime(delay);
        await flush();
      }
      await pending;
      expect(h.restored).toHaveLength(6);
      expect(h.timer.getSleepHistory().filter((ms) => ms !== 150)).toEqual([
        250, 500, 1000, 2000, 2000,
      ]);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(session.cacheData.rotation).toBeUndefined();
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some((m) => m.includes("did not verify by read-back"))).toBe(true);
      expect(messages.some((m) => m.startsWith("Gave up restoring rotation settings"))).toBe(true);
      h.timer.advanceTime(10_000);
      await flush();
      expect(h.restored).toHaveLength(6);
    } finally {
      warn.mockRestore();
      h.manager.stopCleanupTimer();
    }
  });

  test("a window-manager-managed read-back ends release cleanup without retrying", async () => {
    const h = harness();
    const warn = spyOn(logger, "warn");
    try {
      const session = await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      h.adb.mismatch = true;
      h.adb.deviceStates = FOLD_STATES;
      await h.manager.releaseSession("rotation-session");
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      await flush();
      await pending;
      expect(h.restored).toHaveLength(1);
      expect(h.timer.getSleepHistory().filter((ms) => ms !== 150)).toEqual([]);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(session.cacheData.rotation).toBeUndefined();
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(
        messages.some((m) =>
          m.startsWith(
            `Gave up restoring rotation settings on ${device.deviceId} without retrying`,
          ),
        ),
      ).toBe(true);
      h.timer.advanceTime(10_000);
      await flush();
      expect(h.restored).toHaveLength(1);
    } finally {
      warn.mockRestore();
      h.manager.stopCleanupTimer();
    }
  });

  test("a retry that reads back as window-manager-managed stops the remaining retries", async () => {
    const h = harness();
    const warn = spyOn(logger, "warn");
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      h.adb.mismatch = true;
      await h.manager.releaseSession("rotation-session");
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      await flush();
      expect(h.restored).toHaveLength(1);
      // A fold lands before the first retry; that read-back is now managed.
      h.adb.deviceStates = FOLD_STATES;
      h.timer.advanceTime(250);
      await flush();
      await pending;
      expect(h.restored).toHaveLength(2);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some((m) => m.includes("after 1 retries"))).toBe(true);
      h.timer.advanceTime(10_000);
      await flush();
      expect(h.restored).toHaveLength(2);
    } finally {
      warn.mockRestore();
      h.manager.stopCleanupTimer();
    }
  });

  test("rebind restores old device originals and empties replacement slot", async () => {
    const h = harness();
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      await h.manager.rebindSession("rotation-session", "replacement-device", "android");
      expect(h.restored).toEqual([device.deviceId]);
      expect(h.adb.user).toBe(2);
      expect(h.adb.auto).toBe(1);
      expect(h.manager.getRotation("rotation-session")).toBeUndefined();
      await h.manager.releaseSession("rotation-session");
      expect(h.restored).toHaveLength(1);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test.each(["released", "releasing", "rebound", "replaced", "wrong device"])(
    "refused %s setup records nothing and writes nothing",
    async (reason) => {
      const h = harness();
      let release: Promise<unknown> | undefined;
      let complete: (() => void) | undefined;
      try {
        const session = await h.manager.createSession(
          "rotation-session",
          device.deviceId,
          "android",
        );
        if (reason === "released") {
          await h.manager.releaseSession("rotation-session");
        }
        if (reason === "releasing") {
          const gate = Promise.withResolvers<void>();
          complete = gate.resolve;
          void h.manager.trackSessionSetup(session, () => gate.promise);
          release = h.manager.releaseSession("rotation-session");
          await flush();
        }
        if (reason === "rebound") {
          await h.manager.rebindSession("rotation-session", "other", "android");
        }
        if (reason === "replaced") {
          // Capture the old Session in the queued wrapper before replacement.
          const gate = Promise.withResolvers<void>();
          complete = gate.resolve;
          const queued = h.manager.runRotationMutationExclusive(
            "rotation-session",
            () => gate.promise,
          );
          const attempt = h.rotate.execute("landscape");
          await flush();
          await h.manager.releaseSession("rotation-session", PLAN_AUTO_RELEASE_REASON);
          await h.manager.createSession("rotation-session", device.deviceId, "android");
          gate.resolve();
          await queued;
          await expect(attempt).rejects.toThrow();
        } else {
          if (reason === "wrong device") {
            session.assignedDevice = "other";
          }
          await expect(h.rotate.execute("landscape")).rejects.toThrow();
        }
        expect(session.cacheData.rotation).toBeUndefined();
        expect(h.adb.writes()).toEqual([]);
      } finally {
        complete?.();
        await release;
        h.manager.stopCleanupTimer();
      }
    },
  );

  test.each([0, 1])(
    "explicit false enables auto-rotate and retains first originals for release (initial auto %s)",
    async (auto) => {
      const h = harness();
      h.adb.auto = auto;
      try {
        await h.manager.createSession("rotation-session", device.deviceId, "android");
        await h.rotate.execute("landscape");
        const result = await h.rotate.execute("portrait", undefined, false);
        expect(result.orientationLockState).toBe("unlocked");
        expect(h.adb.auto).toBe(1);
        expect(h.adb.user).toBe(2);
        expect(h.manager.getRotation("rotation-session")).toEqual({
          accelerometerRotation: auto,
          userRotation: 2,
        });
        await h.manager.releaseSession("rotation-session");
        expect(h.restored).toEqual([device.deviceId]);
        expect(h.adb.auto).toBe(auto);
      } finally {
        h.manager.stopCleanupTimer();
      }
    },
  );

  test("first false captures originals before writing and retains them on success", async () => {
    const h = harness();
    const setter = spyOn(h.manager, "setRotation");
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape", undefined, false);
      expect(setter).toHaveBeenCalledTimes(1);
      expect(setter.mock.calls[0][1]).toEqual({ accelerometerRotation: 1, userRotation: 2 });
      expect(h.adb.user).toBe(2);
      expect(h.manager.getRotation("rotation-session")).toEqual({
        accelerometerRotation: 1,
        userRotation: 2,
      });
    } finally {
      setter.mockRestore();
      h.manager.stopCleanupTimer();
    }
  });

  test("explicit user restore mismatch warns and retains slot for release retry", async () => {
    const h = harness();
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      const execute = h.adb.executeCommand.bind(h.adb);
      h.adb.executeCommand = async (command) => {
        if (command === "shell settings put system user_rotation 2") {
          h.adb.mismatch = true;
        }
        const result = await execute(command);
        h.adb.mismatch = false;
        return result;
      };
      const result = await h.rotate.execute("portrait", undefined, false);
      expect(result.warning).toContain("user_rotation");
      expect(h.manager.getRotation("rotation-session")).toBeDefined();
      h.adb.executeCommand = execute;
      await h.manager.releaseSession("rotation-session");
      expect(h.adb.user).toBe(2);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("already locked no-op records nothing and release performs no restore", async () => {
    const h = harness();
    h.adb.auto = 0;
    h.adb.live = 1;
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      expect(h.manager.getRotation("rotation-session")).toBeUndefined();
      expect(h.adb.writes()).toEqual([]);
      await h.manager.releaseSession("rotation-session");
      expect(h.restored).toEqual([]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("pool removal retires failed rotation retry before replacement device", async () => {
    const h = harness();
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "rotation-daemon", {
        timer: h.timer,
        deviceManager: utils,
      }),
    );
    try {
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("rotation-session", "android");
      await h.rotate.execute("landscape");
      h.adb.mismatch = true;
      await h.manager.releaseSession("rotation-session");
      await pool.releaseDevice(device.deviceId, "rotation-session");
      expect(pool.getDevice(device.deviceId)?.status).not.toBe("idle");
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      pool.getDevice(device.deviceId)!.sessionId = null;
      await pool.removeDevice(device.deviceId);
      expect(h.signals.at(-1)?.aborted).toBe(true);
      const writes = h.adb.writes().length;
      h.timer.advanceTime(250);
      await pending;
      expect(h.adb.writes()).toHaveLength(writes);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("rotate handler supplies session wrapper through constructor options", async () => {
    const h = harness();
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "rotation-handler", { timer: h.timer }),
    );
    const daemon = DaemonState.getInstance();
    daemon.initialize(h.manager, pool);
    setRotateFactory((target, options) => {
      const feature = new Rotate(target, h.adb, h.timer, options);
      Object.assign(feature, {
        awaitIdle: h.rotate.awaitIdle,
        observeScreen: h.rotate.observeScreen,
        window: h.rotate.window,
      });
      return feature;
    });
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await rotateHandler(device, { orientation: "landscape", sessionUuid: "rotation-session" });
      expect(h.adb.auto).toBe(0);
      expect(h.manager.getRotation("rotation-session")).toEqual({
        accelerometerRotation: 1,
        userRotation: 2,
      });
    } finally {
      resetRotateFactory();
      daemon.reset();
      h.manager.stopCleanupTimer();
    }
  });

  test("explicit user restore deadline warns and keeps slot for release", async () => {
    const h = harness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      expect(h.manager.getRotation("rotation-session")).toBeDefined();
      const execute = h.adb.executeCommand.bind(h.adb);
      h.adb.executeCommand = async (command) => {
        if (command === "shell settings put system user_rotation 2") {
          started.resolve();
          await finish.promise;
        }
        return execute(command);
      };
      const restoring = h.rotate.execute("portrait", undefined, false);
      await started.promise;
      h.timer.advanceTime(1000);
      const result = await restoring;
      expect(result.orientationLockState).toBe("unlocked");
      expect(result.warning).toContain("timed out");
      expect(h.manager.getRotation("rotation-session")).toBeDefined();
      finish.resolve();
      await flush();
      h.adb.executeCommand = execute;
      await h.manager.releaseSession("rotation-session");
      expect(h.adb.user).toBe(2);
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });

  test("slow restore remains quarantined after deadline and retries only after settlement", async () => {
    const h = harness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    try {
      const session = await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      expect(h.manager.getRotation("rotation-session")).toBeDefined();
      const execute = h.adb.executeCommand.bind(h.adb);
      h.adb.executeCommand = async (command) => {
        if (command === "shell settings put system user_rotation 2") {
          started.resolve();
          await finish.promise;
        }
        return execute(command);
      };
      h.adb.mismatch = true;
      const release = h.manager.releaseSession("rotation-session");
      await started.promise;
      h.timer.advanceTime(1000);
      await flush();
      await release;
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      expect(pending).not.toBeNull();
      expect(session.cacheData.rotation).toBeDefined();
      expect(h.restored).toHaveLength(1);
      finish.resolve();
      await flush();
      h.adb.mismatch = false;
      h.timer.advanceTime(250);
      await pending;
      expect(h.restored).toHaveLength(2);
      expect(h.adb.auto).toBe(1);
      expect(h.adb.user).toBe(2);
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });

  test("removal during baseline read prevents all settings writes against replacement", async () => {
    const h = harness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    try {
      const session = await h.manager.createSession("rotation-session", device.deviceId, "android");
      h.adb.blockRead = async () => {
        started.resolve();
        await finish.promise;
      };
      const mutation = h.rotate.execute("landscape");
      await started.promise;
      h.manager.retireRotationRestoration(device.deviceId);
      h.adb.blockRead = undefined;
      finish.resolve();
      await expect(mutation).rejects.toThrow("removed");
      expect(h.adb.writes()).toEqual([]);
      expect(session.cacheData.rotation).toBeUndefined();
      await h.manager.releaseSession("rotation-session");
      expect(h.restored).toEqual([]);
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });

  test("unknown user original fails without writes or a restoration slot", async () => {
    const h = harness();
    h.adb.auto = null;
    h.adb.user = null;
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await expect(h.rotate.execute("landscape")).rejects.toThrow(
        "current rotation setting user_rotation could not be read",
      );
      expect(h.manager.getRotation("rotation-session")).toBeUndefined();
      expect(h.adb.writes()).toEqual([]);
      await h.manager.releaseSession("rotation-session");
      expect(h.restored).toEqual([]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("initially locked rotate, explicit false, rotate again, release restores first originals", async () => {
    const h = harness();
    h.adb.auto = 0;
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await h.rotate.execute("landscape");
      await h.rotate.execute("portrait", undefined, false);
      expect(h.adb.auto).toBe(1);
      expect(h.adb.user).toBe(2);
      const rememberedAfterUnlock = h.manager.getRotation("rotation-session");
      await h.rotate.execute("landscape");
      await h.manager.releaseSession("rotation-session");
      expect(h.adb.auto).toBe(0);
      expect(h.adb.user).toBe(2);
      expect(rememberedAfterUnlock).toEqual({ accelerometerRotation: 0, userRotation: 2 });
      expect(h.manager.getRotation("rotation-session")).toBeUndefined();
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test.each(["final mismatch", "wait failure", "pending auto write", "catch rollback"])(
    "removal during in-flight rotate fences late writes (%s)",
    async (stage) => {
      const h = harness();
      const execute = h.adb.executeCommand.bind(h.adb);
      let writesAtRemoval = 0;
      let userReads = 0;
      try {
        await h.manager.createSession("rotation-session", device.deviceId, "android");
        h.adb.executeCommand = async (command) => {
          const result = await execute(command);
          if (
            command ===
            (stage === "pending auto write"
              ? "shell settings put system accelerometer_rotation 0"
              : "shell settings put system user_rotation 1")
          ) {
            if (stage !== "catch rollback") {
              h.manager.retireRotationRestoration(device.deviceId);
              writesAtRemoval = h.adb.writes().length;
            }
            if (stage === "final mismatch") {
              h.adb.auto = 1;
            }
            if (stage !== "final mismatch") {
              throw new Error("rotation interrupted by removal");
            }
          }
          if (
            stage === "catch rollback" &&
            command === "shell settings get system user_rotation" &&
            ++userReads === 2
          ) {
            h.manager.retireRotationRestoration(device.deviceId);
            writesAtRemoval = h.adb.writes().length;
          }
          if (
            (stage === "final mismatch" || stage === "catch rollback") &&
            command.includes("dumpsys window")
          ) {
            return output("mRotation=0");
          }
          return result;
        };
        // Explicit false also exercises catch-path automatic-rotation restoration.
        const result = await h.rotate.execute(
          "landscape",
          undefined,
          stage === "final mismatch" ? true : false,
        );
        expect(result.success).toBe(false);
        expect(writesAtRemoval).toBeGreaterThan(0);
        expect(h.adb.writes()).toHaveLength(writesAtRemoval);
        expect(h.manager.getRotation("rotation-session")).toBeUndefined();
      } finally {
        h.manager.stopCleanupTimer();
      }
    },
  );

  test("session queue serializes concurrent rotates and preserves the first baseline", async () => {
    const h = harness();
    try {
      await h.manager.createSession("rotation-session", device.deviceId, "android");
      await Promise.all([
        h.rotate.execute("landscape"),
        h.rotate.execute("portrait"),
        h.rotate.execute("landscape"),
      ]);
      expect(h.adb.writes()).toEqual([
        "shell settings put system accelerometer_rotation 0",
        "shell settings put system user_rotation 1",
        "shell settings put system accelerometer_rotation 0",
        "shell settings put system user_rotation 0",
        "shell settings put system accelerometer_rotation 0",
        "shell settings put system user_rotation 1",
      ]);
      expect(h.manager.getRotation("rotation-session")).toEqual({
        accelerometerRotation: 1,
        userRotation: 2,
      });
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test.each(["success", "failure"])(
    "setup finishing after bounded release hands rotation restoration to quarantine (%s)",
    async (restoreOutcome) => {
      const h = harness();
      const start = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      try {
        const session = await h.manager.createSession(
          "rotation-session",
          device.deviceId,
          "android",
        );
        h.adb.blockRead = async () => {
          start.resolve();
          await finish.promise;
        };
        const mutation = h.rotate.execute("landscape");
        await start.promise;
        const release = h.manager.releaseSession("rotation-session");
        await flush();
        h.timer.advanceTime(60_000);
        await flush();
        await release;
        expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
        h.adb.blockRead = undefined;
        let failRestore = restoreOutcome === "failure";
        const execute = h.adb.executeCommand.bind(h.adb);
        // Drop only the restore write; a shared mismatch flag would race the handed-off
        // mutation's still-settling commands.
        const record = FakeAdbExecutor.prototype.executeCommand.bind(h.adb);
        h.adb.executeCommand = async (command) =>
          failRestore && command === "shell settings put system user_rotation 2"
            ? (await record(command), output(""))
            : execute(command);
        finish.resolve();
        await mutation;
        await flush();
        const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
        if (restoreOutcome === "failure") {
          expect(session.cacheData.rotation).toBeDefined();
          expect(pending).not.toBeNull();
          failRestore = false;
          h.timer.advanceTime(250);
        }
        await pending;
        expect(session.cacheData.rotation).toBeUndefined();
        expect(h.restored).toEqual(
          restoreOutcome === "failure" ? [device.deviceId, device.deviceId] : [device.deviceId],
        );
        expect(h.adb.user).toBe(2);
      } finally {
        finish.resolve();
        h.manager.stopCleanupTimer();
      }
    },
  );
});

// afold D7: after rotate → unfold, release must not retry a restore that cannot verify.
describe("restoreRotationSettings compare-and-skip and managed read-back", () => {
  class StatesAdb extends RotationAdb {
    states = PHONE_STATES;
    override async executeCommand(command: string): Promise<ExecResult> {
      return command === "shell cmd device_state print-states"
        ? (await super.executeCommand(command), output(this.states))
        : super.executeCommand(command);
    }
  }
  const restore = (adb: RotationAdb) =>
    new Rotate(device, adb, new FakeTimer()).restoreRotationSettings({
      userRotation: 0,
      accelerometerRotation: 1,
    });
  beforeEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });
  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  test("settings already at the restore values are not written or read back", async () => {
    const adb = new StatesAdb();
    adb.user = 0;
    adb.auto = 1;
    adb.mismatch = true; // A write could never verify; the skip must not attempt one.
    await restore(adb);
    expect(adb.getExecutedCommands()).toEqual([
      "shell settings get system user_rotation",
      "shell settings get system accelerometer_rotation",
    ]);
  });

  test("a read-back mismatch on a foldable is a typed non-retryable outcome", async () => {
    const adb = new StatesAdb();
    adb.states = FOLD_STATES;
    adb.mismatch = true;
    const error = await restore(adb).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RotationSettingManagedError);
    expect((error as RotationSettingManagedError).details).toEqual({
      key: "user_rotation",
      expected: 0,
      actual: "2",
      retryable: false,
    });
  });

  test("a recorded device_state_rotation_lock turns the managed read-back into a verified restore", async () => {
    // am-resizable after rotate: auto-rotate off recorded a lock that reverts accel=1.
    const locked = () => {
      const adb = new StatesAdb();
      adb.states = FOLD_STATES;
      adb.auto = 0;
      adb.user = 1;
      adb.lockBaseline = "0:1:1:2:2:0";
      adb.lock = "0:1:1:1:2:0";
      return adb;
    };
    const withoutLock = locked();
    const error = await restore(withoutLock).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RotationSettingManagedError);
    expect((error as RotationSettingManagedError).details).toMatchObject({
      key: "accelerometer_rotation",
      actual: "0",
    });

    const adb = locked();
    await new Rotate(device, adb, new FakeTimer()).restoreRotationSettings({
      userRotation: 0,
      accelerometerRotation: 1,
      deviceStateRotationLock: "0:1:1:2:2:0",
    });
    expect(adb.getExecutedCommands().filter((c) => c.includes("settings put"))).toEqual([
      "shell settings put secure device_state_rotation_lock 0:1:1:2:2:0",
      "shell settings put system user_rotation 0",
      "shell settings put system accelerometer_rotation 1",
    ]);
    expect(adb.auto).toBe(1);
    expect(adb.lock).toBe("0:1:1:2:2:0");
  });

  test("a matching lock is part of compare-and-skip; a differing lock alone is rewritten", async () => {
    const adb = new StatesAdb();
    adb.user = 0;
    adb.auto = 1;
    adb.lock = "0:1:1:1:2:0";
    const state = { userRotation: 0, accelerometerRotation: 1 as const };
    await new Rotate(device, adb, new FakeTimer()).restoreRotationSettings({
      ...state,
      deviceStateRotationLock: "0:1:1:1:2:0",
    });
    expect(adb.getExecutedCommands().some((c) => c.includes("settings put"))).toBe(false);

    adb.lockBaseline = "0:1:1:2:2:0";
    await new Rotate(device, adb, new FakeTimer()).restoreRotationSettings({
      ...state,
      deviceStateRotationLock: "0:1:1:2:2:0",
    });
    expect(adb.getExecutedCommands().filter((c) => c.includes("settings put"))).toEqual([
      "shell settings put secure device_state_rotation_lock 0:1:1:2:2:0",
      "shell settings put system user_rotation 0",
      "shell settings put system accelerometer_rotation 1",
    ]);
    expect(adb.lock).toBe("0:1:1:2:2:0");
  });

  test("a read-back mismatch on a single-state device stays a generic failure", async () => {
    const adb = new StatesAdb();
    adb.mismatch = true;
    const error = await restore(adb).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).not.toBeInstanceOf(RotationSettingManagedError);
    expect((error as Error).message).toBe(
      "Restoration of user_rotation=0 did not verify by read-back (read 2).",
    );
  });
});
