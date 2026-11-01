import { describe, expect, test } from "bun:test";
import { readWatchSessionDeviceCatalog } from "../../../src/devices/sessionCatalog";
import { WatchSimulatorInventory } from "../../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  FakeWatchSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME,
  WATCH_RUNTIME_ID,
} from "../../fakes/FakeWatchSimctl";

const IOS_RUNTIME = {
  ...WATCH_RUNTIME,
  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
  version: "18.6",
  name: "iOS 18.6",
};
const IPHONE = {
  ...WATCH_DEVICE_TYPE,
  productFamily: "iPhone",
  identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "iPhone 16",
};
const warnings: string[] = [];
const logger = { warn: (message: string) => void warnings.push(message) };

function inventory(): { simctl: FakeWatchSimctl; reader: WatchSimulatorInventory } {
  const simctl = new FakeWatchSimctl();
  simctl.runtimes = [
    IOS_RUNTIME,
    {
      ...WATCH_RUNTIME,
      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-10-5",
      version: "10.5",
      isAvailable: false,
    },
    WATCH_RUNTIME,
  ];
  simctl.deviceTypes = [IPHONE, WATCH_DEVICE_TYPE];
  return { simctl, reader: new WatchSimulatorInventory(simctl) };
}

describe("watch session catalog", () => {
  test("lists only watchOS runtimes and Apple Watch device types, with availability", async () => {
    const catalog = await readWatchSessionDeviceCatalog(inventory().reader, { logger });

    expect(catalog.provenance).toMatchObject({ source: "simctl-watch-catalog", state: "ready" });
    expect(catalog.runtimes).toEqual([
      {
        runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-10-5",
        osVersion: "10.5",
        installed: false,
      },
      { runtime: WATCH_RUNTIME_ID, osVersion: "11.0", installed: true },
    ]);
    expect(catalog.deviceTypes).toEqual([
      { deviceType: WATCH_DEVICE_TYPE.identifier, name: WATCH_DEVICE_TYPE.name },
    ]);
  });

  test("the revision changes with the installed catalog", async () => {
    const { simctl, reader } = inventory();
    const before = await readWatchSessionDeviceCatalog(reader, { logger });
    simctl.runtimes = [WATCH_RUNTIME];
    const after = await readWatchSessionDeviceCatalog(reader, { logger });
    expect(after.provenance.revision).not.toBe(before.provenance.revision);
  });

  test("a host without simctl reports the watch catalog as not installed", async () => {
    expect(await readWatchSessionDeviceCatalog(undefined, { logger })).toEqual({
      platform: "watchos",
      provenance: {
        source: "simctl-watch-catalog",
        revision: "not-installed",
        state: "not-installed",
        message: "Apple Watch simulators exist only on macOS hosts with Xcode's simctl.",
      },
      runtimes: [],
      deviceTypes: [],
    });
  });

  test("an unreadable catalog is reported unavailable and logged, not as an empty ready one", async () => {
    warnings.length = 0;
    const { simctl, reader } = inventory();
    simctl.catalogError = new Error("CoreSimulatorService connection interrupted");

    const catalog = await readWatchSessionDeviceCatalog(reader, { logger });

    expect(catalog.provenance).toEqual({
      source: "simctl-watch-catalog",
      revision: "unavailable",
      state: "unavailable",
      message:
        "Unable to read the Apple Watch simulator catalog: CoreSimulatorService connection interrupted",
    });
    expect(warnings).toEqual([catalog.provenance.message!]);
  });

  test("an aborted read propagates instead of reporting the catalog unavailable", async () => {
    const { simctl, reader } = inventory();
    const controller = new AbortController();
    controller.abort();
    simctl.catalogError = new Error("aborted");
    await expect(
      readWatchSessionDeviceCatalog(reader, { logger, signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});
