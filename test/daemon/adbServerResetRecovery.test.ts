import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { AndroidDeviceReboot } from "../../src/utils/androidDeviceReboot";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

describe("ADB server reset session recovery", () => {
  test("rebinds a live session only after restarting its recorded AVD", async () => {
    class ReplacementSerialDeviceManager extends FakeDeviceManager {
      readonly killedDeviceIds: string[] = [];

      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        this.bootedDevices = [{
          name: device.name,
          platform: "android",
          deviceId: "emulator-5560",
        }];
        return { pid: 0 } as ChildProcess;
      }

      override async killDevice(device: BootedDevice): Promise<void> {
        this.killedDeviceIds.push(device.deviceId);
        this.bootedDevices = [];
      }

      override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
        return {
          name: device.name,
          platform: "android",
          deviceId: "emulator-5560",
        };
      }
    }

    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new ReplacementSerialDeviceManager();
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const original: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: "Pixel_8_API_35",
      platform: "android",
      isRunning: true,
      source: "local",
    };
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession(
      "session-1",
      original.deviceId,
      "android",
      image,
      undefined,
      original,
    );

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          original.deviceId,
          pool.getDevice(original.deviceId) ?? undefined,
        ),
      ).resolves.toBe(true);

      expect(manager.killedDeviceIds).toEqual([original.deviceId]);
      expect(manager.startedDevices.map(device => device.name)).toEqual(["Pixel_8_API_35"]);
      expect(pool.getDevice(original.deviceId)).toBeNull();
      expect(pool.getDevice("emulator-5560")).toMatchObject({
        avdName: "Pixel_8_API_35",
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5560");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("refuses to rebind when the original AVD identity was never recorded", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const device: BootedDevice = {
      platform: "android",
      name: "Pixel 8",
      deviceId: "emulator-5554",
    };
    manager.bootedDevices = [device];
    await pool.initializeWithDevices([device]);
    await pool.bindOrReuseDeviceSession("session-1", device.deviceId, "android");

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(device.deviceId),
      ).resolves.toBe(false);
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(device.deviceId);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("detaches every reset-cohort serial while retaining its session mapping", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const devices: BootedDevice[] = [
      { platform: "android", name: "Pixel_8_API_35", deviceId: "emulator-5554" },
      { platform: "android", name: "Pixel_9_API_36", deviceId: "emulator-5556" },
    ];
    manager.bootedDevices = devices;
    for (const [index, device] of devices.entries()) {
      const image: DeviceInfo = {
        name: device.name,
        platform: "android",
        isRunning: true,
        source: "local",
      };
      await pool.addDevice(device, image);
      await pool.bindOrReuseDeviceSession(`session-${index}`, device.deviceId, "android", image);
    }
    const cohort = devices.map(device => pool.getDevice(device.deviceId)!);

    try {
      const detached = await pool.detachAdbServerResetCohort(cohort);

      expect(detached).toEqual(cohort);
      expect(pool.getDevice(devices[0].deviceId)).toBeNull();
      expect(pool.getDevice(devices[1].deviceId)).toBeNull();
      expect(sessionManager.getSession("session-0")?.assignedDevice).toBe(devices[0].deviceId);
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(devices[1].deviceId);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("releases the preserved session when reboot rejects after detaching the old serial", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const releasedSessionIds: string[] = [];
    const reboot: AndroidDeviceReboot = {
      run: async (_target, attempt) => {
        try {
          await attempt();
        } catch {
          // Detach the old serial before the reboot implementation itself rejects.
        }
        throw new Error("reboot runner unavailable");
      },
    };
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      undefined,
      undefined,
      async (sessionId) => {
        releasedSessionIds.push(sessionId);
      },
      undefined,
      reboot,
    );
    const original: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: original.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession("session-1", original.deviceId, "android", image);
    manager.startDevice = async () => {
      throw new Error("emulator launch failed");
    };

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId),
      ).resolves.toBe(false);
      expect(pool.getDevice(original.deviceId)).toBeNull();
      expect(releasedSessionIds).toEqual(["session-1"]);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});
