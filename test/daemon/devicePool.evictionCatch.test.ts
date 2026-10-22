import { makePool } from "../helpers/makePool";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { describe, it, expect, afterEach, spyOn, mock } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { logger } from "../../src/utils/logger";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
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

  async function arrangeHarness(): Promise<void> {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();
    pool = makePool(sessionManager, "daemon-session-1", {
      timer: timer,
      deviceManager: fakeDeviceUtils,
    });
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    it(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  it("logs a warning and does not throw when eviction rejects on process exit", async () => {
    await arrangeHarness();
    const warnSpy = spyOn(logger, "warn");
    const evictError = new Error("removeDevice failed");
    // Force the eviction chain to reject.
    let evictCalls = 0;
    const restoreEvict = pool.testHooks.evictMissingPooledDevice.intercept(() => async () => {
      evictCalls++;
      throw evictError;
    });

    const child = new FakeChildProcess();
    // Register the exit listener under test.
    await pool.testHooks.trackStartedDeviceProcess.call(androidDevice, child);

    // Fire the process-exit event; the rejection must be caught, not unhandled.
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    const hasLoggedEviction = (): boolean =>
      warnSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Failed to evict emulator-5554"),
      );

    // Let the rejected eviction promise settle through the .catch (microtasks only).
    for (let turn = 0; turn < 50 && !hasLoggedEviction(); turn++) {
      await Promise.resolve();
    }

    expect(evictCalls).toBe(1);
    expect(hasLoggedEviction()).toBe(true);

    warnSpy.mockRestore();
    restoreEvict();
  });

  arranged("persists redacted post-ready process diagnostics and recovery outcome", async () => {
    const incidentStore = new InMemoryEmulatorLossIncidentStore(
      timer,
      new CountingIdGenerator("test"),
    );
    const diagnosticPool = makePool(sessionManager, "daemon-session-1", {
      timer: timer,
      deviceManager: fakeDeviceUtils,
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      emulatorLossIncidentStore: incidentStore,
    });
    await diagnosticPool.initializeWithDevices([androidDevice]);
    const pooled = diagnosticPool.getDevice(androidDevice.deviceId)!;
    pooled.avdName = "Pixel_7";
    pooled.androidImage = {
      name: "Pixel_7",
      platform: "android",
      isRunning: false,
      source: "local",
    };

    const child = new FakeChildProcess();
    await diagnosticPool.testHooks.trackStartedDeviceProcess.call(androidDevice, child);
    child.stdout.emit("data", Buffer.from("token="));
    child.emit("exit", 1, null);
    child.stderr.emit("data", Buffer.from("emulator died\n"));
    child.stdout.emit("data", Buffer.from("should-not-leak\n"));
    child.emit("close", 1, null);

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

describe("device identity replacement IME quarantine", () => {
  const device = { deviceId: "emulator-19554", name: "Pixel", platform: "android" as const };
  const otherId = "ime-unrelated-serial";
  let manager: SessionManager;
  let pool: DevicePool;
  let devices: FakeDeviceUtils;

  async function arrangeHarness2(): Promise<void> {
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", [device]);
    pool = makePool(manager, "ime-removal", {
      timer,
      deviceManager: devices,
      recoveryPolicy: { onLoss: false, maxAttempts: 0 },
    });
    await pool.initializeWithDevices([device]);
    quarantineAndroidIme(device.deviceId);
    quarantineAndroidIme(otherId);
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged2(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    it(
      name,
      async () => {
        await arrangeHarness2();
        await fn();
      },
      timeout,
    );
  }

  function arrangedEach2<T>(table: readonly T[]) {
    return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
      for (const row of table) {
        arranged2(name.replace("%s", String(row)), () => fn(row), timeout);
      }
    };
  }

  afterEach(() => {
    manager.stopCleanupTimer();
    clearAndroidImeQuarantine(device.deviceId);
    clearAndroidImeQuarantine(otherId);
  });

  arranged2("different runtime identity clears only the replaced serial's quarantine", async () => {
    const captured = pool.getDevice(device.deviceId)!;
    devices.setBootedDevices("android", [{ ...device, name: "Different_AVD" }]);
    await pool.refreshDevices();
    expect(pool.getDevice(device.deviceId)?.name).toBe("Different_AVD");
    expect(pool.getDevice(device.deviceId)?.incarnation).not.toBe(captured.incarnation);
    expect(await withAndroidImeLock(device.deviceId, async () => "allowed")).toBe("allowed");
    await expect(withAndroidImeLock(otherId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });

  arranged2(
    "a concurrently removed identity entry still pools the replacement without clearing quarantine",
    async () => {
      const captured = pool.getDevice(device.deviceId)!;
      const internals = pool.testHooks;
      let replaced: boolean | undefined;
      let replaceCalls = 0;
      const restoreReplace = internals.replacePooledDeviceForRuntimeIdentity.intercept(
        (replace) => async (pooled, booted) => {
          replaceCalls++;
          expect(pooled).toBe(captured);
          await pool.removeDevice(pooled.id);
          expect(pool.getDevice(pooled.id)).toBeNull();
          replaced = await replace(pooled, booted);
          return replaced;
        },
      );
      try {
        devices.setBootedDevices("android", [{ ...device, name: "Different_AVD" }]);
        await pool.refreshDevices();
        expect(replaceCalls).toBe(1);
        expect(replaced).toBe(true);
        expect(pool.getDevice(device.deviceId)?.name).toBe("Different_AVD");
        expect(pool.getDevice(device.deviceId)?.incarnation).not.toBe(captured.incarnation);
        await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
          "IME state is unknown",
        );
      } finally {
        restoreReplace();
      }
    },
  );

  arrangedEach2([
    "remove",
    "disconnect",
    "three-miss refresh",
    "liveness eviction",
    "shutdown",
    "same-AVD replacement",
    "kill and relaunch",
  ] as const)("%s keeps the device's IME quarantine", async (route) => {
    const captured = pool.getDevice(device.deviceId)!;
    if (route === "remove") {
      await pool.removeDevice(device.deviceId);
    } else if (route === "disconnect") {
      devices.setBootedDevices("android", []);
      await pool.removeDisconnectedDevice(device.deviceId, false);
    } else if (route === "three-miss refresh") {
      devices.setBootedDevices("android", []);
      for (let miss = 0; miss < 3; miss++) {
        await pool.refreshDevices();
        if (miss < 2) {
          expect(pool.getDevice(device.deviceId)).toBe(captured);
        }
      }
    } else if (route === "liveness eviction") {
      await pool.testHooks.evictMissingPooledDevice.call(
        captured,
        "missing device during liveness check",
      );
    } else if (route === "shutdown") {
      expect(await pool.retireDeviceForShutdown(captured)).toBe(true);
    } else if (route === "same-AVD replacement") {
      await pool.replaceDeviceForShutdown(captured, device);
      expect(pool.getDevice(device.deviceId)?.incarnation).not.toBe(captured.incarnation);
    } else {
      await pool.retireDeviceForShutdown(captured);
      await pool.refreshDevices();
      expect(pool.getDevice(device.deviceId)?.name).toBe(device.name);
      expect(pool.getDevice(device.deviceId)?.incarnation).not.toBe(captured.incarnation);
    }
    if (route !== "same-AVD replacement" && route !== "kill and relaunch") {
      expect(pool.getDevice(device.deviceId)).toBeNull();
    }
    await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
    await expect(withAndroidImeLock(otherId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });

  arranged2(
    "shutdown replacement without an identity decision keeps quarantine even for a new name",
    async () => {
      const captured = pool.getDevice(device.deviceId)!;
      await pool.replaceDeviceForShutdown(captured, { ...device, name: "Different_AVD" });
      expect(pool.getDevice(device.deviceId)?.name).toBe("Different_AVD");
      await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
        "IME state is unknown",
      );
    },
  );

  arrangedEach2(["old", "new"] as const)(
    "an unverified %s placeholder keeps quarantine",
    async (side) => {
      if (side === "old") {
        await pool.removeDevice(device.deviceId);
        const unknown = { ...device, name: `Unknown (${device.deviceId})` };
        devices.setBootedDevices("android", [unknown]);
        await pool.initializeWithDevices([unknown]);
        // Setup retirement must not determine the assertion's quarantine state.
        quarantineAndroidIme(device.deviceId);
      }
      devices.setBootedDevices("android", [
        {
          ...device,
          name: side === "new" ? `Unknown (${device.deviceId})` : "Different_AVD",
        },
      ]);
      await pool.refreshDevices();
      await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
        "IME state is unknown",
      );
    },
  );

  arranged2(
    "a deferred identity eviction keeps quarantine while the old entry is pooled",
    async () => {
      const captured = pool.getDevice(device.deviceId)!;
      const reservation = await pool.reserveDeviceForShutdown(captured.id);
      if (!reservation) {
        throw new Error("Expected shutdown reservation");
      }
      try {
        devices.setBootedDevices("android", [{ ...device, name: "Different_AVD" }]);
        await pool.refreshDevices();
        expect(pool.getDevice(device.deviceId)).toBe(captured);
        await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
          "IME state is unknown",
        );
      } finally {
        void reservation.release();
      }
    },
  );

  arranged2("a superseded identity decision cannot clear the successor's quarantine", async () => {
    const captured = pool.getDevice(device.deviceId)!;
    await pool.replaceDeviceForShutdown(captured, { ...device, name: "Replacement_AVD" });
    quarantineAndroidIme(device.deviceId);
    const replaced = await pool.testHooks.replacePooledDeviceForRuntimeIdentity.call(captured, {
      ...device,
      name: "Different_AVD",
    });
    expect(replaced).toBe(false);
    expect(pool.getDevice(device.deviceId)?.name).toBe("Replacement_AVD");
    await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });

  arranged2(
    "identity cleanup cannot clear a successor quarantined while cache cleanup is pending",
    async () => {
      const captured = pool.getDevice(device.deviceId)!;
      const internals = pool.testHooks;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const restoreCleanup = internals.clearDeviceSessionCache.intercept(
        (cleanup) => async (deviceId) => {
          started.resolve();
          await finish.promise;
          await cleanup(deviceId);
        },
      );
      let replacement: Promise<boolean> | undefined;
      try {
        replacement = internals.replacePooledDeviceForRuntimeIdentity.call(captured, {
          ...device,
          name: "Different_AVD",
        });
        await started.promise;
        expect(pool.getDevice(device.deviceId)).toBeNull();
        await pool.addDevice({ ...device, name: "Successor_AVD" });
        quarantineAndroidIme(device.deviceId);
        finish.resolve();
        expect(await replacement).toBe(false);
        expect(pool.getDevice(device.deviceId)?.name).toBe("Successor_AVD");
        await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
          "IME state is unknown",
        );
      } finally {
        finish.resolve();
        await replacement;
        restoreCleanup();
      }
    },
  );

  arranged2("newer unresolved evidence during identity cleanup keeps quarantine", async () => {
    const captured = pool.getDevice(device.deviceId)!;
    const internals = pool.testHooks;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const restoreCleanup = internals.clearDeviceSessionCache.intercept(
      (cleanup) => async (deviceId) => {
        started.resolve();
        await finish.promise;
        await cleanup(deviceId);
      },
    );
    let replacement: Promise<boolean> | undefined;
    try {
      replacement = internals.replacePooledDeviceForRuntimeIdentity.call(captured, {
        ...device,
        name: "Different_AVD",
        observedAt: 2,
      });
      await started.promise;
      await pool.reconcileDiscoveryObservation(
        [{ ...device, name: `Unknown (${device.deviceId})`, observedAt: 3 }],
        "test:unresolved-during-replacement",
      );
      finish.resolve();
      expect(await replacement).toBe(true);
      expect(pool.getDevice(device.deviceId)?.identityUnresolved).toBe(true);
      await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
        "IME state is unknown",
      );
    } finally {
      finish.resolve();
      await replacement;
      restoreCleanup();
    }
  });

  arranged2("session release keeps quarantine on the same pooled incarnation", async () => {
    await pool.bindOrReuseDeviceSession({
      sessionId: "ime-owner",
      deviceId: device.deviceId,
      platform: "android",
    });
    const captured = pool.getDevice(device.deviceId);
    await manager.releaseSession("ime-owner");
    await pool.releaseDevice(device.deviceId, "ime-owner");
    expect(pool.getDevice(device.deviceId)).toBe(captured);
    expect(pool.getDevice(device.deviceId)?.status).toBe("idle");
    await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });

  arranged2("stale removal cannot clear a replacement's new quarantine", async () => {
    const captured = pool.getDevice(device.deviceId)!;
    await pool.replaceDeviceForShutdown(captured, device);
    quarantineAndroidIme(device.deviceId);
    await pool.removeDevice(device.deviceId, true, captured);
    await expect(withAndroidImeLock(device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
  });
});

afterEach(() => {
  mock.restore();
});
