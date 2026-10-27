import { makePool } from "../helpers/makePool";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();

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

  function arrangeHarness(): void {
    timer = new FakeTimer();
    deviceUtils = new FakeDeviceUtils();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = makePool(sessionManager, "daemon-session", { timer, deviceManager: deviceUtils });
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => new FakeDeviceMatcher(),
      timer,
    });
    registerDeviceTools();
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

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

  arranged("name-only warm reuse leaves the startup lease non-owning", async () => {
    deviceUtils.setBootedDevices("android", [running]);
    expect(await captureLeaseOwnership({ platform: "android", name: running.name })).toBe(false);
  });

  arranged(
    "a foreign unresolved emulator does not suppress cold-boot offline recovery",
    async () => {
      deviceUtils.setBootedDevices("android", [
        {
          platform: "android",
          deviceId: "emulator-5556",
          name: "Unknown (emulator-5556)",
          foreignOwned: true,
        },
      ]);
      expect(await captureLeaseOwnership({ platform: "android", avdName: running.name })).toBe(
        true,
      );
    },
  );

  arranged("exact AVD cold boot without an adb serial owns offline recovery", async () => {
    deviceUtils.setBootedDevices("android", []);
    expect(await captureLeaseOwnership({ platform: "android", avdName: running.name })).toBe(true);
  });

  arranged("timed-out AVD image-name lookup leaves the startup lease non-owning", async () => {
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

  arranged(
    "timed-out booted-device lookup reserves a non-owning startup lease after five seconds",
    async () => {
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
    },
  );
});
