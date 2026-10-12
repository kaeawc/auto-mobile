import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SystemUiAnrRecoveryRequiredError } from "../../src/ctrlProxy/RunnerReadinessService";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { RealBootGatesOverFakeFleet } from "../helpers/realBootGatesOverFakeFleet";
import { cancelUnownedColdBoot, rollBackUndeliveredBoot } from "../../src/server/deviceTools";
import type { DeviceBootResult } from "../../src/devices/deviceBootService";
import { logger } from "../../src/utils/logger";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import {
  deviceAssignedToOtherSessionError,
  devicePreparedForOtherRequestError,
} from "../../src/daemon/inputDeviceOwnership";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";

isolateToolRegistry();

const device: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};

const image: DeviceInfo = {
  name: device.name,
  platform: "android",
  deviceId: device.deviceId,
  isRunning: false,
  osVersion: "15",
  formFactor: "phone",
};

describe("startDevice System UI ANR recovery for an already-running AVD", () => {
  let timer: FakeTimer;
  let devices: FakeDeviceUtils;
  let matcher: FakeDeviceMatcher;
  let sessions: SessionManager;
  let pool: DevicePool;
  let gates: RealBootGatesOverFakeFleet;
  let lifecycleReleases: number;
  let shutdownReleases: number;
  let readinessReleases: number;
  let routeReleases: number;
  let releaseOrder: string[];
  let restoreEnv: (() => void) | undefined;
  let beforePlatformLaunch: (() => Promise<void>) | undefined;
  let bootHandoffs: number;

  const arrange = async (): Promise<void> => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    timer = new FakeTimer();
    lifecycleReleases = shutdownReleases = readinessReleases = routeReleases = 0;
    releaseOrder = [];
    beforePlatformLaunch = undefined;
    bootHandoffs = 0;
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const reserveLifecycle = lifecycleCoordinator.reserve.bind(lifecycleCoordinator);
    lifecycleCoordinator.reserve = async (...args) => {
      const lease = await reserveLifecycle(...args);
      const release = lease.release.bind(lease);
      lease.release = () => {
        lifecycleReleases++;
        releaseOrder.push("lifecycle");
        release();
      };
      return lease;
    };
    devices = new FakeDeviceUtils();
    matcher = new FakeDeviceMatcher();
    const idGenerator = new CountingIdGenerator("anr-running");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    devices.setBootedDevices("android", [device]);
    devices.setDeviceImages("android", [image]);
    matcher.setBootedResult(device);
    matcher.setImageResult(image);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "anr-running-daemon", {
        env,
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([device]);
    await pool.bindOrReuseDeviceSession("owner-session", device.deviceId, "android", image);
    const reserveReadiness = pool.reserveDeviceForReadiness.bind(pool);
    pool.reserveDeviceForReadiness = async (...args) => {
      const release = await reserveReadiness(...args);
      return Object.assign(
        async () => {
          readinessReleases++;
          releaseOrder.push("readiness");
          await release();
        },
        { owner: release.owner },
      );
    };
    const reserveShutdown = pool.reserveDeviceForShutdown.bind(pool);
    pool.reserveDeviceForShutdown = async (...args) => {
      const reservation = await reserveShutdown(...args);
      if (!reservation) {
        return reservation;
      }
      return {
        ...reservation,
        release: async () => {
          shutdownReleases++;
          releaseOrder.push("shutdown");
          await reservation.release();
        },
        releaseRecoveryRouteLease: () => {
          routeReleases++;
          releaseOrder.push("route");
          reservation.releaseRecoveryRouteLease();
        },
      };
    };
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    setDeviceToolsDependencies({
      env,
      timer,
      lifecycleCoordinator,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => matcher,
      avdManagerFactory: () => ({
        listDeviceImages: async () => [
          {
            name: device.name,
            path: `/tmp/${device.name}.avd`,
            target: "Google APIs",
            basedOn: "Android 15 google_apis/x86_64",
          },
        ],
      }),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    // Pause the platform launch inside the admission wrapper, so its slot is genuinely held.
    const platformStart = devices.startDevice.bind(devices);
    devices.startDevice = async (...args) => {
      await beforePlatformLaunch?.();
      return await platformStart(...args);
    };
    gates = new RealBootGatesOverFakeFleet(devices, timer, 1);
    const admit = gates.android.admit.bind(gates.android);
    gates.android.admit = async (request) => {
      const admission = await admit(request);
      return {
        ...admission,
        handOff: (deviceId) => {
          bootHandoffs++;
          admission.handOff(deviceId);
        },
      };
    };
    registerDeviceTools();
  };

  const dispose = (): void => {
    restoreEnv?.();
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer.reset();
  };
  beforeEach(arrange);
  afterEach(dispose);

  // Pay the one-off startDevice and System UI recovery cost on a throwaway pool.
  // Every test still arranges, runs and drains its own scenario in full.
  beforeAll(async () => {
    await arrange();
    try {
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        ensureCtrlProxyReady: async () => {
          if (++readinessCalls === 1) {
            throw new SystemUiAnrRecoveryRequiredError("System UI ANR persisted after Wait");
          }
        },
      });
      const originalKill = devices.killDevice.bind(devices);
      devices.killDevice = async (target, options) => {
        await originalKill(target, options);
        devices.setBootedDevices("android", []);
      };
      await ToolRegistry.getTool("startDevice")!.handler({
        platform: "android",
        name: device.name,
      });
      for (let turn = 0; turn < 400; turn++) {
        await Promise.resolve();
      }
    } finally {
      dispose();
    }
  });

  test("cancellation after replacement launch dispatch rejects promptly and leaves its tail unowned", async () => {
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          throw new SystemUiAnrRecoveryRequiredError("System UI ANR persisted after Wait");
        }
      },
    });

    const originalKill = devices.killDevice.bind(devices);
    devices.killDevice = async (target, options) => {
      await originalKill(target, options);
      devices.setBootedDevices("android", []);
    };

    let launchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      launchStarted = resolve;
    });
    let finishLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    beforePlatformLaunch = async () => {
      launchStarted();
      await launchGate;
    };

    const controller = new AbortController();
    let startSettled = false;
    const start = ToolRegistry.getTool("startDevice")!
      .handler({ platform: "android", name: device.name }, undefined, controller.signal)
      .finally(() => {
        startSettled = true;
      });
    for (let turn = 0; turn < 400 && !startSettled; turn++) {
      await Promise.resolve();
    }
    expect(startSettled).toBe(false);
    expect(devices.getExecutedOperations()).toContain("killDevice:Pixel_8_API_35");
    await started;
    controller.abort(new Error("caller disconnected"));
    await expect(start).rejects.toThrow("caller disconnected");
    const select = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    const beforeSelection = { ...pool.getDevice(device.deviceId)! };
    const refused = await select({
      deviceId: device.deviceId,
      sessionUuid: "other-session",
      __mcpSessionId: "other-mcp",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect([
      deviceAssignedToOtherSessionError(device.deviceId, "owner-session", "other-session").message,
      devicePreparedForOtherRequestError(device.deviceId).message,
    ]).toContain((refused as Error).message);
    expect(pool.getDevice(device.deviceId)).toEqual(beforeSelection);
    expect(sessions.getSession("other-session")).toBeNull();
    expect(pool.getDevice(device.deviceId)).toMatchObject({
      sessionId: "owner-session",
      status: "busy",
    });
    expect(sessions.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);
    expect(lifecycleReleases).toBe(0);
    expect(shutdownReleases).toBe(0);
    expect(routeReleases).toBe(0);
    expect(await pool.isShutdownReservationHeld(device.deviceId)).toBe(true);
    expect(await gates.capacity("android")).toEqual({ booted: 0, inFlight: 1 });
    expect(gates.admissions).toHaveLength(1);
    expect(gates.admissions[0]?.releaseCalls).toBe(0);
    expect(bootHandoffs).toBe(0);

    finishLaunch();
    for (let turn = 0; turn < 400; turn++) {
      await Promise.resolve();
    }

    expect(readinessCalls).toBe(1);
    const operations = devices.getExecutedOperations();
    expect(operations.filter((operation) => operation.startsWith("startDevice:"))).toHaveLength(1);
    expect(
      (await devices.getBootedDevices("android")).map((running) => running.deviceId),
    ).toContain(device.deviceId);
    expect(operations.filter((operation) => operation.startsWith("killDevice:"))).toEqual([
      "killDevice:Pixel_8_API_35",
    ]);
    expect(operations.filter((operation) => operation.startsWith("startDevice:"))).toHaveLength(1);
    expect(pool.getDevice(device.deviceId)?.sessionId).toBeNull();
    expect(pool.getIdleDevices().map((idle) => idle.id)).toContain(device.deviceId);
    expect(await gates.capacity("android")).toEqual({ booted: 1, inFlight: 0 });
    expect(gates.admissions).toHaveLength(1);
    expect(gates.admissions[0]?.releaseCalls).toBe(0);
    expect(bootHandoffs).toBe(1);
    expect(await gates.capacity("android")).toEqual({ booted: 1, inFlight: 0 });
    expect(sessions.getSession("owner-session")).toBeNull();
    expect(lifecycleReleases).toBe(1);
    expect(shutdownReleases).toBe(1);
    expect(readinessReleases).toBe(2);
    expect(routeReleases).toBe(1);
    expect(releaseOrder).toEqual(["readiness", "shutdown", "readiness", "route", "lifecycle"]);
    expect(await pool.isShutdownReservationHeld(device.deviceId)).toBe(false);
    expect(await pool.isShutdownReserved(device.deviceId)).toBe(false);
    expect(pool.isReservedForReadiness(device.deviceId)).toBe(false);

    await pool.bindOrReuseDeviceSession("other-session", device.deviceId, "android", image);
    expect(pool.getDevice(device.deviceId)?.sessionId).toBe("other-session");
  });

  test("cancellation after relaunch keeps one running device and returns every recovery reservation once", async () => {
    const replacement = new ExitOnKillProcess();
    devices.setMockChildProcess(device.name, replacement as ChildProcess);
    const kill = devices.killDevice.bind(devices);
    devices.killDevice = async (...args) => {
      await kill(...args);
      devices.setBootedDevices("android", []);
    };
    const controller = new AbortController();
    let attempts = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        attempts++;
        if (attempts === 1) {
          throw new SystemUiAnrRecoveryRequiredError("System UI ANR persisted after Wait");
        }
        controller.abort(new Error("cancelled after replacement readiness started"));
        throw controller.signal.reason;
      },
    });
    await expect(
      ToolRegistry.getTool("startDevice")!.handler(
        { platform: "android", name: device.name },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled after replacement readiness started");
    for (let turn = 0; turn < 200; turn++) {
      await Promise.resolve();
    }
    expect(replacement.killCalls).toBe(0);
    expect(pool.getDevice(device.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    expect(sessions.getSession("owner-session")).toBeNull();
    expect(gates.admissions).toHaveLength(1);
    expect(gates.admissions[0]?.releaseCalls).toBe(0);
    expect(bootHandoffs).toBe(1);
    // A listed replacement hands its admission back to discovery, counted once on each sample.
    expect(await gates.capacity("android")).toEqual({ booted: 1, inFlight: 0 });
    expect(await gates.capacity("android")).toEqual({ booted: 1, inFlight: 0 });
    expect(lifecycleReleases).toBe(1);
    expect(shutdownReleases).toBe(1);
    expect(readinessReleases).toBe(2);
    expect(routeReleases).toBe(1);
    expect(await pool.isShutdownReserved(device.deviceId)).toBe(false);
    expect(pool.isReservedForReadiness(device.deviceId)).toBe(false);
  });

  test("runningBeforeCall suppresses cancellation cleanup while an ordinary cold boot is stopped", async () => {
    const handle = new ExitOnKillProcess();
    const runningBeforeCall: DeviceBootResult = {
      device: { ...device, deviceId: "unit-unheld" },
      source: "cold-boot",
      runningBeforeCall: true,
      processHandle: handle as ChildProcess,
      provisioned: false,
    };
    const coldBoot: DeviceBootResult = {
      device: { ...device, deviceId: "unit-unheld" },
      source: "cold-boot",
      processHandle: handle as ChildProcess,
      provisioned: false,
    };

    expect(await cancelUnownedColdBoot(runningBeforeCall)).toBeUndefined();
    expect(handle.killCalls).toBe(0);
    await cancelUnownedColdBoot(coldBoot);
    expect(handle.killCalls).toBe(1);
  });

  test("rollBackUndeliveredBoot preserves an already-running Android device and stops a new boot", async () => {
    const identity = {
      kind: "stable" as const,
      platform: "android" as const,
      stableId: device.name,
    };
    const kept = new ExitOnKillProcess();
    const created = new ExitOnKillProcess();
    const alreadyRunning: DeviceBootResult = {
      device: { ...device, deviceId: "unit-unheld" },
      source: "cold-boot",
      runningBeforeCall: true,
      processHandle: kept as ChildProcess,
      provisioned: false,
    };
    const coldBoot: DeviceBootResult = {
      device: { ...device, deviceId: "unit-unheld" },
      source: "cold-boot",
      processHandle: created as ChildProcess,
      provisioned: false,
    };

    let deletes = 0;
    await rollBackUndeliveredBoot(alreadyRunning, identity, async () => {
      deletes++;
    });
    expect(deletes).toBe(0);
    await rollBackUndeliveredBoot(coldBoot, identity);

    expect(kept.killCalls).toBe(0);
    expect(created.killCalls).toBe(1);
  });

  test("iOS booted devices are kept and an iOS cold boot is stopped on rollback", async () => {
    const iosDevice: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA",
    };
    const identity = {
      kind: "stable" as const,
      platform: "ios" as const,
      stableId: iosDevice.deviceId,
    };
    const created = new ExitOnKillProcess();
    const kept = new ExitOnKillProcess();
    const alreadyBooted: DeviceBootResult = {
      device: iosDevice,
      source: "booted",
      processHandle: kept as ChildProcess,
      provisioned: false,
    };
    const coldBoot: DeviceBootResult = {
      device: iosDevice,
      source: "cold-boot",
      processHandle: created as ChildProcess,
      provisioned: false,
    };

    expect(cancelUnownedColdBoot(alreadyBooted)).toBeUndefined();
    await rollBackUndeliveredBoot(alreadyBooted, identity);
    expect(kept.killCalls).toBe(0);
    await rollBackUndeliveredBoot(coldBoot, identity);
    expect(created.killCalls).toBe(1);
    const cancelled = new ExitOnKillProcess();
    await cancelUnownedColdBoot({ ...coldBoot, processHandle: cancelled as ChildProcess });
    expect(cancelled.killCalls).toBe(1);
  });

  test("a rejected cancelled replacement tail warns and releases the preserved session", async () => {
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          throw new SystemUiAnrRecoveryRequiredError("System UI ANR persisted after Wait");
        }
      },
    });
    const originalKill = devices.killDevice.bind(devices);
    devices.killDevice = async (target, options) => {
      await originalKill(target, options);
      devices.setBootedDevices("android", []);
    };
    const launchStarted = Promise.withResolvers<void>();
    const launchGate = Promise.withResolvers<void>();
    beforePlatformLaunch = async () => {
      launchStarted.resolve();
      await launchGate.promise;
    };
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const start = ToolRegistry.getTool("startDevice")!.handler(
      { platform: "android", name: device.name },
      undefined,
      controller.signal,
    );

    try {
      await launchStarted.promise;
      controller.abort(new Error("caller disconnected"));
      await expect(start).rejects.toThrow("caller disconnected");
      expect(await gates.capacity("android")).toEqual({ booted: 0, inFlight: 1 });
      expect(gates.admissions[0]?.releaseCalls).toBe(0);
      expect(lifecycleReleases).toBe(0);
      launchGate.reject(new Error("deferred replacement failed"));
      for (let turn = 0; turn < 400; turn++) {
        await Promise.resolve();
      }

      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Background System UI ANR recovery failed"),
        expect.any(Error),
      );
      expect(gates.admissions).toHaveLength(1);
      expect(gates.admissions[0]?.releaseCalls).toBe(1);
      expect(bootHandoffs).toBe(0);
      expect(await gates.capacity("android")).toEqual({ booted: 0, inFlight: 0 });
      expect(pool.getDevice(device.deviceId)).toBeNull();
      expect(sessions.getSession("owner-session")).toBeNull();
      expect(pool.isReservedForReadiness(device.deviceId)).toBe(false);
      expect(await pool.isShutdownReserved(device.deviceId)).toBe(false);
      expect(await pool.isShutdownReservationHeld(device.deviceId)).toBe(false);
      expect(lifecycleReleases).toBe(1);
      expect(shutdownReleases).toBe(1);
      expect(readinessReleases).toBe(2);
      expect(routeReleases).toBe(1);
      expect(releaseOrder).toEqual(["readiness", "shutdown", "readiness", "route", "lifecycle"]);
    } finally {
      warning.mockRestore();
    }
  });

  test("a call-cold-boot replacement is killed when recovery is cancelled after relaunch", async () => {
    const heldSessionId = pool.getDevice(device.deviceId)?.sessionId;
    if (heldSessionId) {
      await sessions.releaseSession(heldSessionId);
      await pool.releaseDevice(device.deviceId, heldSessionId);
    }
    devices.setBootedDevices("android", []);
    matcher.setBootedResult(null);
    const originalProcess = new ExitOnKillProcess();
    const replacementProcess = new ExitOnKillProcess(() => devices.setBootedDevices("android", []));
    devices.setMockChildProcess(device.name, originalProcess as ChildProcess);
    let readinessCalls = 0;
    const controller = new AbortController();
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          devices.setMockChildProcess(device.name, replacementProcess as ChildProcess);
          throw new SystemUiAnrRecoveryRequiredError("System UI ANR persisted after Wait");
        }
        controller.abort(new Error("caller disconnected after relaunch"));
      },
    });
    const originalKill = devices.killDevice.bind(devices);
    devices.killDevice = async (target, options) => {
      await originalKill(target, options);
      devices.setBootedDevices("android", []);
      originalProcess.exit();
    };
    const start = ToolRegistry.getTool("startDevice")!.handler(
      { platform: "android", name: device.name },
      undefined,
      controller.signal,
    );

    await expect(start).rejects.toThrow("caller disconnected after relaunch");
    for (let turn = 0; turn < 400; turn++) {
      await Promise.resolve();
    }

    expect(readinessCalls).toBe(2);
    expect(replacementProcess.killCalls).toBe(1);
    expect(await devices.getBootedDevices("android")).toEqual([]);
    expect(await gates.capacity("android")).toEqual({ booted: 0, inFlight: 0 });
  });
});

class ExitOnKillProcess extends EventEmitter {
  readonly pid = 42001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls = 0;

  constructor(private readonly onExit?: () => void) {
    super();
  }

  kill(): boolean {
    this.killCalls++;
    this.exit();
    return true;
  }

  exit(): void {
    this.exitCode = 0;
    this.onExit?.();
    queueMicrotask(() => this.emit("exit", 0, null));
  }
}
