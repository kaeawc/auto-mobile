import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Simctl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11573: the captured `simctl list devices --json` already carries each simulator's `state`.
// Booted discovery keeps only `Booted`; the listing read also reports the transitional ones so a
// held simulator mid-boot or mid-shutdown stays visible. The capture is all-Shutdown, so (as the
// fleet tests do) the test flips `state` on captured entries.

interface CapturedList {
  devices: Record<string, Array<Record<string, unknown>>>;
}

function listingWithStates(states: string[]): { payload: string; udids: string[] } {
  const captured = JSON.parse(
    readFileSync(join(import.meta.dir, "../../fixtures/ios-simctl/list-devices.json"), "utf8"),
  ) as CapturedList;
  const entries = Object.values(captured.devices)
    .flat()
    .filter((device) => device.isAvailable !== false);
  const flipped = states.map((state, index) => ({ ...entries[index], state }));
  return {
    payload: JSON.stringify({
      ...captured,
      devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-6": flipped },
    }),
    udids: flipped.map((device) => String(device.udid)),
  };
}

function simctlFor(payload: string): Simctl {
  const exec = async (file: string, args: string[]): Promise<ExecResult> =>
    file === "xcrun" && args.join(" ") === "simctl list devices --json"
      ? createExecResult(payload, "")
      : createExecResult("", "");
  return new Simctl(null, exec, new FakeTimer());
}

describe("SimCtlClient.getSimulatorListingChecked", () => {
  beforeEach(() => Simctl.invalidateDeviceListCache());
  afterEach(() => Simctl.invalidateDeviceListCache());

  test("splits Booted from Booting and Shutting Down, and leaves Shutdown out", async () => {
    const { payload, udids } = listingWithStates([
      "Booted",
      "Booting",
      "Shutting Down",
      "Shutdown",
    ]);

    const listing = await simctlFor(payload).getSimulatorListingChecked();

    expect(listing.booted.map((device) => device.deviceId)).toEqual([udids[0]]);
    expect(
      Object.fromEntries(listing.transitional.map(({ device, state }) => [device.deviceId, state])),
    ).toEqual({ [udids[1]]: "Booting", [udids[2]]: "Shutting Down" });
  });

  test("getBootedSimulatorsChecked still returns only the booted simulators", async () => {
    const { payload, udids } = listingWithStates(["Booted", "Booting", "Shutting Down"]);

    const booted = await simctlFor(payload).getBootedSimulatorsChecked();

    expect(booted.map((device) => device.deviceId)).toEqual([udids[0]]);
  });
});
