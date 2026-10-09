import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../src/models";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { DevicectlDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDiscoveryObservationSequence } from "../fakes/FakeDiscoveryObservationSequence";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  derivePhysicalDevicectlRecord,
  loadDerivedDevicectlListing,
} from "../helpers/devicectlListFixtures";

// Captured `xcrun simctl list devices -j`: every simulator is Shutdown.
const capturedSimctlListing = readFileSync(
  join(import.meta.dir, "..", "fixtures", "ios-simctl", "list-devices.json"),
  "utf8",
);
const capturedSimulatorUdid = Object.values(
  JSON.parse(capturedSimctlListing).devices as Record<string, { udid: string }[]>,
)
  .flat()
  .map((device) => device.udid)[0]!;
const PHYSICAL_UDID = "00008120-001C2D3E1234567A";
const DEVICECTL_RETENTION_MS = 60_000;

function resetSimctlSharedListing(): void {
  (SimCtlClient as unknown as { inFlightDeviceList: unknown }).inFlightDeviceList = null;
  SimCtlClient.invalidateDeviceListCache();
}

/** DERIVED from the captured devicectl listing: one record turned into a connected iPhone. */
function physicalDevicectlListing(): string {
  const listing = loadDerivedDevicectlListing();
  listing.result.devices = [
    derivePhysicalDevicectlRecord(listing.result.devices[0]!, PHYSICAL_UDID),
  ];
  return JSON.stringify(listing);
}

describe("DeviceSessionManager iOS readiness discovery (#11063)", () => {
  beforeEach(resetSimctlSharedListing);
  afterEach(resetSimctlSharedListing);

  test("a failed simctl listing keeps a pinned simulator; a completed one clears it", async () => {
    let simctlFails = true;
    const simctl = new SimCtlClient(
      null,
      async () => {
        if (simctlFails) {
          throw new Error("CoreSimulatorService connection became invalid");
        }
        return createExecResult(capturedSimctlListing, "");
      },
      new FakeTimer(),
      "darwin",
    );
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils(), simctl),
    );
    const pinned: BootedDevice = {
      deviceId: capturedSimulatorUdid,
      name: "iPhone",
      platform: "ios",
    };
    manager.setExplicitDevicePin(pinned);

    const failed = await manager.detectConnectedPlatformsWithStatus();
    expect(failed.scannedSources?.["ios-simulator"]).toBe(false);
    await expect(manager.ensureDeviceReady("ios", "absent-device")).rejects.toThrow("not found");
    expect(manager.getExplicitDevicePin()).toEqual(pinned);

    simctlFails = false;
    resetSimctlSharedListing();
    await expect(manager.ensureDeviceReady("ios", "absent-device")).rejects.toThrow("not found");
    expect(manager.getExplicitDevicePin()).toBeUndefined();
  });

  describe("physical iPhones", () => {
    let timer: FakeTimer;
    let devicectlCalls: number;
    let devicectlFails: boolean;
    let manager: DeviceSessionManager;

    beforeEach(() => {
      timer = new FakeTimer();
      devicectlCalls = 0;
      devicectlFails = false;
      const lister = new DevicectlDeviceLister({
        platform: () => "darwin",
        timer,
        observationSequence: new FakeDiscoveryObservationSequence(),
        execute: async () => {
          devicectlCalls += 1;
          if (devicectlFails) {
            throw Object.assign(new Error("devicectl exited 1"), { code: 1 });
          }
          return createExecResult("", "");
        },
        readFile: async () => physicalDevicectlListing(),
        mkdtemp: async (prefix) => `${prefix}fake`,
        rm: async () => {},
        tmpdir: () => "/fake",
        logger: { warn: () => {}, debug: () => {} },
      });
      manager = DeviceSessionManager.createInstance(
        new FakeDeviceClientProvider(
          new FakeAdbExecutor(),
          new FakeDeviceUtils(),
          new FakeSimctl() as never,
          { iosPhysicalDeviceLister: lister },
        ),
      );
    });

    test("resolves a connected physical UDID on the sessionless scan", async () => {
      const scan = await manager.detectConnectedPlatformsWithStatus();
      expect(scan.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
      expect(scan.scannedSources).toEqual({
        android: true,
        "ios-simulator": true,
        "ios-physical": true,
      });
      // A second scan inside the lister's TTL reuses its cached sweep.
      await manager.detectConnectedPlatformsWithStatus();
      expect(devicectlCalls).toBe(1);
    });

    test("an incomplete devicectl sweep never clears a physical pin", async () => {
      const iphone = (await manager.detectConnectedPlatformsWithStatus()).devices[0]!;
      manager.setExplicitDevicePin(iphone);
      devicectlFails = true;
      timer.advanceTime(DEVICECTL_RETENTION_MS + 1);

      const scan = await manager.detectConnectedPlatformsWithStatus();
      expect(scan.devices).toEqual([]);
      expect(scan.scanned.ios).toBe(true);
      expect(scan.scannedSources?.["ios-physical"]).toBe(false);
      await expect(manager.ensureDeviceReady("ios", "absent-device")).rejects.toThrow("not found");
      expect(manager.getExplicitDevicePin()).toEqual(iphone);
    });
  });
});
