import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

describe("startDevice Android offline-recovery lease classification", () => {
  let timer: FakeTimer;
  let deviceUtils: FakeDeviceUtils;
  let sessionManager: SessionManager;
  let pool: DevicePool;

  const running: BootedDevice = {
    platform: "android",
    name: "Pixel_8_API_35",
    deviceId: "emulator-5554",
  };

  beforeEach(() => {
    timer = new FakeTimer();
    deviceUtils = new FakeDeviceUtils();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => new FakeDeviceMatcher(),
      timer,
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  async function captureLeaseOwnership(
    args: Record<string, unknown>,
    duringLookup?: () => Promise<void>,
  ): Promise<boolean | undefined> {
    let ownsOfflineRecovery: boolean | undefined;
    const reserve = spyOn(pool, "reserveAndroidStartupLease").mockImplementation(
      async (_name, _exactName, _signal, owns) => {
        ownsOfflineRecovery = owns;
        throw new Error("lease captured before boot");
      },
    );
    try {
      const start = ToolRegistry.getTool("startDevice")!.handler(args);
      await duringLookup?.();
      await expect(start).rejects.toThrow("lease captured before boot");
    } finally {
      reserve.mockRestore();
    }
    return ownsOfflineRecovery;
  }

  test("name-only warm reuse leaves the startup lease non-owning", async () => {
    deviceUtils.setBootedDevices("android", [running]);
    expect(await captureLeaseOwnership({ platform: "android", name: running.name })).toBe(false);
  });

  test("exact AVD cold boot without an adb serial owns offline recovery", async () => {
    deviceUtils.setBootedDevices("android", []);
    expect(await captureLeaseOwnership({ platform: "android", avdName: running.name })).toBe(true);
  });

  test("timed-out AVD image-name lookup leaves the startup lease non-owning", async () => {
    deviceUtils.setListDeviceImagesHangs("android", true);
    expect(
      await captureLeaseOwnership({ platform: "android", deviceId: running.name }, async () => {
        for (
          let attempt = 0;
          deviceUtils.getListDeviceImagesCalls().length === 0 && attempt < 50;
          attempt++
        ) {
          await Promise.resolve();
        }
        expect(deviceUtils.getListDeviceImagesCalls()).toHaveLength(1);
        timer.advanceTime(5_000);
      }),
    ).toBe(false);
  });

  test("timed-out booted-device lookup reserves a non-owning startup lease after five seconds", async () => {
    deviceUtils.setBootedDevicesDetailedHangs("android", true);
    expect(
      await captureLeaseOwnership({ platform: "android", avdName: running.name }, async () => {
        for (
          let attempt = 0;
          deviceUtils.getBootedDevicesDetailedCalls().length === 0 && attempt < 50;
          attempt++
        ) {
          await Promise.resolve();
        }
        const calls = deviceUtils.getBootedDevicesDetailedCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.options.bypassAndroidDeviceListCache).toBe(true);
        timer.advanceTime(5_000);
        expect(calls[0]?.options.signal?.aborted).toBe(true);
      }),
    ).toBe(false);
  });
});
