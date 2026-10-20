import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { makePool } from "../helpers/makePool";
import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// Repro (adoptOnly gap from #7558): when the pool's tracked emulator child has
// already exited, stopAndroidEmulatorForRecovery calls
// stopDiscoveredEmulatorByAvdName(..., adoptOnly = true). If fresh discovery
// still lists the SAME AVD at the SAME serial, adoptOnly returns "stopped"
// without killing it or confirming disappearance, so recovery relaunches an
// AVD that is still running. The real PlatformDeviceManager.startDevice
// rejects that ("already running", src/utils/deviceUtils.ts), which spends the
// crash-loop budget, marks the incident exhausted, and releases the session
// instead of adopting the live emulator (the new-serial variant adopts).

/** A launcher process that already exited with code 1 and must never be signalled again. */
function exitedLauncherProcess(): FakeChildProcess {
  const process = new FakeChildProcess();
  process.pid = 42;
  process.exitCode = 1;
  process.kill = () => {
    throw new Error("An exited process must not be killed");
  };
  return process;
}

const original: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};
const image: DeviceInfo = {
  name: original.name,
  platform: "android",
  isRunning: true,
  source: "local",
};

/** Mirrors PlatformDeviceManager.startDevice's name-based "already running" pre-check. */
class RealisticStartManager extends FakeDeviceManager {
  readonly kills: string[] = [];
  /** Discovery snapshot (by deviceId) at the moment each startDevice was issued. */
  readonly listedAtRelaunch: string[][] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.kills.push(device.deviceId);
  }

  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.listedAtRelaunch.push(this.bootedDevices.map((d) => d.deviceId));
    this.startedDevices.push(device);
    if (this.bootedDevices.some((booted) => booted.name === device.name)) {
      throw new ActionableError(`${device.platform} device '${device.name}' is already running`);
    }
    this.bootedDevices = [original];
    return { pid: 0 } as ChildProcess;
  }

  override async waitForDeviceReady(): Promise<BootedDevice> {
    return this.bootedDevices[0];
  }
}

test("adoptOnly recovery does not relaunch an AVD still listed at the same serial after its tracked process exits", async () => {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new RealisticStartManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: true, maxAttempts: 1 },
  });
  try {
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession({
      sessionId: "session",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
      expectedIdentity: original,
    });
    const captured = pool.getDevice(original.deviceId)!;

    // AutoMobile launched this emulator; its tracked child has since exited.
    const exitedProcess = exitedLauncherProcess();
    pool.testHooks.startedDeviceProcesses.set(original.deviceId, exitedProcess);

    // Fresh discovery still lists the same AVD, resolved, at the same serial.
    manager.bootedDevices = [original];

    const result = await pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );

    const observed = {
      result,
      // A relaunch must never be issued while the AVD is still listed.
      relaunchedWhileListed: manager.listedAtRelaunch.filter((ids) =>
        ids.includes(original.deviceId),
      ),
      kills: manager.kills,
      sessionDevice: sessions.getSession("session")?.assignedDevice,
    };
    expect(observed).toEqual({
      result: "recovered",
      relaunchedWhileListed: [],
      kills: [],
      sessionDevice: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("adoptOnly recovery relaunches an AVD that really disappeared", async () => {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new RealisticStartManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: true, maxAttempts: 1 },
  });
  try {
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession({
      sessionId: "session",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
      expectedIdentity: original,
    });
    const captured = pool.getDevice(original.deviceId)!;
    const exitedProcess = exitedLauncherProcess();
    pool.testHooks.startedDeviceProcesses.set(original.deviceId, exitedProcess);

    manager.bootedDevices = [];
    const result = await pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );

    expect(result).toBe("recovered");
    expect(manager.listedAtRelaunch).toEqual([[]]);
    expect(manager.kills).toEqual([]);
    expect(sessions.getSession("session")?.assignedDevice).toBe(original.deviceId);
  } finally {
    sessions.stopCleanupTimer();
  }
});
