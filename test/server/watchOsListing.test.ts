import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimulatorPairs, pairsFixture, capturedPair } from "../fakes/FakeSimulatorPairs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/ios-simctl/list-all-appletv-26-5.json";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { createListingHandlers } from "../../src/server/deviceToolsListing";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import {
  listDevicesOutputSchema,
  listDevicesSchema,
} from "../../src/features/deviceLifecycle/core/toolSchemas";
import { FakeWatchSimctl } from "../fakes/FakeWatchSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { toolJson } from "../helpers/toolResponse";
import type { IosPhysicalDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";

// The captured `simctl list -j` (watchOS 26.5 runtime, Apple Watch Series 11 46mm) from #17320's host.
const WATCH_RUNTIME = "com.apple.CoreSimulator.SimRuntime.watchOS-26-5";
const WATCH_UDID = "34028208-ECD5-4ADC-BFA5-55E6D00AC532";

/**
 * A physical-iOS source that never runs devicectl. Without it the manager falls back to the shared
 * devicectl lister, which spawns `xcrun devicectl` on macOS (#17455). It counts its calls, so a test
 * can show discovery consulted this fake rather than the real tool.
 */
function fakePhysicalIos(): IosPhysicalDeviceLister & { calls: number } {
  const lister: IosPhysicalDeviceLister & { calls: number } = {
    calls: 0,
    listConnectedDevices: async () => {
      lister.calls += 1;
      return { devices: [], complete: true };
    },
  };
  return lister;
}

function host() {
  const simctl = new FakeWatchSimctl();
  simctl.listing = structuredClone(fixture);
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl(),
    createFakeAndroidEmulator(),
    { physicalIosDevices: fakePhysicalIos() },
  ).withWatchSimulators(new WatchSimulatorInventory(simctl, "arm64"));
  setDeviceToolsDependencies({
    deviceManagerFactory: () => manager,
    avdManagerFactory: () => new FakeAvdManager(),
    timer: new FakeTimer(),
    bootCapacityReporters: {},
    simulatorPairServiceFactory: () => new FakeSimulatorPairs().service(),
  });
  return { simctl, handlers: createListingHandlers() };
}

afterEach(() => resetDeviceToolsDependencies());

describe("watchOS listDevices (#17320)", () => {
  test("the listDevices schema accepts platform watchos", () => {
    expect(listDevicesSchema.safeParse({ platform: "watchos" }).success).toBe(true);
  });

  test("lists only booted Apple Watches under watchos", async () => {
    const { simctl, handlers } = host();
    const watch = simctl.listing.devices[WATCH_RUNTIME].find((d) => d.udid === WATCH_UDID);
    if (!watch) {
      throw new Error("fixture is missing the Series 11 watch");
    }
    watch.state = "Booted";
    const result = toolJson(await handlers.listDevicesHandler({ platform: "watchos" }));
    expect(result).toMatchObject({
      count: 1,
      discovery: { complete: true },
      devices: [{ platform: "watchos", identity: { stableId: WATCH_UDID } }],
    });
    // Configured-image enrichment reads the watch inventory, so a healthy listing is complete.
    expect(result).not.toHaveProperty("enrichment");
    // MCP clients validate structuredContent against the advertised output schema.
    expect(listDevicesOutputSchema.safeParse(result).success).toBe(true);
  });

  test("a failed watch inventory reports incomplete", async () => {
    const { simctl, handlers } = host();
    simctl.listingError = new Error("simctl failed");
    expect(toolJson(await handlers.listDevicesHandler({ platform: "watchos" }))).toMatchObject({
      count: 0,
      discovery: { complete: false, failedPlatforms: ["watchos"] },
    });
  });
});

test.each(["watchos", "ios", undefined] as const)(
  "%s listing includes simulator pairs",
  async (platform) => {
    const f = host();
    if (platform !== "watchos") {
      setDeviceToolsDependencies({ deviceManagerFactory: () => new FakeDeviceUtils() });
    }
    const pairs = new FakeSimulatorPairs();
    pairs.listing = pairsFixture("list-pairs-active-connected.json");
    setDeviceToolsDependencies({ simulatorPairServiceFactory: () => pairs.service() });
    const result = toolJson(await f.handlers.listDevicesHandler(platform ? { platform } : {}));
    expect(result.simulatorPairs).toEqual([
      {
        ...capturedPair,
        connection: "connected",
        watch: { ...capturedPair.watch, state: "Booted" },
        phone: { ...capturedPair.phone, state: "Booted" },
      },
    ]);
    expect(listDevicesOutputSchema.safeParse(result).success).toBe(true);
  },
);
test("pair listing failure omits simulatorPairs", async () => {
  const f = host();
  const service = new FakeSimulatorPairs().service();
  service.list = async () => {
    throw new Error("listing failed");
  };
  setDeviceToolsDependencies({ simulatorPairServiceFactory: () => service });
  expect(
    toolJson(await f.handlers.listDevicesHandler({ platform: "watchos" })).simulatorPairs,
  ).toBeUndefined();
});

describe("listDevices pair source is the device manager's simctl (#17418)", () => {
  function managerHost(manager: MultiPlatformDeviceManager) {
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => new FakeAvdManager(),
      timer: new FakeTimer(),
      bootCapacityReporters: {},
    });
    return createListingHandlers();
  }
  let physicalIos = fakePhysicalIos();
  beforeEach(() => {
    physicalIos = fakePhysicalIos();
  });
  const availableSimctl = () =>
    fakeDeviceManagerSimctl({
      isAvailable: async () => true,
      getBootedSimulatorsChecked: async () => [],
    });

  test("a manager over a fake simctl lists no pairs", async () => {
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      availableSimctl(),
      createFakeAndroidEmulator(),
      { physicalIosDevices: physicalIos },
    );
    expect(await manager.listSimulatorPairs()).toEqual([]);
    const result = toolJson(await managerHost(manager).listDevicesHandler({ platform: "ios" }));
    expect(result).not.toHaveProperty("simulatorPairs");
    // The ios listing's physical devices came from the fake, not a real devicectl spawn.
    expect(physicalIos.calls).toBe(1);
  });

  test("the injected pair source is listed under ios", async () => {
    const pairs = new FakeSimulatorPairs();
    pairs.listing = pairsFixture("list-pairs-active-connected.json");
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      availableSimctl(),
      createFakeAndroidEmulator(),
      { physicalIosDevices: physicalIos },
    ).withSimulatorPairs(pairs.service());
    const result = toolJson(await managerHost(manager).listDevicesHandler({ platform: "ios" }));
    expect(result.simulatorPairs).toHaveLength(1);
    expect(pairs.calls).toEqual([["list", "pairs", "-j"]]);
    expect(physicalIos.calls).toBe(1);
  });

  test("a failing pair source leaves the device listing unchanged", async () => {
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      availableSimctl(),
      createFakeAndroidEmulator(),
      { physicalIosDevices: physicalIos },
    ).withSimulatorPairs({
      list: async () => {
        throw new Error("simctl list pairs failed");
      },
    });
    const result = toolJson(await managerHost(manager).listDevicesHandler({ platform: "ios" }));
    expect(result).toMatchObject({ count: 0, discovery: { complete: true } });
    expect(result).not.toHaveProperty("simulatorPairs");
    expect(physicalIos.calls).toBe(1);
  });
});
