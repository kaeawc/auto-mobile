import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerScreenLockSessionCleanup,
  screenLockRestoreResult,
  startScreenLockRestore,
} from "../../src/daemon/screenLockSessionCleanup";
import { AdbLockSettingsClient } from "../../src/features/utility/screenLock/AndroidLockSettings";
import { ScreenLockRegistry } from "../../src/features/utility/screenLock/ScreenLockRegistry";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeLockSettingsClient } from "../fakes/FakeLockSettingsClient";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const PIN = "1357";
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../fixtures/android-lock-settings", name), "utf8");
const stdout = (text: string) => createExecResult(text, "");

function setup(options: { adb?: FakeAdbExecutor; client?: FakeLockSettingsClient } = {}) {
  const manager = new FakeSessionCleanupManager();
  const registry = new ScreenLockRegistry();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const forgotten: string[] = [];
  registerScreenLockSessionCleanup(manager, {
    registry,
    timer,
    clientFactory: () =>
      options.client ?? new AdbLockSettingsClient(options.adb ?? new FakeAdbExecutor()),
    forgetRememberedUnlock: async (deviceId) => {
      forgotten.push(deviceId);
    },
  });
  registry.record({ deviceId: DEVICE, sessionId: "s-1", type: "pin", credential: PIN });
  return { manager, registry, timer, forgotten };
}

describe("registerScreenLockSessionCleanup", () => {
  test("release clears the session's credential over adb and reports it", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "locksettings clear",
      stdout(`${fixture("locksettings-clear-ok.txt")}AUTOMOBILE_LOCKSETTINGS_EXIT=0\n`),
    );
    adb.setCommandResponse(
      "dumpsys lock_settings",
      stdout(fixture("dumpsys-lock-settings-api34-none.txt")),
    );
    const { manager, registry, timer, forgotten } = setup({ adb });

    manager.release("s-1", DEVICE);
    await manager.settle();

    expect(adb.getExecutedArgv()[0]).toEqual([
      "shell",
      "locksettings",
      "clear",
      "--old",
      PIN,
      ";",
      "echo",
      "AUTOMOBILE_LOCKSETTINGS_EXIT=$?",
    ]);
    expect(manager.pendingCleanups.map(({ deviceId, bound }) => [deviceId, bound])).toEqual([
      [DEVICE, { name: "clear session screen lock", leftover: expect.any(String) }],
    ]);
    expect(await screenLockRestoreResult("s-1", { registry, timer })).toEqual({
      screenLockRestore: { status: "cleared", deviceId: DEVICE, type: "pin", verified: true },
    });
    expect(registry.get(DEVICE)).toBeUndefined();
    expect(forgotten).toEqual([DEVICE]);
  });

  test("a failed clear is reported loudly in the release result, without the credential", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const client = new FakeLockSettingsClient({ type: "pin", credential: PIN });
      client.nextResults.push(
        { outcome: "failed", detail: "device offline" },
        { outcome: "failed", detail: "device offline" },
      );
      const { manager, registry, timer } = setup({ client });

      manager.release("s-1", DEVICE);
      const { screenLockRestore } = await screenLockRestoreResult("s-1", { registry, timer });

      expect(screenLockRestore).toMatchObject({ status: "failed", deviceId: DEVICE, type: "pin" });
      expect(JSON.stringify(screenLockRestore)).toContain("blocks every later session");
      expect(client.writes()).toHaveLength(2);
      expect(JSON.stringify([screenLockRestore, warn.mock.calls])).not.toContain(PIN);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a refused credential is not retried (each refusal counts toward lockout)", async () => {
    const client = new FakeLockSettingsClient({ type: "pin", credential: "9999" });
    const { manager, registry, timer } = setup({ client });

    manager.release("s-1", DEVICE);
    const { screenLockRestore } = await screenLockRestoreResult("s-1", { registry, timer });

    expect(screenLockRestore).toMatchObject({ status: "failed" });
    expect(client.writes()).toHaveLength(1);
  });

  test("another session's release, a reason upgrade and a replaced device leave the lock", async () => {
    const client = new FakeLockSettingsClient({ type: "pin", credential: PIN });
    const { manager, registry, timer } = setup({ client });

    manager.release("s-other", DEVICE);
    manager.release("s-1", DEVICE, true);
    expect(registry.get(DEVICE)?.sessionId).toBe("s-1");

    manager.release("s-1", DEVICE, false, true);
    expect(await screenLockRestoreResult("s-1", { registry, timer })).toMatchObject({
      screenLockRestore: { status: "skipped" },
    });
    expect(client.calls).toEqual([]);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("moving off the device clears the lock left on it", async () => {
    const client = new FakeLockSettingsClient({ type: "pin", credential: PIN });
    const { manager } = setup({ client });

    manager.unbound("s-1", DEVICE);
    await manager.settle();

    expect(client.lock).toBeNull();
  });
});

describe("screenLockRestoreResult", () => {
  test("is empty for a session that set no lock", async () => {
    expect(await screenLockRestoreResult("s-none", { registry: new ScreenLockRegistry() })).toEqual(
      {},
    );
  });

  test("reports a clear still running at the teardown cap as pending", async () => {
    const registry = new ScreenLockRegistry();
    const timer = new FakeTimer();
    registry.noteRestore("s-1", new Promise(() => {}));

    const result = screenLockRestoreResult("s-1", { registry, timer });
    timer.advanceTime(10_000);

    expect(await result).toEqual({ screenLockRestore: { status: "pending" } });
  });
});

describe("startScreenLockRestore", () => {
  test("a client that cannot be created is a failed report, not a thrown release callback", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const manager = new FakeSessionCleanupManager();
      const registry = new ScreenLockRegistry();
      const report = await startScreenLockRestore(
        manager,
        { deviceId: DEVICE, sessionId: "s-1", type: "pin", credential: PIN },
        {
          registry,
          clientFactory: () => {
            throw new Error("Refusing to run an adb command on device 'emulator-5554'");
          },
        },
      );
      expect(report).toMatchObject({ status: "failed", deviceId: DEVICE });
      expect(await registry.restoreReport("s-1")).toBe(report);
      expect(manager.pendingCleanups).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
