import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
  type EmulatorLossRecoverySettlement,
  type EmulatorRecoveryOutcome,
} from "../../src/daemon/emulatorLossIncident";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { AndroidDeviceReboot } from "../../src/devices/androidDeviceReboot";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

// Recovery must observe disappearance after shutdown, not merely a command ack.
class StoppedDeviceManager extends FakeDeviceManager {
  override async killDevice(device: BootedDevice): Promise<void> {
    this.bootedDevices = this.bootedDevices.filter((booted) => booted.deviceId !== device.deviceId);
  }
}

async function idleTrackedCohort(stopSignals: NodeJS.Signals[], onLoss = true) {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new StoppedDeviceManager();
  const incidents = new InMemoryEmulatorLossIncidentStore(timer);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon-session", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      retryExecutor: new DefaultRetryExecutor(timer),
      emulatorLossIncidentStore: incidents,
      recoveryPolicy: { onLoss, maxAttempts: 1 },
    }),
  );
  const children = stopSignals.map((stopSignal) => {
    const process = new FakeChildProcess(timer);
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    process.kill = (signal) => {
      signals.push(signal);
      if (signal === stopSignal) {
        process.signalCode = stopSignal;
        process.emit("exit", null, stopSignal);
        process.emit("close", null, stopSignal);
      }
      return true;
    };
    return { process, signals };
  });
  for (const [index, { process }] of children.entries()) {
    const booted: BootedDevice = {
      platform: "android",
      name: index === 0 ? "Pixel_A" : "Pixel_B",
      deviceId: `emulator-${5554 + index * 2}`,
    };
    const image: DeviceInfo = {
      name: booted.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    manager.bootedDevices.push(booted);
    await pool.addDevice(booted, image);
    const sessionId = `session-${index}`;
    await pool.bindOrReuseDeviceSession(
      sessionId,
      booted.deviceId,
      "android",
      image,
      process as unknown as ChildProcess,
      booted,
    );
    await pool.releaseDevice(booted.deviceId, sessionId);
  }
  const devices = children.map((_, index) => pool.getDevice(`emulator-${5554 + index * 2}`)!);
  manager.bootedDevices = [];
  return { timer, sessions, manager, incidents, pool, children, devices };
}

describe("ADB server reset session recovery", () => {
  test.each([false, true])(
    "intentional idle reset stop records no loss or relaunch (onLoss=%s)",
    async (onLoss) => {
      const h = await idleTrackedCohort(["SIGTERM"], onLoss);
      try {
        const detached = await h.pool.detachAdbServerResetCohort(h.devices);
        await drainMicrotasks(156);
        expect(await h.incidents.list()).toEqual([]);
        expect(h.manager.startedDevices).toEqual([]);
        expect(detached).toEqual({ devices: h.devices, deferred: false });
        expect(h.children[0].signals).toEqual(["SIGTERM"]);
        expect(h.pool.getDevice(h.devices[0].id)).toBeNull();
        await h.pool.releaseAdbServerResetCohortReservations(detached.devices);
      } finally {
        h.sessions.stopCleanupTimer();
      }
    },
  );

  test("intentional two-member reset stop preserves the cohort while escalating SIGKILL", async () => {
    const h = await idleTrackedCohort(["SIGTERM", "SIGKILL"]);
    try {
      const detaching = h.pool.detachAdbServerResetCohort(h.devices);
      await drainMicrotasks(156);
      const incidentsBeforeExit = await h.incidents.list();
      const startsBeforeExit = [...h.manager.startedDevices];
      const pooledBeforeExit = h.devices.map((device) => h.pool.getDevice(device.id));
      expect(h.children[1].signals).toEqual(["SIGTERM"]);
      h.timer.advanceTime(1_000);
      const detached = await detaching;
      await drainMicrotasks(156);
      expect(startsBeforeExit).toEqual([]);
      expect(incidentsBeforeExit).toEqual([]);
      expect(pooledBeforeExit).toEqual(h.devices);
      expect(h.manager.startedDevices).toEqual([]);
      expect(await h.incidents.list()).toEqual([]);
      expect(detached).toEqual({ devices: h.devices, deferred: false });
      expect(h.children.map(({ signals }) => signals)).toEqual([
        ["SIGTERM"],
        ["SIGTERM", "SIGKILL"],
      ]);
      expect(h.devices.map((device) => h.pool.getDevice(device.id))).toEqual([null, null]);
      await h.pool.releaseAdbServerResetCohortReservations(detached.devices);
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });

  test("unexpected tracked idle exit records one loss and relaunches once", async () => {
    const h = await idleTrackedCohort(["SIGTERM"]);
    try {
      const process = h.children[0].process;
      process.exitCode = 1;
      process.emit("exit", 1, null);
      process.emit("close", 1, null);
      await drainMicrotasks(156);
      const incidents = await h.incidents.list();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        deviceId: h.devices[0].id,
        detectionPath: "watched-process-exit",
        recovery: {
          outcome: "recovered",
          attempts: [{ attempt: 1, outcome: "succeeded" }],
        },
      });
      expect(h.manager.startedDevices.map((device) => device.name)).toEqual(["Pixel_A"]);
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });

  test("session reset recovery intentionally stops its tracked process without a second loss", async () => {
    const h = await idleTrackedCohort(["SIGTERM"]);
    try {
      const device = h.devices[0];
      const booted: BootedDevice = {
        deviceId: device.id,
        name: device.name,
        platform: "android",
      };
      h.manager.bootedDevices = [booted];
      await h.pool.bindOrReuseDeviceSession(
        "session-recovery",
        device.id,
        "android",
        device.androidImage,
      );
      h.manager.bootedDevices = [];
      await expect(
        h.pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(device.id, device),
      ).resolves.toBe(true);
      await drainMicrotasks(156);
      expect(h.children[0].signals).toEqual(["SIGTERM"]);
      expect(h.manager.startedDevices.map((image) => image.name)).toEqual(["Pixel_A"]);
      const incidents = await h.incidents.list();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        detectionPath: "adb-server-reset",
        recovery: { outcome: "recovered" },
      });
      expect(h.sessions.getSession("session-recovery")?.assignedDevice).toBe("Pixel_A");
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });

  test("recovery targets read reset reservations live after cohort release", async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon-session", {
        timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
    );
    const booted: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: booted.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    try {
      await pool.addDevice(booted, image);
      const cohort = await pool.detachAdbServerResetCohort([pool.getDevice(booted.deviceId)!]);
      expect(pool.getRecoveringAndroidTargets()).toEqual({
        names: new Set([booted.name]),
        serials: new Set([booted.deviceId]),
      });
      await pool.releaseAdbServerResetCohortReservations(cohort.devices);
      expect(pool.getRecoveringAndroidTargets()).toEqual({
        names: new Set(),
        serials: new Set(),
      });
    } finally {
      sessions.stopCleanupTimer();
    }
  });

  test("rebinds a live session only after restarting its recorded AVD", async () => {
    class ReplacementSerialDeviceManager extends FakeDeviceManager {
      readonly killedDeviceIds: string[] = [];

      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        this.bootedDevices = [
          {
            name: device.name,
            platform: "android",
            deviceId: "emulator-5560",
          },
        ];
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
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    expect(sessionManager.getDeviceReadiness("session-1")).toBeUndefined();
    const captured = pool.getDevice(original.deviceId);
    if (!captured) {
      throw new Error("expected captured device");
    }
    captured.autolockSessionId = "session-1";

    try {
      await expect(
        Promise.all([
          pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, captured),
          pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(original.deviceId, captured),
        ]),
      ).resolves.toEqual([true, true]);

      expect(manager.killedDeviceIds).toEqual([original.deviceId]);
      expect(manager.startedDevices.map((device) => device.name)).toEqual(["Pixel_8_API_35"]);
      expect(pool.getDevice(original.deviceId)).toBeNull();
      expect(pool.getDevice("emulator-5560")).toMatchObject({
        avdName: "Pixel_8_API_35",
        sessionId: "session-1",
        status: "busy",
        autolockSessionId: "session-1",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5560");
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("booted");
      sessionManager.setDeviceReadiness("session-1", "automationReady");
      sessionManager.setDeviceReadiness("session-1", "booted");
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("reserves a booted replacement until the preserved session is rebound", async () => {
    class ReplacementSerialDeviceManager extends FakeDeviceManager {
      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        this.bootedDevices = [
          {
            name: device.name,
            platform: "android",
            deviceId: "emulator-5560",
          },
        ];
        return { pid: 0 } as ChildProcess;
      }

      override async killDevice(): Promise<void> {
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

    class BlockingSessionTrackingRepository extends FakeInstalledAppsRepository {
      private blockNextWrite = false;
      readonly writeStarted = Promise.withResolvers<void>();
      readonly releaseWrite = Promise.withResolvers<void>();

      blockNextSessionTrackingWrite(): void {
        this.blockNextWrite = true;
      }

      override async setSessionTracking(
        daemonSessionId: string,
        deviceId: string,
        deviceSessionStart: number,
      ): Promise<void> {
        if (this.blockNextWrite) {
          this.blockNextWrite = false;
          this.writeStarted.resolve();
          await this.releaseWrite.promise;
        }
        await super.setSessionTracking(daemonSessionId, deviceId, deviceSessionStart);
      }
    }

    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new ReplacementSerialDeviceManager();
    const apps = new BlockingSessionTrackingRepository();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: apps,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    apps.blockNextSessionTrackingWrite();

    try {
      const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
        original.deviceId,
        captured,
      );
      await apps.writeStarted.promise;

      expect(pool.getDevice("emulator-5560")).toMatchObject({
        status: "idle",
        sessionId: null,
      });
      expect(pool.getIdleDevices().map((device) => device.id)).not.toContain("emulator-5560");
      expect(pool.getAvailableDeviceCount()).toBe(0);

      apps.releaseWrite.resolve();
      await expect(recovery).resolves.toBe(true);
      expect(pool.getDevice("emulator-5560")).toMatchObject({
        status: "busy",
        sessionId: "session-1",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5560");
    } finally {
      apps.releaseWrite.resolve();
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not rebind a recreated session that reuses the captured UUID", async () => {
    class BlockingReadyDeviceManager extends FakeDeviceManager {
      readonly readinessStarted = Promise.withResolvers<void>();
      readonly releaseReadiness = Promise.withResolvers<void>();

      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        this.bootedDevices = [
          {
            name: device.name,
            platform: "android",
            deviceId: "emulator-5560",
          },
        ];
        return { pid: 0 } as ChildProcess;
      }

      override async killDevice(): Promise<void> {
        this.bootedDevices = [];
      }

      override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
        this.readinessStarted.resolve();
        await this.releaseReadiness.promise;
        return {
          name: device.name,
          platform: "android",
          deviceId: "emulator-5560",
        };
      }
    }

    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new BlockingReadyDeviceManager();
    const reboot: AndroidDeviceReboot = {
      run: async (_target, attempt) => {
        await attempt();
      },
    };
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        androidDeviceReboot: reboot,
      }),
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
    const capturedSession = await sessionManager.createSession(
      "session-1",
      original.deviceId,
      "android",
    );
    await pool.bindOrReuseDeviceSession("session-1", original.deviceId, "android", image);
    const capturedDevice = pool.getDevice(original.deviceId)!;

    try {
      const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
        original.deviceId,
        capturedDevice,
      );
      await manager.readinessStarted.promise;

      await sessionManager.releaseSession("session-1", "allocation-rollback");
      const replacementSession = await sessionManager.createSession(
        "session-1",
        original.deviceId,
        "android",
      );
      expect(replacementSession).not.toBe(capturedSession);

      manager.releaseReadiness.resolve();
      await expect(recovery).resolves.toBe(false);
      expect(sessionManager.getSession("session-1")).toBe(replacementSession);
      expect(replacementSession.assignedDevice).toBe(original.deviceId);
      expect(pool.getDevice("emulator-5560")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    } finally {
      manager.releaseReadiness.resolve();
      await sessionManager.releaseSession("session-1", "allocation-rollback");
      sessionManager.stopCleanupTimer();
    }
  });

  test("retains captured session identity between cohort detachment and recovery", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    const capturedSession = sessionManager.getSession("session-1")!;
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(original.deviceId)!]);

    try {
      await sessionManager.releaseSession("session-1", "allocation-rollback");
      const replacementSession = await sessionManager.createSession(
        "session-1",
        original.deviceId,
        "android",
      );
      expect(replacementSession).not.toBe(capturedSession);

      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          original.deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(false);
      expect(manager.startedDevices).toHaveLength(0);
      expect(sessionManager.getSession("session-1")).toBe(replacementSession);
      expect(replacementSession.assignedDevice).toBe(original.deviceId);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      await sessionManager.releaseSession("session-1", "allocation-rollback");
      sessionManager.stopCleanupTimer();
    }
  });

  test("refuses to rebind when the original AVD identity was never recorded", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    const cohort = devices.map((device) => pool.getDevice(device.deviceId)!);

    try {
      const detached = await pool.detachAdbServerResetCohort(cohort);

      expect(detached).toEqual({ devices: cohort, deferred: false });
      expect(pool.getDevice(devices[0].deviceId)).toBeNull();
      expect(pool.getDevice(devices[1].deviceId)).toBeNull();
      expect(pool.getDevice(devices[2].deviceId)).toBeNull();
      expect(sessionManager.getSession("session-0")?.assignedDevice).toBe(devices[0].deviceId);
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(devices[1].deviceId);
      let idleReservationSettled = false;
      const idleReservation = pool.waitForAdbServerResetRecovery(devices[2].name).then(() => {
        idleReservationSettled = true;
      });
      await Promise.resolve();
      expect(idleReservationSettled).toBe(false);
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      await idleReservation;
      expect(idleReservationSettled).toBe(true);
      expect(pool.isSessionRecoveryInFlight("session-0")).toBe(true);
      expect(pool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => pool.assertSessionReadyForAutomation("session-0")).toThrow(
        /device-disconnected:emulator-5554/,
      );
    } finally {
      await sessionManager.releaseSession("session-0", "explicit-release");
      await sessionManager.releaseSession("session-1", "explicit-release");
      sessionManager.stopCleanupTimer();
    }
  });

  test("defers the entire reset cohort while named startup holds a matching lease", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
        devices.map((device) => pool.getDevice(device.deviceId)!),
      );
      expect(deferred).toEqual({ devices: [], deferred: true });
      expect(pool.getDevice(devices[0].deviceId)).not.toBeNull();
      expect(pool.getDevice(devices[1].deviceId)).not.toBeNull();

      await releaseStartupLease();
      const detached = await pool.detachAdbServerResetCohort(
        devices.map((device) => pool.getDevice(device.deviceId)!),
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
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    await pool.bindOrReuseDeviceSession(
      "session-active",
      active.deviceId,
      "android",
      image(active),
    );
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
    const manager = new StoppedDeviceManager();
    const cancellations: Array<{
      sessionId: string;
      reason: string;
      deviceStillPooled: boolean;
    }> = [];
    const cancellationStarted = Promise.withResolvers<void>();
    const releaseCancellation = Promise.withResolvers<void>();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        cancelDeviceSessionExecutions: async (sessionId, reason) => {
          cancellations.push({
            sessionId,
            reason,
            deviceStillPooled: pool.getDevice("emulator-5554") !== null,
          });
          cancellationStarted.resolve();
          await releaseCancellation.promise;
          return 1;
        },
      }),
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
      await expect(pool.waitForEmulatorLossIncident(duplicateIncident!)).resolves.toMatchObject({
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

  test("keeps recovery fenced until it observes the captured session release", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
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
    let replacementSession: NonNullable<ReturnType<SessionManager["getSession"]>> | undefined;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
        cancelDeviceSessionExecutions: async (sessionId) => {
          await sessionManager.releaseSession(sessionId, "allocation-rollback");
          await pool.releaseDevice(device.deviceId, sessionId);
          await pool.bindOrReuseDeviceSession(sessionId, device.deviceId, "android", image);
          replacementSession = sessionManager.getSession(sessionId) ?? undefined;
          return 1;
        },
      }),
    );
    manager.bootedDevices = [device];
    await pool.addDevice(device, image);
    await pool.bindOrReuseDeviceSession("session-active", device.deviceId, "android", image);
    const captured = pool.getDevice(device.deviceId)!;

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterLoss(device.deviceId, undefined, captured),
      ).resolves.toBe("released");

      expect(replacementSession).toBeDefined();
      expect(sessionManager.getSession("session-active")).toBe(replacementSession);
      expect(manager.startedDevices).toEqual([]);
      expect(pool.isSessionRecoveryInFlight("session-active")).toBe(false);
      expect(pool.getDevice(device.deviceId)).toMatchObject({
        sessionId: "session-active",
        status: "busy",
      });
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("settles an incident when heartbeat release wins during reset preparation", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
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
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        emulatorLossIncidentStore: incidentStore,
      }),
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
      await expect(pool.waitForEmulatorLossIncident(incident!.id)).resolves.toMatchObject({
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
    class SwappedSerialDeviceManager extends StoppedDeviceManager {
      override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
        this.startedDevices.push(device);
        const deviceId = device.name === "Pixel_8_API_35" ? "emulator-5556" : "emulator-5558";
        this.bootedDevices = [
          {
            name: device.name,
            platform: "android",
            deviceId,
          },
        ];
        return { pid: 0 } as ChildProcess;
      }

      override async killDevice(device: BootedDevice): Promise<void> {
        this.bootedDevices = this.bootedDevices.filter(
          (candidate) => candidate.deviceId !== device.deviceId,
        );
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
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
      originals.map((device) => pool.getDevice(device.deviceId)!),
    );

    try {
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[0].deviceId,
          detached.devices[0],
        ),
      ).resolves.toBe(true);
      expect(pool.isSessionRecoveryInFlight("session-0")).toBe(false);
      expect(pool.isSessionRecoveryInFlight("session-1")).toBe(true);
      await expect(
        pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          originals[1].deviceId,
          detached.devices[1],
        ),
      ).resolves.toBe(true);

      expect(manager.startedDevices.map((device) => device.name)).toEqual([
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
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("booted");
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      expect(pool.isSessionRecoveryInFlight("session-1")).toBe(false);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not overwrite a same-AVD replacement owned by another session", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    const manager = new StoppedDeviceManager();
    const releasedSessionIds: string[] = [];
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        releaseSessionForDisconnectedDevice: async (sessionId) => {
          releasedSessionIds.push(sessionId);
        },
      }),
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
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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

  test("keeps active sessions quarantined when idle cohort process stop fails", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
    const incidents = new InMemoryEmulatorLossIncidentStore(timer);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        emulatorLossIncidentStore: incidents,
      }),
    );
    const active: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    const idle: BootedDevice = {
      platform: "android",
      name: "Pixel_7_API_34",
      deviceId: "emulator-5556",
    };
    const activeImage: DeviceInfo = {
      name: active.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    const idleImage: DeviceInfo = {
      name: idle.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    const activeProcess = {
      pid: 123,
      kill: () => true,
      once: () => activeProcess,
    } as ChildProcess;
    const failingIdleProcess = {
      pid: 456,
      kill: () => {
        throw new Error("idle emulator stop failed");
      },
      once: () => failingIdleProcess,
    } as ChildProcess;
    manager.bootedDevices = [active, idle];
    await pool.addDevice(active, activeImage);
    await pool.addDevice(idle, idleImage);
    await pool.bindOrReuseDeviceSession(
      "session-1",
      active.deviceId,
      "android",
      activeImage,
      activeProcess,
      active,
    );
    await pool.bindOrReuseDeviceSession(
      "idle-seed",
      idle.deviceId,
      "android",
      idleImage,
      failingIdleProcess,
      idle,
    );
    await sessionManager.releaseSession("idle-seed");
    await pool.releaseDevice(idle.deviceId, "idle-seed");

    try {
      await expect(
        pool.detachAdbServerResetCohort([
          pool.getDevice(active.deviceId)!,
          pool.getDevice(idle.deviceId)!,
        ]),
      ).rejects.toThrow("idle emulator stop failed");

      expect(pool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => pool.assertSessionReadyForAutomation("session-1")).toThrow(
        /device-disconnected:emulator-5554/,
      );
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(active.deviceId);
      await expect(incidents.list()).resolves.toMatchObject([
        {
          deviceId: active.deviceId,
          recovery: { outcome: "exhausted" },
          session: { sessionUuid: "session-1", state: "recovering" },
        },
      ]);
    } finally {
      await sessionManager.releaseSession("session-1", "explicit-release");
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not recreate an absent preserved session for a recovery replacement", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    class SwappedSerialDeviceManager extends StoppedDeviceManager {
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
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
      originals.map((device) => pool.getDevice(device.deviceId)!),
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

      expect(manager.startedDevices.map((device) => device.name)).toEqual(["Pixel_8_API_35"]);
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
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    const manager = new StoppedDeviceManager();
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
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        releaseSessionForDisconnectedDevice: async (sessionId, _deviceId, releaseReason) => {
          releasedSessionIds.push(sessionId);
          await sessionManager.releaseSession(sessionId, releaseReason);
        },
        androidDeviceReboot: reboot,
        emulatorLossIncidentStore: incidentStore,
      }),
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

  test("retries transient release persistence before unquarantining, and keeps a device-restart release resumable", async () => {
    class TransientCompletionFailureStore extends InMemoryEmulatorLossIncidentStore {
      completeAttempts = 0;

      override async completeRecovery(
        incidentId: string,
        outcome: EmulatorRecoveryOutcome,
        settlement?: EmulatorLossRecoverySettlement,
      ): Promise<void> {
        this.completeAttempts += 1;
        if (this.completeAttempts === 1) {
          throw new Error("transient incident completion failure");
        }
        await super.completeRecovery(incidentId, outcome, settlement);
      }
    }

    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const persistence = new FakeDeviceSessionPersistence();
    const sessionManager = new SessionManager(timer, persistence);
    const manager = new StoppedDeviceManager();
    const incidentStore = new TransientCompletionFailureStore(timer);
    let releaseAttempts = 0;
    const releaseReasons: string[] = [];
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
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        releaseSessionForDisconnectedDevice: async (sessionId, _deviceId, releaseReason) => {
          releaseAttempts += 1;
          releaseReasons.push(releaseReason);
          try {
            await sessionManager.releaseSession(sessionId, releaseReason);
          } finally {
            if (releaseAttempts === 1) {
              persistence.failure = null;
            }
          }
        },
        androidDeviceReboot: reboot,
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
        emulatorLossIncidentStore: incidentStore,
      }),
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
        pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, incidentId, captured),
      ).resolves.toBe("released");
      expect(releaseAttempts).toBe(2);
      expect(incidentStore.completeAttempts).toBe(2);
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(pool.isSessionRecoveryInFlight("session-1")).toBe(false);
      // A failed relaunch still persists a resumable device-restart release.
      // The incident awaits the device even though recovery was exhausted.
      expect(releaseReasons).toEqual([
        `device-restart:${original.name}`,
        `device-restart:${original.name}`,
      ]);
      expect(await persistence.getSession?.("session-1")).toMatchObject({
        status: "released",
        release_reason: `device-restart:${original.name}`,
        released_at_ms: expect.any(Number),
      });
      await expect(pool.waitForEmulatorLossIncident(incidentId!)).resolves.toMatchObject({
        session: { state: "awaiting-device" },
        recovery: { outcome: "exhausted" },
      });
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("retries a device-disconnected release before retiring a failed System UI recovery", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const persistence = new FakeDeviceSessionPersistence();
    const originalMarkReleased = persistence.markReleased.bind(persistence);
    let releaseAttempts = 0;
    persistence.markReleased = async (...args) => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) {
        throw new Error("transient release failure");
      }
      await originalMarkReleased(...args);
    };
    const sessionManager = new SessionManager(timer, persistence);
    const manager = new StoppedDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
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
    try {
      await pool.addDevice(original, image);
      await pool.bindOrReuseDeviceSession("session-1", original.deviceId, "android", image);
      const captured = pool.getDevice(original.deviceId)!;

      await expect(pool.retireDeviceAfterSystemUiAnrRecoveryFailure(captured)).resolves.toBe(true);
      expect(releaseAttempts).toBe(2);
      expect(await persistence.getSession?.("session-1")).toMatchObject({
        status: "released",
        release_reason: `device-disconnected:${original.deviceId}`,
        released_at_ms: expect.any(Number),
      });
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});
