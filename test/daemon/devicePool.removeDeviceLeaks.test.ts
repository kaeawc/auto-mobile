import { describe, it, expect, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import type { DeviceInfo } from "../../src/models";

// Regressions for #11123 (items 1-3): tracked-process, release-capture and start-timer leaks.
const androidDevice = { name: "Pixel 7", platform: "android" as const, deviceId: "emulator-5554" };

interface PoolInternals {
  startedDeviceProcesses: Map<string, ChildProcess>;
  startedDeviceProcessOutput: Map<string, unknown>;
  releasedDeviceCaptures: Map<string, { deviceId: string }>;
  trackStartedDeviceProcess(device: unknown, child: unknown): Promise<void>;
  captureReleasedDevice(sessionId: string, deviceId: string): void;
  runCoordinatedDeviceStart(device: DeviceInfo, deadlineMs: number, op: "start"): Promise<unknown>;
}

describe("DevicePool removeDevice / start leaks (#11123)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let fakeDeviceUtils: FakeDeviceUtils;

  const build = async (overrides: Partial<DevicePoolDependencies> = {}): Promise<DevicePool> => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session-1", {
        timer,
        deviceManager: fakeDeviceUtils,
        ...overrides,
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
    return pool;
  };
  const internals = (pool: DevicePool): PoolInternals => pool as unknown as PoolInternals;
  const aliveChild = (): ChildProcess => new EventEmitter() as unknown as ChildProcess;

  let pool: DevicePool;
  beforeEach(async () => {
    pool = await build();
  });

  it("keeps the alive emulator process on a liveness-miss removal and clears it on exit", async () => {
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
  });

  it("keeps the alive emulator process when missing-device eviction removes the entry", async () => {
    const child = aliveChild();
    await internals(pool).trackStartedDeviceProcess(androidDevice, child);
    const device = pool.getDevice("emulator-5554")!;

    await (
      pool as unknown as { evictMissingPooledDevice(d: unknown, reason: string): Promise<void> }
    ).evictMissingPooledDevice(device, "missing device during liveness check");

    expect(pool.getDevice("emulator-5554")).toBeNull();
    expect(internals(pool).startedDeviceProcesses.get("emulator-5554")).toBe(child);
  });

  it("forgets the tracked process on deliberate retirement", async () => {
    await internals(pool).trackStartedDeviceProcess(androidDevice, aliveChild());
    await pool.removeDevice("emulator-5554");
    expect(internals(pool).startedDeviceProcesses.has("emulator-5554")).toBe(false);
  });

  it("drops released-device captures for a removed device", async () => {
    const device = pool.getDevice("emulator-5554")!;
    device.sessionId = "s1";
    internals(pool).captureReleasedDevice("s1", "emulator-5554");
    expect(internals(pool).releasedDeviceCaptures.has("s1")).toBe(true);
    device.sessionId = null;

    await pool.removeDevice("emulator-5554");

    expect(internals(pool).releasedDeviceCaptures.size).toBe(0);
  });
});
