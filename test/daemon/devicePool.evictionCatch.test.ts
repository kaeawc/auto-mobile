import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { logger } from "../../src/utils/logger";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import {
  clearAndroidImeQuarantine,
  quarantineAndroidIme,
  withAndroidImeLock,
} from "../../src/features/action/androidImeLock";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

// Regression for #3593: the emulator-exit eviction was a fire-and-forget
// `void this.evictStartedDeviceAfterProcessExit(...)` with no rejection handler.
// If the eviction chain rejected, it surfaced as an unhandled promise rejection
// fired from a ChildProcess "exit" listener. It must now be caught and logged.
describe("DevicePool emulator-exit eviction rejection handling", () => {
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  let fakeDeviceUtils: FakeDeviceUtils;
  const androidDevice = {
    name: "Pixel 7",
    platform: "android" as const,
    deviceId: "emulator-5554",
  };

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session-1", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
  });

  afterEach(() => {
    timer.clearAllTimers?.();
  });

  it("logs a warning and does not throw when eviction rejects on process exit", async () => {
    const warnSpy = spyOn(logger, "warn");
    const evictError = new Error("removeDevice failed");
    // Force the eviction chain to reject.
    const evictSpy = spyOn(
      pool as unknown as {
        evictMissingPooledDevice: (...args: unknown[]) => Promise<void>;
      },
      "evictMissingPooledDevice",
    ).mockRejectedValue(evictError);

    const child = new EventEmitter();
    // Register the exit listener under test.
    (
      pool as unknown as {
        trackStartedDeviceProcess: (device: unknown, child: unknown) => void;
      }
    ).trackStartedDeviceProcess(androidDevice, child);

    // Fire the process-exit event; the rejection must be caught, not unhandled.
    child.emit("exit", 1, null);

    const hasLoggedEviction = (): boolean =>
      warnSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Failed to evict emulator-5554"),
      );

    // Let the rejected eviction promise settle through the .catch (microtasks only).
    for (let turn = 0; turn < 50 && !hasLoggedEviction(); turn++) {
      await Promise.resolve();
    }

    expect(evictSpy).toHaveBeenCalledTimes(1);
    expect(hasLoggedEviction()).toBe(true);

    warnSpy.mockRestore();
    evictSpy.mockRestore();
  });

  it("persists redacted post-ready process diagnostics and recovery outcome", async () => {
    const incidentStore = new InMemoryEmulatorLossIncidentStore(
      timer,
      new CountingIdGenerator("test"),
    );
    const diagnosticPool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session-1", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
        emulatorLossIncidentStore: incidentStore,
      }),
    );
    await diagnosticPool.initializeWithDevices([androidDevice]);
    const pooled = diagnosticPool.getDevice(androidDevice.deviceId)!;
    pooled.avdName = "Pixel_7";
    pooled.androidImage = {
      name: "Pixel_7",
      platform: "android",
      isRunning: false,
      source: "local",
    };

    const child = new EventEmitter() as unknown as {
      once(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ): void;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    await (
      diagnosticPool as unknown as {
        trackStartedDeviceProcess: (device: unknown, child: unknown) => Promise<void>;
      }
    ).trackStartedDeviceProcess(androidDevice, child);
    child.stdout.emit("data", Buffer.from("token="));
    (child as unknown as EventEmitter).emit("exit", 1, null);
    child.stderr.emit("data", Buffer.from("emulator died\n"));
    child.stdout.emit("data", Buffer.from("should-not-leak\n"));
    (child as unknown as EventEmitter).emit("close", 1, null);

    let [incident] = await incidentStore.list();
    for (let turn = 0; turn < 30 && incident?.recovery.outcome === undefined; turn++) {
      await Promise.resolve();
      [incident] = await incidentStore.list();
    }
    expect(incident).toMatchObject({
      deviceId: "emulator-5554",
      avdName: "Pixel_7",
      detectionPath: "watched-process-exit",
      processExit: { code: 1, signal: null },
      outputTail: "token=[REDACTED]\nemulator died\n",
      recovery: {
        policy: { onLoss: false, maxAttempts: 2 },
        attempts: [],
        outcome: "not-attempted",
      },
    });
    expect(incident.outputTail).not.toContain("should-not-leak");
  });
});

describe("device removal IME quarantine", () => {
  const device = { deviceId: "ime-removal-serial", name: "Pixel", platform: "android" as const };
  const otherId = "ime-unrelated-serial";
  let manager: SessionManager;
  let pool: DevicePool;
  let devices: FakeDeviceUtils;

  beforeEach(async () => {
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", [device]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "ime-removal", {
        timer,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        recoveryPolicy: { onLoss: false, maxAttempts: 0 },
      }),
    );
    await pool.initializeWithDevices([device]);
    quarantineAndroidIme(device.deviceId);
    quarantineAndroidIme(otherId);
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    clearAndroidImeQuarantine(device.deviceId);
    clearAndroidImeQuarantine(otherId);
  });

  it.each(["remove", "disconnect", "refresh", "shutdown", "replacement"] as const)(
    "%s clears only the removed device's IME quarantine",
    async (route) => {
      const captured = pool.getDevice(device.deviceId)!;
      if (route === "remove") {
        await pool.removeDevice(device.deviceId);
      } else if (route === "disconnect") {
        devices.setBootedDevices("android", []);
        await pool.removeDisconnectedDevice(device.deviceId, false);
      } else if (route === "refresh") {
        devices.setBootedDevices("android", []);
        for (let miss = 0; miss < 3; miss++) {
          await pool.refreshDevices();
        }
        expect(pool.getDevice(device.deviceId)).toBeNull();
      } else if (route === "shutdown") {
        await pool.retireDeviceForShutdown(captured);
      } else {
        await pool.replaceDeviceForShutdown(captured, { ...device, name: "Fresh Pixel" });
        expect(pool.getDevice(device.deviceId)?.incarnation).not.toBe(captured.incarnation);
      }
      expect(await withAndroidImeLock(device.deviceId, async () => "allowed")).toBe("allowed");
      await expect(withAndroidImeLock(otherId, async () => true)).rejects.toThrow(
        "IME state is unknown",
      );
    },
  );

  it("removing one serial leaves another serial quarantined", async () => {
    await pool.removeDevice(device.deviceId);
    await expect(withAndroidImeLock(otherId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });

  it("session release keeps quarantine on the same pooled incarnation", async () => {
    await pool.bindOrReuseDeviceSession("ime-owner", device.deviceId, "android");
    const captured = pool.getDevice(device.deviceId);
    await manager.releaseSession("ime-owner");
    await pool.releaseDevice(device.deviceId, "ime-owner");
    expect(pool.getDevice(device.deviceId)).toBe(captured);
    expect(pool.getDevice(device.deviceId)?.status).toBe("idle");
    await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });

  it("stale removal cannot clear a replacement's new quarantine", async () => {
    const captured = pool.getDevice(device.deviceId)!;
    await pool.replaceDeviceForShutdown(captured, device);
    quarantineAndroidIme(device.deviceId);
    await pool.removeDevice(device.deviceId, true, captured);
    await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });
});
