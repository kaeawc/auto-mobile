import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import capturedListing from "../../fixtures/ios-simctl/list-devices.json";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { SimulatorList } from "../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
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
  let enumerateGate: Promise<void> | undefined;
  const client = new SimCtlClient(
    null,
    async (_file, args) => {
      if (args.join(" ") === "simctl list devices --json") {
        lists++;
        return createExecResult(JSON.stringify(listing), "");
      }
      if (args.join(" ") === `simctl io ${device.udid} enumerate`) {
        enumerations++;
        await enumerateGate;
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
    holdEnumerate: () => {
      const gate = Promise.withResolvers<void>();
      enumerateGate = gate.promise;
      return gate.resolve;
    },
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

  test("concurrent bypass listings share one in-flight enumeration (boot storm)", async () => {
    const rig = inventory();
    const release = rig.holdEnumerate();
    const listings = Array.from({ length: 6 }, () =>
      rig.client.listSimulatorImages(undefined, { bypassCache: true }),
    );
    await drainUntil(() => rig.counts().enumerations > 0, { description: "first enumeration" });
    await drainMicrotasks(40);
    expect(rig.counts().enumerations).toBe(1);
    release();
    for (const listed of await Promise.all(listings)) {
      expect(listed[0].displays?.panels).toHaveLength(2);
    }
    // The shared read populated the cache once.
    await rig.tick();
    expect(rig.counts().enumerations).toBe(1);
  });

  test("a joined listing that stops waiting leaves the shared enumeration running", async () => {
    const rig = inventory();
    const release = rig.holdEnumerate();
    const patient = rig.client.listSimulatorImages(undefined, { bypassCache: true });
    await drainUntil(() => rig.counts().enumerations > 0, { description: "first enumeration" });
    const impatient = rig.client.listSimulatorImages(100, { bypassCache: true });
    await drainMicrotasks(40);
    rig.timer.advanceTime(100);
    expect((await impatient)[0].displays).toBeUndefined();
    expect(rig.counts().enumerations).toBe(1);
    release();
    expect((await patient)[0].displays?.panels).toHaveLength(2);
    expect(rig.counts().enumerations).toBe(1);
  });

  test("a reboot during a pending enumeration starts its own read", async () => {
    const rig = inventory();
    const release = rig.holdEnumerate();
    const first = rig.client.listSimulatorImages(undefined, { bypassCache: true });
    await drainUntil(() => rig.counts().enumerations > 0, { description: "first enumeration" });
    rig.device.lastUsedAt = rig.devices.find(
      (device) => device.lastUsedAt !== rig.device.lastUsedAt && device.lastUsedAt,
    )!.lastUsedAt;
    const second = rig.client.listSimulatorImages(undefined, { bypassCache: true });
    await drainUntil(() => rig.counts().enumerations > 1, { description: "reboot enumeration" });
    release();
    await Promise.all([first, second]);
    expect(rig.counts().enumerations).toBe(2);
  });

  test("a shutdown during a pending enumeration retires the flight for the next boot", async () => {
    const rig = inventory();
    const release = rig.holdEnumerate();
    const first = rig.client.listSimulatorImages(undefined, { bypassCache: true });
    await drainUntil(() => rig.counts().enumerations > 0, { description: "first enumeration" });
    rig.device.state = "Shutdown";
    await rig.client.listSimulatorImages(undefined, { bypassCache: true });
    rig.device.state = "Booted";
    const next = rig.client.listSimulatorImages(undefined, { bypassCache: true });
    await drainUntil(() => rig.counts().enumerations > 1, { description: "next boot" });
    release();
    await Promise.all([first, next]);
    expect(rig.counts().enumerations).toBe(2);
  });

  test("a cancelled starter does not strand joined listings", async () => {
    const rig = inventory();
    const release = rig.holdEnumerate();
    const controller = new AbortController();
    const starter = rig.client
      .listSimulatorImages(undefined, { bypassCache: true, signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await drainUntil(() => rig.counts().enumerations > 0, { description: "first enumeration" });
    const joined = rig.client.listSimulatorImages(undefined, { bypassCache: true });
    await drainMicrotasks(40);
    controller.abort(new Error("starter cancelled"));
    release();
    expect(String(await starter)).toContain("starter cancelled");
    // Enrichment is optional: the joined listing still succeeds, and the next one retries.
    const joinedListing = await joined;
    expect(joinedListing).toHaveLength(1);
    expect(joinedListing[0].displays).toBeUndefined();
    const retried = await rig.tick();
    expect(retried[0].displays?.panels).toHaveLength(2);
    expect(rig.counts().enumerations).toBe(2);
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
