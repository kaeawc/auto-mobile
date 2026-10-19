import { makePool } from "../helpers/makePool";
import { StreamlessChildProcess } from "../helpers/streamlessChildProcess";
import type { VirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { poolInternals } from "../helpers/devicePoolRecoveryInternals";
import { describe, it, expect } from "bun:test";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { DeviceInfo } from "../../src/models";

// Regressions for #11123 (items 1-3): tracked-process, release-capture and start-timer leaks.
const androidDevice = { name: "Pixel 7", platform: "android" as const, deviceId: "emulator-5554" };

class ThrowingLifecycleCoordinator implements VirtualDeviceLifecycleCoordinator {
  constructor(private readonly error: Error) {}

  isReserved(): boolean {
    return false;
  }

  async reserve(): Promise<never> {
    throw this.error;
  }
}

describe("DevicePool removeDevice / start leaks (#11123)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let fakeDeviceUtils: FakeDeviceUtils;

  const build = async (overrides: Partial<DevicePoolDependencies> = {}): Promise<DevicePool> => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();
    const pool = makePool(sessionManager, "daemon-session-1", {
      timer,
      deviceManager: fakeDeviceUtils,
      ...overrides,
    });
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
    return pool;
  };
  const internals = poolInternals;
  const aliveChild = (): StreamlessChildProcess => new StreamlessChildProcess();

  let pool: DevicePool;
  async function arrangeHarness(): Promise<void> {
    pool = await build();
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

  arranged(
    "keeps the alive emulator process on a liveness-miss removal and clears it on exit",
    async () => {
      const child = aliveChild();
      await internals(pool).trackStartedDeviceProcess(androidDevice, child);
      const device = pool.getDevice("emulator-5554")!;

      await pool.removeDevice("emulator-5554", true, device, { keepTrackedProcess: true });

      expect(internals(pool).startedDeviceProcesses.get("emulator-5554")).toBe(child);
      child.emit("exit", 0, null);
      await Promise.resolve();
      await Promise.resolve();
      expect(internals(pool).startedDeviceProcesses.has("emulator-5554")).toBe(false);
      expect(internals(pool).startedDeviceProcessOutput.has("emulator-5554")).toBe(false);
    },
  );

  arranged(
    "keeps the alive emulator process when missing-device eviction removes the entry",
    async () => {
      const child = aliveChild();
      await internals(pool).trackStartedDeviceProcess(androidDevice, child);
      const device = pool.getDevice("emulator-5554")!;

      await internals(pool).evictMissingPooledDevice(
        device,
        "missing device during liveness check",
      );

      expect(pool.getDevice("emulator-5554")).toBeNull();
      expect(internals(pool).startedDeviceProcesses.get("emulator-5554")).toBe(child);
    },
  );

  arranged("forgets the tracked process on deliberate retirement", async () => {
    await internals(pool).trackStartedDeviceProcess(androidDevice, aliveChild());
    await pool.removeDevice("emulator-5554");
    expect(internals(pool).startedDeviceProcesses.has("emulator-5554")).toBe(false);
  });

  arranged("drops released-device captures for a removed device", async () => {
    const device = pool.getDevice("emulator-5554")!;
    device.sessionId = "s1";
    internals(pool).captureReleasedDevice("s1", "emulator-5554");
    expect(internals(pool).releasedDeviceCaptures.has("s1")).toBe(true);
    device.sessionId = null;

    await pool.removeDevice("emulator-5554");

    expect(internals(pool).releasedDeviceCaptures.size).toBe(0);
  });

  arranged("clears the start deadline timer when lifecycle reserve throws", async () => {
    const reserveError = new Error("reserve failed");
    pool = await build({
      lifecycleCoordinator: new ThrowingLifecycleCoordinator(reserveError),
    });
    const before = timer.getPendingTimeoutCount();

    await expect(
      internals(pool).runCoordinatedDeviceStart(
        { name: "Pixel 7", platform: "android" } as DeviceInfo,
        timer.now() + 60_000,
        "start",
      ),
    ).rejects.toBe(reserveError);

    expect(timer.getPendingTimeoutCount()).toBe(before);
  });
});
