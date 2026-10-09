import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import type {
  IosPhysicalDeviceLister,
  PhysicalIosDeviceDiscovery,
} from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";

describe("DeviceSessionManager physical iOS scan budget (#11077)", () => {
  const physical: BootedDevice = { deviceId: "udid-1", name: "iPhone", platform: "ios" };

  function setup() {
    let calls = 0;
    let release: ((value: PhysicalIosDeviceDiscovery) => void) | undefined;
    const lister: IosPhysicalDeviceLister = {
      listConnectedDevices: () => {
        calls += 1;
        return new Promise<PhysicalIosDeviceDiscovery>((resolve) => {
          release = resolve;
        });
      },
    };
    const timer = new FakeTimer();
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils(), new FakeSimctl() as never, {
        iosPhysicalDeviceLister: lister,
      }),
      undefined,
      { runnerReadinessTimer: timer, physicalIosScanBudgetMs: 1_000 },
    );
    return {
      manager,
      timer,
      calls: () => calls,
      release: (value: PhysicalIosDeviceDiscovery) => release?.(value),
    };
  }

  test("an Android-only scan never waits on or starts the physical lister", async () => {
    const { manager, calls } = setup();
    const scan = await manager.detectConnectedPlatformsWithStatus(undefined, {
      platform: "android",
    });
    expect(calls()).toBe(0);
    expect(scan.scannedSources["ios-physical"]).toBe(false);
  });

  test("a hung lister loses to the readiness budget and leaves ios-physical unscanned", async () => {
    const { manager, timer, calls, release } = setup();
    const pending = manager.detectConnectedPlatformsWithStatus();
    await Promise.resolve();
    await timer.advanceTimeAsync(1_000);
    const scan = await pending;
    expect(calls()).toBe(1);
    expect(scan.scannedSources["ios-physical"]).toBe(false);
    expect(scan.scannedSources.android).toBe(true);
    // The shared run is not cancelled: a late result is simply ignored.
    release({ devices: [physical], complete: true });
  });

  test("an aborted caller returns promptly without waiting on the lister", async () => {
    const { manager } = setup();
    const controller = new AbortController();
    const pending = manager.detectConnectedPlatformsWithStatus(controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
