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

function inventory(foldable = false) {
  const timer = new FakeTimer();
  const listing: SimulatorList = structuredClone(capturedListing);
  const devices = Object.values(listing.devices).flat();
  const device = devices.find((device) =>
    device.deviceTypeIdentifier?.endsWith(foldable ? ".iPhone-Duo" : ".iPhone-18-Pro"),
  )!;
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
    timer,
    listing,
    device,
    devices,
    tick,
    counts: () => ({ lists, enumerations }),
    setDisplayOutput: (output: string) => {
      displayOutput = output;
    },
    changeDisplay: () => {
      displayOutput = capturedDisplays.replace("{1398, 2034}", "{1400, 2034}");
    },
  };
}

describe("SimCtlInventory per-boot display cache", () => {
  beforeEach(resetSimctlInventory);
  afterEach(resetSimctlInventory);

  test("an empty display list is retried on the next listing", async () => {
    const rig = inventory();
    rig.setDisplayOutput("");
    const empty = await rig.tick();
    expect(empty[0].displays).toBeUndefined();
    rig.setDisplayOutput(capturedDisplays);
    const listed = await rig.tick();
    expect(listed[0].displays?.panels).toHaveLength(2);
    await rig.tick();
    expect(rig.counts()).toEqual({ lists: 3, enumerations: 2 });
  });

  test("foldable displays refresh without a reboot when fold state changes", async () => {
    const rig = inventory(true);
    const initial = await rig.tick();
    expect(initial[0].displays?.panels[0]?.sizePx.width).toBe(1398);
    rig.changeDisplay();
    const changed = await rig.tick();
    expect(changed[0].displays?.panels[0]?.sizePx.width).toBe(1400);
    expect(rig.counts()).toEqual({ lists: 2, enumerations: 2 });
  });

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

  test("explicit invalidate refreshes displays then reuses them", async () => {
    const rig = inventory();
    await rig.tick();
    await rig.tick();
    SimCtlClient.invalidateDeviceListCache();
    await rig.tick();
    await rig.tick();
    expect(rig.counts()).toEqual({ lists: 4, enumerations: 2 });
  });

  test("bypass within 60 seconds reuses displays while refreshing the device list", async () => {
    const rig = inventory();
    await rig.tick();
    await rig.tick();
    await rig.client.listSimulatorImages(undefined, { bypassCache: true });
    expect(rig.counts()).toEqual({ lists: 3, enumerations: 1 });
    await rig.tick();
    expect(rig.counts()).toEqual({ lists: 4, enumerations: 1 });
  });

  test("bypass after 60 seconds refreshes displays then reuses the new entry", async () => {
    const rig = inventory();
    await rig.client.listSimulatorImages();
    rig.timer.advanceTime(60_001);
    rig.changeDisplay();
    const refreshed = await rig.client.listSimulatorImages(undefined, { bypassCache: true });
    expect(refreshed[0].displays?.panels[0]?.sizePx.width).toBe(1400);
    expect(rig.counts()).toEqual({ lists: 2, enumerations: 2 });
    rig.timer.advanceTime(10_000);
    await rig.client.listSimulatorImages(undefined, { bypassCache: true });
    expect(rig.counts()).toEqual({ lists: 3, enumerations: 2 });
  });

  test("ten bypass listings 10 seconds apart enumerate only at 0 and 60 seconds", async () => {
    const rig = inventory();
    await rig.client.listSimulatorImages();
    expect(rig.counts()).toEqual({ lists: 1, enumerations: 1 });
    for (let listing = 1; listing <= 10; listing++) {
      rig.timer.advanceTime(10_000);
      await rig.client.listSimulatorImages(undefined, { bypassCache: true });
      expect(rig.counts()).toEqual({
        lists: listing + 1,
        enumerations: listing < 6 ? 1 : 2,
      });
    }
  });
});
