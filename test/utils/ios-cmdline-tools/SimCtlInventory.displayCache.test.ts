import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import capturedListing from "../../fixtures/ios-simctl/list-devices.json";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { SimulatorList } from "../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimulatorDeviceTypeProfiles } from "../../fakes/FakeSimulatorDeviceTypeProfiles";

const capturedDisplays = loadDuoEnumerate();

function resetSimctlInventory(): void {
  SimCtlClient.invalidateDeviceListCache();
}

function inventory() {
  const timer = new FakeTimer();
  const listing: SimulatorList = structuredClone(capturedListing);
  const devices = Object.values(listing.devices).flat();
  const device = devices.find((device) => device.deviceTypeIdentifier?.endsWith("iPhone-Duo"))!;
  device.state = "Booted";
  const [runtime] = Object.entries(listing.devices).find(([, devices]) =>
    devices.includes(device),
  )!;
  listing.devices = { [runtime]: [device] };
  let lists = 0;
  let enumerations = 0;
  let displayOutput = capturedDisplays;
  const client = new SimCtlClient(
    null,
    async (_file, args) => {
      if (args.join(" ") === "simctl list devices --json") {
        lists++;
        return createExecResult(JSON.stringify(listing), "");
      }
      if (args.join(" ") === `simctl io ${device.udid} enumerate`) {
        enumerations++;
        return createExecResult(displayOutput, "");
      }
      throw new Error(`Unexpected fake command: ${args.join(" ")}`);
    },
    { timer, platform: "darwin", deviceTypeProfiles: new FakeSimulatorDeviceTypeProfiles() },
  );
  const tick = async () => {
    timer.advanceTime(5_001);
    return client.listSimulatorImages();
  };
  return {
    client,
    listing,
    device,
    devices,
    tick,
    counts: () => ({ lists, enumerations }),
    changeDisplay: () => {
      displayOutput = capturedDisplays.replace("{1398, 2034}", "{1400, 2034}");
    },
  };
}

describe("SimCtlInventory per-boot display cache", () => {
  beforeEach(resetSimctlInventory);
  afterEach(resetSimctlInventory);

  test("six expired listings enumerate one unchanged boot only once", async () => {
    const rig = inventory();
    for (let tick = 0; tick < 6; tick++) {
      const listed = await rig.tick();
      expect(
        listed.find((device) => device.deviceId === rig.device.udid)?.displays?.panels,
      ).toHaveLength(2);
    }
    expect(rig.counts()).toEqual({ lists: 6, enumerations: 1 });
  });

  test("a changed captured lastUsedAt detects a reboot between booted listings", async () => {
    const rig = inventory();
    await rig.tick();
    rig.device.lastUsedAt = rig.devices.find(
      (device) => device.lastUsedAt !== rig.device.lastUsedAt && device.lastUsedAt,
    )!.lastUsedAt;
    rig.changeDisplay();
    const listed = await rig.tick();
    await rig.tick();
    expect(
      listed.find((device) => device.deviceId === rig.device.udid)?.displays?.panels[0]?.sizePx
        .width,
    ).toBe(1400);
    expect(rig.counts()).toEqual({ lists: 3, enumerations: 2 });
  });

  test.each(["Shutdown", "Booting", "Shutting Down"])(
    "%s retires the boot even without a timestamp",
    async (state) => {
      const rig = inventory();
      delete rig.device.lastUsedAt;
      await rig.tick();
      rig.device.state = state;
      await rig.tick();
      rig.device.state = "Booted";
      await rig.tick();
      await rig.tick();
      expect(rig.counts()).toEqual({ lists: 4, enumerations: 2 });
    },
  );

  test("a removed simulator's display entry is retired", async () => {
    const rig = inventory();
    await rig.tick();
    const devices = rig.listing.devices;
    rig.listing.devices = {};
    await rig.tick();
    rig.listing.devices = devices;
    await rig.tick();
    await rig.tick();
    expect(rig.counts()).toEqual({ lists: 4, enumerations: 2 });
  });

  test.each(["invalidate", "bypass"])(
    "explicit %s refreshes displays then reuses them",
    async (refresh) => {
      const rig = inventory();
      await rig.tick();
      await rig.tick();
      if (refresh === "invalidate") {
        SimCtlClient.invalidateDeviceListCache();
        await rig.tick();
      } else {
        await rig.client.listSimulatorImages(undefined, { bypassCache: true });
      }
      await rig.tick();
      expect(rig.counts()).toEqual({ lists: 4, enumerations: 2 });
    },
  );
});
