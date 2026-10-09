import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { DevicectlDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { createExecResult } from "../../src/utils/execResult";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { FakeDiscoveryObservationSequence } from "../fakes/FakeDiscoveryObservationSequence";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  derivePhysicalDevicectlRecord,
  loadDerivedDevicectlListing,
} from "../helpers/devicectlListFixtures";

const PHYSICAL_UDID = "00008120-001C2D3E1234567A";
const DEVICECTL_CACHE_TTL_MS = 3_000;

/** DERIVED from the captured devicectl listing: one record turned into a connected iPhone. */
function physicalDevicectlListing(): string {
  const listing = loadDerivedDevicectlListing();
  listing.result.devices = [
    derivePhysicalDevicectlRecord(listing.result.devices[0]!, PHYSICAL_UDID),
  ];
  return JSON.stringify(listing);
}

interface ListDevicesPayload {
  devices: { platform: string; runtime: { deviceId: string } }[];
  discovery: { complete: boolean; failedSources?: string[] };
}

describe("listDevices default device manager (#11063)", () => {
  let timer: FakeTimer;
  let devicectlCalls: number;
  let devicectlFails: boolean;

  const callListDevices = async (): Promise<ListDevicesPayload> => {
    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "ios" });
    return JSON.parse(response.content?.[0]?.text ?? "{}");
  };

  beforeAll(() => {
    if (!ToolRegistry.getTool("listDevices")) {
      registerDeviceTools();
    }
  });

  beforeEach(() => {
    // The default deviceManagerFactory, not a test override, is under test.
    resetDeviceToolsDependencies();
    setDeviceToolsDependencies({
      displayInventory: { hydrate: async (device) => device, invalidate: () => {} },
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
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
    PlatformDeviceManagerFactory.setInstance(
      new MultiPlatformDeviceManager(
        new FakeAdbExecutor(),
        new FakeSimctl() as never,
        createFakeAndroidEmulator(),
        new InMemoryVirtualDeviceLifecycleCoordinator(timer),
        timer,
        lister,
      ),
    );
  });

  afterEach(() => {
    PlatformDeviceManagerFactory.reset();
  });

  afterAll(() => {
    resetDeviceToolsDependencies();
    AndroidAvdProvenanceCache.resetForTests();
  });

  test("two calls inside the devicectl TTL invoke devicectl once", async () => {
    const first = await callListDevices();
    const second = await callListDevices();
    expect(first.devices.map((device) => device.runtime.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(second.devices.map((device) => device.runtime.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(devicectlCalls).toBe(1);
  });

  test("a single devicectl failure inside retention still lists the iPhone as partial", async () => {
    expect((await callListDevices()).discovery.complete).toBe(true);
    devicectlFails = true;
    timer.advanceTime(DEVICECTL_CACHE_TTL_MS);

    const payload = await callListDevices();
    expect(devicectlCalls).toBe(2);
    expect(payload.devices.map((device) => device.runtime.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(payload.discovery.complete).toBe(false);
    expect(payload.discovery.failedSources).toEqual(["ios-physical"]);
  });
});
