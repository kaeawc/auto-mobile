import { afterEach, describe, expect, test } from "bun:test";
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

// The captured `simctl list -j` (watchOS 26.5 runtime, Apple Watch Series 11 46mm) from #17320's host.
const WATCH_RUNTIME = "com.apple.CoreSimulator.SimRuntime.watchOS-26-5";
const WATCH_UDID = "34028208-ECD5-4ADC-BFA5-55E6D00AC532";

function host() {
  const simctl = new FakeWatchSimctl();
  simctl.listing = structuredClone(fixture);
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl(),
    createFakeAndroidEmulator(),
  ).withWatchSimulators(new WatchSimulatorInventory(simctl, "arm64"));
  setDeviceToolsDependencies({
    deviceManagerFactory: () => manager,
    avdManagerFactory: () => new FakeAvdManager(),
    timer: new FakeTimer(),
    bootCapacityReporters: {},
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
