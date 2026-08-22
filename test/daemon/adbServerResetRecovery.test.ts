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
    const captured = pool.getDevice(original.deviceId);
    if (!captured) {
      throw new Error("expected captured device");
    }
    captured.autolockSessionId = "session-1";

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
        autolockSessionId: "session-1",
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

  test("detaches every reset-cohort serial while retaining bound session mappings", async () => {
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
      { platform: "android", name: "Pixel_9_Pro_API_36", deviceId: "emulator-5558" },
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
      if (index < 2) {
        await pool.bindOrReuseDeviceSession(`session-${index}`, device.deviceId, "android", image);
      }
    }
    const cohort = devices.map(device => pool.getDevice(device.deviceId)!);

    try {
      const detached = await pool.detachAdbServerResetCohort(cohort);

      expect(detached).toEqual(cohort);
      expect(pool.getDevice(devices[0].deviceId)).toBeNull();
      expect(pool.getDevice(devices[1].deviceId)).toBeNull();
      expect(pool.getDevice(devices[2].deviceId)).toBeNull();
      expect(sessionManager.getSession("session-0")?.assignedDevice).toBe(devices[0].deviceId);
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(devices[1].deviceId);
      let idleReservationSettled = false;
      const idleReservation = pool
        .waitForAdbServerResetRecovery(devices[2].name)
        .then(() => {
          idleReservationSettled = true;
        });
      await Promise.resolve();
      expect(idleReservationSettled).toBe(false);
      await pool.releaseAdbServerResetCohortReservations(detached);
      await idleReservation;
      expect(idleReservationSettled).toBe(true);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not detach an AVD while named startup holds its reset lease", async () => {
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
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    await pool.addDevice(device, image);
    const releaseStartupLease = await pool.reserveAndroidStartupLease(device.name, true);

    try {
      expect(
        await pool.detachAdbServerResetCohort([pool.getDevice(device.deviceId)!]),
      ).toEqual([]);

      await releaseStartupLease();
      const detached = await pool.detachAdbServerResetCohort([pool.getDevice(device.deviceId)!]);
      expect(detached).toHaveLength(1);
      await pool.releaseAdbServerResetCohortReservations(detached);
    } finally {
      await releaseStartupLease();
      sessionManager.stopCleanupTimer();
    }
  });

  test("recovers both captured AVDs when the first reuses the second serial", async () => {
    class SwappedSerialDeviceManager extends FakeDeviceManager {
      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        const deviceId = device.name === "Pixel_8_API_35" ? "emulator-5556" : "emulator-5558";
        this.bootedDevices = [{
          name: device.name,
          platform: "android",
          deviceId,
        }];
        return { pid: 0 } as ChildProcess;
      }

      override async killDevice(device: BootedDevice): Promise<void> {
        this.bootedDevices = this.bootedDevices.filter(candidate => candidate.deviceId !== device.deviceId);
      }

      override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
        return {
          name: device.name,
          platform: "android",
          deviceId: device.name === "Pixel_8_API_35" ? "emulator-5556" : "emulator-5558",
        };
      }
    }

    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new SwappedSerialDeviceManager();
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const originals: BootedDevice[] = [
      { platform: "android", name: "Pixel_8_API_35", deviceId: "emulator-5554" },
      { platform: "android", name: "Pixel_9_API_36", deviceId: "emulator-5556" },
    ];
    manager.bootedDevices = originals;
    for (const [index, device] of originals.entries()) {
      const image: DeviceInfo = {
        name: device.name,
        platform: "android",
        isRunning: true,
        source: "local",
      };
      await pool.addDevice(device, image);
      await pool.bindOrReuseDeviceSession(`session-${index}`, device.deviceId, "android", image);
    }
    const detached = await pool.detachAdbServerResetCohort(
      originals.map(device => pool.getDevice(device.deviceId)!),
    );

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[0].deviceId,
          detached[0],
        ),
      ).resolves.toBe(true);
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[1].deviceId,
          detached[1],
        ),
      ).resolves.toBe(true);

      expect(manager.startedDevices.map(device => device.name)).toEqual([
        "Pixel_8_API_35",
        "Pixel_9_API_36",
      ]);
      expect(pool.getDevice("emulator-5556")).toMatchObject({
        avdName: "Pixel_8_API_35",
        sessionId: "session-0",
      });
      expect(pool.getDevice("emulator-5558")).toMatchObject({
        avdName: "Pixel_9_API_36",
        sessionId: "session-1",
      });
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
      sessionManager.stopCleanupTimer();
    }
  });

  test("rebinds the preserved session before accepting a same-AVD replacement", async () => {
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
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(original.deviceId)!]);

    try {
      await pool.addDevice(original, image);

      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, detached[0]),
      ).resolves.toBe(true);

      expect(manager.startedDevices).toHaveLength(0);
      expect(pool.getDevice(original.deviceId)).toMatchObject({
        avdName: original.name,
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(original.deviceId);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
      sessionManager.stopCleanupTimer();
    }
  });

  test("cancels a detached reset member and releases its preserved session", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const releasedSessionIds: string[] = [];
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
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(original.deviceId)!]);

    try {
      pool.markIntentionalShutdown(original.deviceId);

      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, detached[0]),
      ).resolves.toBe(false);

      expect(manager.startedDevices).toHaveLength(0);
      expect(releasedSessionIds).toEqual(["session-1"]);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
      sessionManager.stopCleanupTimer();
    }
  });

  test("stops the process retained from a detached reset cohort member", async () => {
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
    let killCount = 0;
    const childProcess = {
      pid: 123,
      kill: () => {
        killCount++;
        return true;
      },
      once: () => childProcess,
    } as ChildProcess;
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession(
      "session-1",
      original.deviceId,
      "android",
      image,
      childProcess,
      original,
    );
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(original.deviceId)!]);

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, detached[0]),
      ).resolves.toBe(true);

      expect(killCount).toBe(1);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
      sessionManager.stopCleanupTimer();
    }
  });

  test("terminates a tracked idle reset-cohort emulator before detaching it", async () => {
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
    let killCount = 0;
    const childProcess = {
      pid: 123,
      kill: () => {
        killCount++;
        return true;
      },
      once: () => childProcess,
    } as ChildProcess;
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession(
      "session-1",
      original.deviceId,
      "android",
      image,
      childProcess,
      original,
    );
    await pool.releaseDevice(original.deviceId, "session-1");

    try {
      const detached = await pool.detachAdbServerResetCohort([pool.getDevice(original.deviceId)!]);

      expect(detached).toHaveLength(1);
      expect(killCount).toBe(1);
      await pool.releaseAdbServerResetCohortReservations(detached);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not recreate an absent preserved session for a recovery replacement", async () => {
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
    const replacement: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5560",
    };
    const image: DeviceInfo = {
      name: replacement.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    manager.bootedDevices = [replacement];
    await pool.addDevice(replacement, image);

    try {
      await expect(
        pool.bindOrReuseDeviceSession(
          "session-1",
          replacement.deviceId,
          "android",
          image,
          undefined,
          replacement,
          true,
          undefined,
          undefined,
          "emulator-5554",
        ),
      ).rejects.toThrow(/changed while device .* was recovering/);
      expect(sessionManager.getSession("session-1")).toBeNull();
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("cancels the reserved AVD when an earlier recovery reuses its serial", async () => {
    class SwappedSerialDeviceManager extends FakeDeviceManager {
      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        const deviceId = device.name === "Pixel_8_API_35" ? "emulator-5556" : "emulator-5558";
        this.bootedDevices = [{ name: device.name, platform: "android", deviceId }];
        return { pid: 0 } as ChildProcess;
      }

      override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
        return {
          name: device.name,
          platform: "android",
          deviceId: device.name === "Pixel_8_API_35" ? "emulator-5556" : "emulator-5558",
        };
      }
    }

    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new SwappedSerialDeviceManager();
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const originals: BootedDevice[] = [
      { platform: "android", name: "Pixel_8_API_35", deviceId: "emulator-5554" },
      { platform: "android", name: "Pixel_9_API_36", deviceId: "emulator-5556" },
    ];
    manager.bootedDevices = originals;
    for (const [index, device] of originals.entries()) {
      const image: DeviceInfo = {
        name: device.name,
        platform: "android",
        isRunning: true,
        source: "local",
      };
      await pool.addDevice(device, image);
      await pool.bindOrReuseDeviceSession(`session-${index}`, device.deviceId, "android", image);
    }
    const detached = await pool.detachAdbServerResetCohort(
      originals.map(device => pool.getDevice(device.deviceId)!),
    );

    try {
      pool.markIntentionalShutdown(originals[1].deviceId);

      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[0].deviceId,
          detached[0],
        ),
      ).resolves.toBe(true);
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[1].deviceId,
          detached[1],
        ),
      ).resolves.toBe(false);

      expect(manager.startedDevices.map(device => device.name)).toEqual(["Pixel_8_API_35"]);
      expect(pool.getDevice("emulator-5556")).toMatchObject({
        avdName: "Pixel_8_API_35",
        sessionId: "session-0",
      });
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
      sessionManager.stopCleanupTimer();
    }
  });

  test("cancels reset reservation waits when the caller aborts", async () => {
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
    await pool.addDevice(original, image);
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(original.deviceId)!]);
    const controller = new AbortController();

    try {
      const waiting = pool.waitForAdbServerResetRecovery(original.name, controller.signal);
      controller.abort(new Error("request cancelled"));
      await expect(waiting).rejects.toThrow("request cancelled");
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
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
