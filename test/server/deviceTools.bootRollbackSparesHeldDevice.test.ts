import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { RealBootGatesOverFakeFleet } from "../helpers/realBootGatesOverFakeFleet";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type DeviceInfo } from "../../src/models";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { resetProvisionedDeviceTransportFenceForTests } from "../../src/utils/provisionedDeviceTransportFence";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();

/**
 * A start's readiness reservation keeps its device out of general allocation only; an exact bind
 * (setActiveDevice) by another session is admitted while the booting call is still preparing the
 * runner. When the booting call then fails (runner readiness fails, or its own bind is refused
 * because the other session now holds the device), its cleanup must not stop the device it
 * booted: lifecycle on a device another live session holds is refused (#11651). With no such
 * holder the device is stopped as before, so nothing this call booted is left running unheld.
 */
describe("a failed start does not stop the device it booted once another session holds it", () => {
  const AVD_SERIAL = "emulator-5554";
  const SIM_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
  const avd: DeviceInfo = {
    name: "Pixel_7_API_34",
    platform: "android",
    deviceId: AVD_SERIAL,
    isRunning: false,
    source: "local",
    osVersion: "14",
    formFactor: "phone",
  };
  const simulator: DeviceInfo = {
    name: "iPhone 16",
    platform: "ios",
    deviceId: SIM_UDID,
    isRunning: false,
    source: "local",
    osVersion: "18.2",
    iosVersion: "18.2",
    formFactor: "phone",
  };

  /** The boot's process handle: `kill` is what stops the cold-booted device. */
  class RecordingBootHandle extends EventEmitter {
    readonly pid = 4242;
    exitCode: number | null = null;
    readonly signalCode: NodeJS.Signals | null = null;
    killed = false;

    constructor(private readonly onKill: () => void) {
      super();
    }

    kill(): boolean {
      this.killed = true;
      this.onKill();
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, null));
      return true;
    }
  }

  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: FakeDeviceUtils;
  let pool: DevicePool;
  let bootHandle: RecordingBootHandle;
  let gates: RealBootGatesOverFakeFleet;
  /** Runs while the booting call prepares the runner: after boot, before its bind. */
  let duringReadiness: (() => Promise<void>) | undefined;

  const arrange = (): void => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    duringReadiness = undefined;
    timer = new FakeTimer();
    devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", []);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("android", [avd]);
    devices.setDeviceImages("ios", [simulator]);
    bootHandle = new RecordingBootHandle(() => {
      devices.setBootedDevices("android", []);
      devices.setBootedDevices("ios", []);
    });
    devices.setMockChildProcess(avd.name, bootHandle as unknown as ChildProcess);
    devices.setMockChildProcess(simulator.name, bootHandle as unknown as ChildProcess);
    // Every boot is admitted through the real gates, at a limit of one device a platform.
    gates = new RealBootGatesOverFakeFleet(devices, timer, 1);
    const idGenerator = new CountingIdGenerator("booter");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    setDeviceToolsDependencies({
      env,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      clearInstalledAppsForDevice: async () => {},
      ensureCtrlProxyReady: async () => {
        const hook = duringReadiness;
        duringReadiness = undefined;
        await hook?.();
      },
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-rollback-daemon", {
        env,
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  };

  const dispose = (): void => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer.reset();
  };
  beforeEach(arrange);
  afterEach(dispose);

  /** Give deferred cleanup and its grace timers room to run. */
  const drain = async (): Promise<void> => {
    for (let second = 0; second < 5; second++) {
      for (let turn = 0; turn < 100; turn++) {
        await Promise.resolve();
      }
      timer.advanceTime(1_000);
    }
  };

  /** Another session selects the freshly booted device by id while the boot's caller prepares it. */
  const otherSessionSelects = async (deviceId: string): Promise<void> => {
    const select = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    await select({ deviceId, sessionUuid: "other-session", __mcpSessionId: "client-b" });
    expect(pool.getDevice(deviceId)?.sessionId).toBe("other-session");
  };

  const start = async (args: Record<string, unknown>): Promise<unknown> =>
    ToolRegistry.getTool("startDevice")!
      .handler({ ...args, __mcpSessionId: "client-a" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  const TARGETS = [
    { platform: "android", args: { platform: "android", name: avd.name }, deviceId: AVD_SERIAL },
    { platform: "ios", args: { platform: "ios", deviceId: SIM_UDID }, deviceId: SIM_UDID },
  ] as const;

  // The file's first start pays the one-off module and JIT cost of the whole startDevice path,
  // which is not part of any scenario: pay it here on a throwaway pool. Every test still
  // arranges, runs and drains its own scenario in full.
  beforeAll(async () => {
    arrange();
    duringReadiness = async () => {
      throw new Error("warm-up");
    };
    await start(TARGETS[0].args);
    await drain();
    dispose();
  });

  /** The spared device is the one booted device: its boot's slot was let go exactly once. */
  const expectSparedAndCountedOnce = async (
    platform: "android" | "ios",
    deviceId: string,
  ): Promise<void> => {
    expect(bootHandle.killed).toBe(false);
    expect(sessions.getSession("other-session")?.assignedDevice).toBe(deviceId);
    expect(pool.getDevice(deviceId)?.sessionId).toBe("other-session");
    expect(gates.admissions.map((admission) => admission.platform)).toEqual([platform]);
    expect(await gates.capacity(platform)).toEqual({ booted: 1, inFlight: 0 });
    expect(await gates.admitsOneMoreBoot(platform)).toBe(false);
  };

  test.each(TARGETS)(
    "$platform: runner readiness fails after another session selected the device",
    async ({ platform, args, deviceId }) => {
      duringReadiness = async () => {
        await otherSessionSelects(deviceId);
        throw new Error("automation runner did not become ready");
      };

      const failure = await start(args);
      await drain();

      expect(failure).toBeInstanceOf(ActionableError);
      expect((failure as Error).message).toContain("automation runner did not become ready");
      await expectSparedAndCountedOnce(platform, deviceId);
    },
  );

  test.each(TARGETS)(
    "$platform: the booting call loses its bind to another session's selection",
    async ({ platform, args, deviceId }) => {
      duringReadiness = async () => await otherSessionSelects(deviceId);

      const failure = await start(args);
      await drain();

      expect(failure).toMatchObject({ code: "device_owned_by_other_session" });
      await expectSparedAndCountedOnce(platform, deviceId);
    },
  );

  test.each(TARGETS)(
    "$platform: a device the other session let go again is stopped with the failed start",
    async ({ platform, args, deviceId }) => {
      duringReadiness = async () => {
        await otherSessionSelects(deviceId);
        await sessions.releaseSession("other-session");
        await pool.releaseDevice(deviceId, "other-session");
        throw new Error("automation runner did not become ready");
      };

      const failure = await start(args);
      await drain();

      expect(failure).toBeInstanceOf(ActionableError);
      expect(bootHandle.killed).toBe(true);
      expect(await gates.capacity(platform)).toEqual({ booted: 0, inFlight: 0 });
      expect(await gates.admitsOneMoreBoot(platform)).toBe(true);
    },
  );
});
