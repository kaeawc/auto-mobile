import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
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
    const simctl = new Simctl(null, exec, { timer, observationSequence: sequence });

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

describe("monitor simulator snapshot age and logging", () => {
  beforeEach(() => Simctl.invalidateDeviceListCache());
  afterEach(() => Simctl.invalidateDeviceListCache());

  function rig() {
    const timer = new FakeTimer();
    let lists = 0;
    const listing: {
      devices: Record<
        string,
        { udid: string; name: string; state: string; isAvailable: boolean }[]
      >;
    } = JSON.parse(payload);
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      if (file !== "xcrun" || args.join(" ") !== "simctl list devices --json") {
        throw new Error(`Unexpected fake command: ${file} ${args.join(" ")}`);
      }
      lists++;
      return createExecResult(JSON.stringify(listing), "");
    };
    return { timer, listing, calls: () => lists, client: new Simctl(null, exec, { timer }) };
  }

  test("a fresh bypass snapshot is shared with a monitor for fifteen seconds", async () => {
    const h = rig();
    await h.client.listSimulatorImages(undefined, { bypassCache: true });
    const monitor = new Simctl(
      null,
      async () => {
        throw new Error("Monitor should reuse the shared snapshot");
      },
      { timer: h.timer },
    );
    h.timer.advanceTime(12_000);
    await monitor.getSimulatorListingChecked(undefined, undefined, { maxCacheAgeMs: 15_000 });
    expect(h.calls()).toBe(1);
    h.timer.advanceTime(4_000);
    await h.client.getSimulatorListingChecked(undefined, undefined, { maxCacheAgeMs: 15_000 });
    expect(h.calls()).toBe(2);
  });

  test("default TTL stays five seconds and bypass wins over a longer max age", async () => {
    const h = rig();
    await h.client.getBootedSimulatorsChecked();
    h.timer.advanceTime(6_000);
    await h.client.getBootedSimulatorsChecked();
    expect(h.calls()).toBe(2);
    await h.client.getBootedSimulatorsChecked(undefined, undefined, {
      bypassCache: true,
      maxCacheAgeMs: 15_000,
    });
    expect(h.calls()).toBe(3);
  });

  test("an aborted mapping does not suppress the next listing's device lines", async () => {
    const controller = new AbortController();
    let abortMapping = true;
    const client = new Simctl(
      null,
      async () =>
        createExecResult(
          payload.replace(
            '"isAvailable":true',
            '"isAvailable":true,"deviceTypeIdentifier":"fake-type"',
          ),
          "",
        ),
      {
        timer: new FakeTimer(),
        deviceTypeProfiles: {
          profileFor: async () => {
            if (abortMapping) {
              controller.abort(new Error("aborted mapping"));
              controller.signal.throwIfAborted();
            }
            return null;
          },
        },
      },
    );
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await expect(
        client.getSimulatorListingChecked(undefined, controller.signal, {
          bypassCache: true,
        }),
      ).rejects.toThrow("aborted mapping");
      debug.mockClear();
      abortMapping = false;
      await client.getSimulatorListingChecked(undefined, undefined, { bypassCache: true });
      expect(
        debug.mock.calls.filter(([message]) => String(message).startsWith("Found iOS simulator:")),
      ).toHaveLength(1);
    } finally {
      debug.mockRestore();
    }
  });

  test("only changed simulator identities, states, names or availability repeat per-device debug lines", async () => {
    const h = rig();
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const read = () =>
      h.client.getSimulatorListingChecked(undefined, undefined, { bypassCache: true });
    const deviceLines = () =>
      debug.mock.calls.filter(([message]) => String(message).startsWith("Found iOS simulator:"));
    try {
      await read();
      expect(deviceLines()).toHaveLength(1);
      debug.mockClear();
      await read();
      expect(deviceLines()).toHaveLength(0);
      expect(
        debug.mock.calls.filter(
          ([message]) => message === "iOS simulator listing unchanged (1 simulators)",
        ),
      ).toHaveLength(1);
      h.listing.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-4"]![0]!.state = "Shutdown";
      await read();
      expect(deviceLines()).toHaveLength(1);
      const device = h.listing.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-4"]![0]!;
      for (const change of [
        () => {
          device.name = "Renamed";
        },
        () => {
          device.isAvailable = false;
        },
      ]) {
        debug.mockClear();
        change();
        await read();
        expect(deviceLines()).toHaveLength(1);
      }
      Simctl.invalidateDeviceListCache();
      debug.mockClear();
      await read();
      expect(deviceLines()).toHaveLength(1);
    } finally {
      debug.mockRestore();
    }
  });
});
