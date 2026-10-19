import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { makePool } from "../helpers/makePool";
import { StreamlessChildProcess } from "../helpers/streamlessChildProcess";
import type { VirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { describe, it, expect } from "bun:test";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

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
      await pool.testHooks.trackStartedDeviceProcess.call(androidDevice, child);
      const device = pool.getDevice("emulator-5554")!;

      await pool.removeDevice("emulator-5554", true, device, { keepTrackedProcess: true });

      expect(pool.testHooks.startedDeviceProcesses.get("emulator-5554")).toBe(child);
      child.emit("exit", 0, null);
      await Promise.resolve();
      await Promise.resolve();
      expect(pool.testHooks.startedDeviceProcesses.has("emulator-5554")).toBe(false);
      expect(pool.testHooks.startedDeviceProcessOutput.has("emulator-5554")).toBe(false);
    },
  );

  arranged(
    "keeps the alive emulator process when missing-device eviction removes the entry",
    async () => {
      const child = aliveChild();
      await pool.testHooks.trackStartedDeviceProcess.call(androidDevice, child);
      const device = pool.getDevice("emulator-5554")!;

      await pool.testHooks.evictMissingPooledDevice.call(
        device,
        "missing device during liveness check",
      );

      expect(pool.getDevice("emulator-5554")).toBeNull();
      expect(pool.testHooks.startedDeviceProcesses.get("emulator-5554")).toBe(child);
    },
  );

  arranged("forgets the tracked process on deliberate retirement", async () => {
    await pool.testHooks.trackStartedDeviceProcess.call(androidDevice, aliveChild());
    await pool.removeDevice("emulator-5554");
    expect(pool.testHooks.startedDeviceProcesses.has("emulator-5554")).toBe(false);
  });

  arranged("drops released-device captures for a removed device", async () => {
    const device = pool.getDevice("emulator-5554")!;
    patchDeviceBinding(device, { sessionId: "s1" });
    pool.testHooks.captureReleasedDevice("s1", "emulator-5554");
    expect(pool.testHooks.releasedDeviceCaptures.has("s1")).toBe(true);
    patchDeviceBinding(device, { sessionId: null });

    await pool.removeDevice("emulator-5554");

    expect(pool.testHooks.releasedDeviceCaptures.size).toBe(0);
  });

  arranged("clears the start deadline timer when lifecycle reserve throws", async () => {
    const reserveError = new Error("reserve failed");
    pool = await build({
      lifecycleCoordinator: new ThrowingLifecycleCoordinator(reserveError),
    });
    const before = timer.getPendingTimeoutCount();

    await expect(
      pool.testHooks.runCoordinatedDeviceStart(
        { name: "Pixel 7", platform: "android", isRunning: false },
        timer.now() + 60_000,
        "start",
        async () => undefined,
      ),
    ).rejects.toBe(reserveError);

    expect(timer.getPendingTimeoutCount()).toBe(before);
  });
});
