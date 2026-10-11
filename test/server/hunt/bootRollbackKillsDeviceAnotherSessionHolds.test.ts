import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { setDeviceManager } from "../../../src/server/bootedDeviceResources";
import { clearDirectSessionDevices } from "../../../src/server/directSessionDeviceRegistry";
import { createSetActiveDeviceHandler } from "../../../src/server/setActiveDevice";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { DeviceInfo } from "../../../src/models";
import { DefaultDeviceMatcher } from "../../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { resetProvisionedDeviceTransportFenceForTests } from "../../../src/utils/provisionedDeviceTransportFence";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";

isolateToolRegistry();

/**
 * HUNT (provisioning-6): a start's readiness reservation keeps its device out of general
 * allocation only; an exact bind (setActiveDevice) by another session is admitted while the
 * booting call is still preparing the runner. When the booting call then fails (runner readiness
 * fails, or its own bind is refused because the other session now holds the device), its cleanup
 * stops the device it booted: `cancelUnownedColdBoot` asks whether the pool tracks ITS process on
 * the device, which is recorded only at its own bind, so a device held by somebody else counts as
 * "unowned" and is killed under the live session that holds it.
 */
describe("hunt: a failed start does not stop the device it booted once another session holds it", () => {
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
  /** Runs while the booting call prepares the runner: after boot, before its bind. */
  let duringReadiness: (() => Promise<void>) | undefined;

  beforeEach(() => {
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
    const idGenerator = new CountingIdGenerator("booter");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    setDeviceToolsDependencies({
      env,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      checkBootCapacity: async () => {},
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
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer.reset();
  });

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

  test.each(TARGETS)(
    "$platform: runner readiness fails after another session selected the device",
    async ({ args, deviceId }) => {
      duringReadiness = async () => {
        await otherSessionSelects(deviceId);
        throw new Error("automation runner did not become ready");
      };

      const failure = await start(args);
      await drain();

      expect(failure).toBeInstanceOf(Error);
      expect(sessions.getSession("other-session")?.assignedDevice).toBe(deviceId);
      expect(bootHandle.killed).toBe(false);
      expect(pool.getDevice(deviceId)?.sessionId).toBe("other-session");
    },
  );

  // Android already spares the device on this path (the refused bind records the boot's process
  // before it fails, so cleanup sees the holder); iOS does not.
  test.each(TARGETS.filter(({ platform }) => platform === "ios"))(
    "$platform: the booting call loses its bind to another session's selection",
    async ({ args, deviceId }) => {
      duringReadiness = async () => await otherSessionSelects(deviceId);

      const failure = await start(args);
      await drain();

      expect(failure).toMatchObject({ code: "device_owned_by_other_session" });
      expect(sessions.getSession("other-session")?.assignedDevice).toBe(deviceId);
      expect(bootHandle.killed).toBe(false);
      expect(pool.getDevice(deviceId)?.sessionId).toBe("other-session");
    },
  );
});
