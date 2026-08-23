import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
} from "../../src/daemon/emulatorLossIncident";
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
        Promise.all([
          pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
            original.deviceId,
            captured,
          ),
          pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
            original.deviceId,
            captured,
          ),
        ]),
      ).resolves.toEqual([true, true]);

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

      expect(detached).toEqual({ devices: cohort, deferred: false });
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
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      await idleReservation;
      expect(idleReservationSettled).toBe(true);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("defers the entire reset cohort while named startup holds a matching lease", async () => {
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
      {
        platform: "android",
        name: "Pixel_8_API_35",
        deviceId: "emulator-5554",
      },
      {
        platform: "android",
        name: "Pixel_9_API_36",
        deviceId: "emulator-5556",
      },
    ];
    for (const device of devices) {
      await pool.addDevice(device, {
        name: device.name,
        platform: "android",
        isRunning: true,
        source: "local",
      });
    }
    const releaseStartupLease = await pool.reserveAndroidStartupLease(devices[0].name, true);

    try {
      const deferred = await pool.detachAdbServerResetCohort(
        devices.map(device => pool.getDevice(device.deviceId)!),
      );
      expect(deferred).toEqual({ devices: [], deferred: true });
      expect(pool.getDevice(devices[0].deviceId)).not.toBeNull();
      expect(pool.getDevice(devices[1].deviceId)).not.toBeNull();

      await releaseStartupLease();
      const detached = await pool.detachAdbServerResetCohort(
        devices.map(device => pool.getDevice(device.deviceId)!),
      );
      expect(detached).toMatchObject({ deferred: false });
      expect(detached.devices).toHaveLength(2);
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
    } finally {
      await releaseStartupLease();
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not partially detach a cohort when an idle tracked process cannot stop", async () => {
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
    const active: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    const idle: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5556",
    };
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });
    manager.bootedDevices = [active, idle];
    await pool.addDevice(active, image(active));
    await pool.addDevice(idle, image(idle));
    await pool.bindOrReuseDeviceSession("session-active", active.deviceId, "android", image(active));
    const childProcess = {
      pid: 123,
      kill: () => {
        throw new Error("process did not stop");
      },
      once: () => childProcess,
    } as ChildProcess;
    await pool.bindOrReuseDeviceSession(
      "session-idle",
      idle.deviceId,
      "android",
      image(idle),
      childProcess,
      idle,
    );
    await pool.releaseDevice(idle.deviceId, "session-idle");

    try {
      await expect(
        pool.detachAdbServerResetCohort([
          pool.getDevice(active.deviceId)!,
          pool.getDevice(idle.deviceId)!,
        ]),
      ).rejects.toThrow("process did not stop");

      expect(pool.getDevice(active.deviceId)).toMatchObject({
        sessionId: "session-active",
        status: "busy",
      });
      expect(pool.getDevice(idle.deviceId)).toMatchObject({
        sessionId: null,
        status: "idle",
      });
      expect(sessionManager.getSession("session-active")?.assignedDevice).toBe(active.deviceId);
      await expect(pool.waitForAdbServerResetRecovery(active.name)).resolves.toBeUndefined();
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("cancels cohort session executions before detaching reusable serials", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const cancellations: Array<{
      sessionId: string;
      reason: string;
      deviceStillPooled: boolean;
    }> = [];
    const cancellationStarted = Promise.withResolvers<void>();
    const releaseCancellation = Promise.withResolvers<void>();
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (sessionId, reason) => {
        cancellations.push({
          sessionId,
          reason,
          deviceStillPooled: pool.getDevice("emulator-5554") !== null,
        });
        cancellationStarted.resolve();
        await releaseCancellation.promise;
        return 1;
      },
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
    manager.bootedDevices = [device];
    await pool.addDevice(device, image);
    await pool.bindOrReuseDeviceSession("session-active", device.deviceId, "android", image);

    try {
      const captured = pool.getDevice(device.deviceId)!;
      const duplicateIncident = await pool.recordEmulatorLossIncident(
        device.deviceId,
        "device-discovery-miss",
      );
      const detaching = pool.detachAdbServerResetCohort([captured]);
      await cancellationStarted.promise;
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterLoss(
          device.deviceId,
          duplicateIncident,
          captured,
        ),
      ).resolves.toBe("deferred");
      await expect(
        pool.waitForEmulatorLossIncident(duplicateIncident!),
      ).resolves.toMatchObject({
        recovery: { outcome: "not-attempted" },
      });
      releaseCancellation.resolve();
      const detached = await detaching;

      expect(cancellations).toHaveLength(1);
      expect(cancellations[0]).toMatchObject({
        sessionId: "session-active",
        deviceStillPooled: true,
      });
      expect(cancellations[0]?.reason).toMatch(
        /^device-disconnected:emulator-5554;incident=emulator-loss-/,
      );
      expect(detached.devices).toHaveLength(1);
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("settles an incident when heartbeat release wins during reset preparation", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const backingStore = new InMemoryEmulatorLossIncidentStore(timer);
    const openStarted = Promise.withResolvers<void>();
    const releaseOpen = Promise.withResolvers<void>();
    const incidentStore: EmulatorLossIncidentStore = {
      async open(input) {
        openStarted.resolve();
        await releaseOpen.promise;
        return await backingStore.open(input);
      },
      async recordRecoveryAttempt(incidentId, attempt) {
        await backingStore.recordRecoveryAttempt(incidentId, attempt);
      },
      async completeRecovery(incidentId, outcome, settlement) {
        await backingStore.completeRecovery(incidentId, outcome, settlement);
      },
      async get(incidentId) {
        return await backingStore.get(incidentId);
      },
      async list(limit) {
        return await backingStore.list(limit);
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      incidentStore,
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
    manager.bootedDevices = [device];
    await pool.addDevice(device, image);
    await pool.bindOrReuseDeviceSession("session-active", device.deviceId, "android", image);

    try {
      const captured = pool.getDevice(device.deviceId)!;
      const detaching = pool.detachAdbServerResetCohort([captured]);
      await openStarted.promise;
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterLoss(device.deviceId, undefined, captured),
      ).resolves.toBe("deferred");
      await sessionManager.releaseSession("session-active", "heartbeat-timeout");
      releaseOpen.resolve();
      const detached = await detaching;
      const [incident] = await backingStore.list();

      expect(incident).toBeDefined();
      await expect(
        pool.waitForEmulatorLossIncident(incident!.id),
      ).resolves.toMatchObject({
        session: { state: "released" },
        recovery: { outcome: "not-attempted" },
      });
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
    } finally {
      releaseOpen.resolve();
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
          detached.devices[0],
        ),
      ).resolves.toBe(true);
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[1].deviceId,
          detached.devices[1],
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
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
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
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          original.deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(true);

      expect(manager.startedDevices).toHaveLength(0);
      expect(pool.getDevice(original.deviceId)).toMatchObject({
        avdName: original.name,
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(original.deviceId);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not overwrite a same-AVD replacement owned by another session", async () => {
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
    await pool.addDevice(original, image);
    await sessionManager.createSession("session-2", original.deviceId, "android");
    await pool.bindOrReuseDeviceSession("session-2", original.deviceId, "android");
    const replacement = pool.getDevice(original.deviceId);
    if (!replacement) {
      throw new Error("expected same-AVD replacement");
    }
    replacement.autolockSessionId = "session-2";

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          original.deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(false);

      expect(manager.startedDevices).toHaveLength(0);
      expect(pool.getDevice(original.deviceId)).toMatchObject({
        avdName: original.name,
        sessionId: "session-2",
        autolockSessionId: "session-2",
      });
      expect(sessionManager.getSession("session-2")?.assignedDevice).toBe(original.deviceId);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
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
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          original.deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(false);

      expect(manager.startedDevices).toHaveLength(0);
      expect(releasedSessionIds).toEqual(["session-1"]);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
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
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          original.deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(true);

      expect(killCount).toBe(1);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
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

      expect(detached.devices).toHaveLength(1);
      expect(killCount).toBe(1);
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
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
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[0].deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(true);
      pool.markIntentionalShutdown(originals[1].deviceId);
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[1].deviceId,
          detached.devices[1],
        ),
      ).resolves.toBe(false);

      expect(manager.startedDevices.map(device => device.name)).toEqual(["Pixel_8_API_35"]);
      expect(pool.getDevice("emulator-5556")).toMatchObject({
        avdName: "Pixel_8_API_35",
        sessionId: "session-0",
      });
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
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
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      sessionManager.stopCleanupTimer();
    }
  });

  test("releases the preserved session when reboot rejects after detaching the old serial", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const releasedSessionIds: string[] = [];
    const incidentStore = new InMemoryEmulatorLossIncidentStore(timer);
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
      async (sessionId, _deviceId, releaseReason) => {
        releasedSessionIds.push(sessionId);
        await sessionManager.releaseSession(sessionId, releaseReason);
      },
      undefined,
      reboot,
      undefined,
      undefined,
      incidentStore,
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
      const [incident] = await incidentStore.list();
      expect(incident).toMatchObject({
        session: { state: "released" },
        recovery: { outcome: "exhausted" },
      });
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("keeps a preserved session quarantined when terminal release persistence fails", async () => {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    const sessionManager = new SessionManager(timer, persistence);
    const manager = new FakeDeviceManager();
    const reboot: AndroidDeviceReboot = {
      run: async (_target, attempt) => {
        try {
          await attempt();
        } catch {
          // Detach the old serial before forcing terminal release.
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
      async (sessionId, _deviceId, releaseReason) => {
        await sessionManager.releaseSession(sessionId, releaseReason);
      },
      undefined,
      reboot,
      { onLoss: true, maxAttempts: 1 },
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
    const captured = pool.getDevice(original.deviceId)!;
    const incidentId = await pool.recordEmulatorLossIncident(
      original.deviceId,
      "device-discovery-miss",
    );
    manager.startDevice = async () => {
      throw new Error("emulator launch failed");
    };
    persistence.failure = "release";

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterLoss(
          original.deviceId,
          incidentId,
          captured,
        ),
      ).rejects.toThrow("persist release failed");
      expect(sessionManager.getSession("session-1")).toBeDefined();
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterLoss(
          original.deviceId,
          undefined,
          captured,
        ),
      ).resolves.toBe("deferred");
      await expect(pool.waitForEmulatorLossIncident(incidentId!)).resolves.toMatchObject({
        session: { state: "recovering" },
        recovery: { outcome: "exhausted" },
      });

      persistence.failure = null;
      await sessionManager.releaseSession("session-1", "heartbeat-timeout");
      for (let attempt = 0; attempt < 10 && pool.isSessionRecoveryInFlight("session-1"); attempt++) {
        await Promise.resolve();
      }
      expect(pool.isSessionRecoveryInFlight("session-1")).toBe(false);
      await expect(pool.waitForEmulatorLossIncident(incidentId!)).resolves.toMatchObject({
        session: { state: "released" },
      });
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});
