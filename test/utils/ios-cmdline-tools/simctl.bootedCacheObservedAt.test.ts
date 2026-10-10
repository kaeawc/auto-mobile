import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Simctl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { MonotonicDiscoveryObservationSequence } from "../../../src/utils/DiscoveryObservationSequence";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11103: a cache hit replays an earlier listing, so its entries must keep the
// stamp they were observed at rather than look newer than fresher evidence.

const payload = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      { udid: "SIM-1", name: "iPhone 17", state: "Booted", isAvailable: true },
    ],
  },
  runtimes: [],
  devicetypes: [],
  pairs: [],
});

describe("SimCtlClient.getBootedSimulatorsChecked observation stamps", () => {
  beforeEach(() => Simctl.invalidateDeviceListCache());
  afterEach(() => Simctl.invalidateDeviceListCache());

  test("a cache hit carries the stamp recorded with the listing", async () => {
    const timer = new FakeTimer();
    const sequence = new MonotonicDiscoveryObservationSequence();
    let listCalls = 0;
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
        listCalls++;
        return createExecResult(payload, "");
      }
      return createExecResult("", "");
    };
    const simctl = new Simctl(
      null,
      exec,
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sequence,
    );

    const [cold] = await simctl.getBootedSimulatorsChecked();
    // Unrelated evidence observed after the listing advances the sequence.
    const laterEvidence = sequence.next();
    timer.advanceTime(1_000);
    const [cached] = await simctl.getBootedSimulatorsChecked();

    expect(listCalls).toBe(1);
    expect(cached.observedAt).toBeDefined();
    expect(cached.observedAt!).toBeLessThan(laterEvidence);
    expect(cached.observedAt).toBe(cold.observedAt);
  });
});
