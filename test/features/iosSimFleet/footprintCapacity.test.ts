import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attributeSimulatorProcesses,
  parsePsSnapshot,
} from "../../../src/devices/bootAdmission/psSnapshot";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { CommandFleetHostSource } from "../../../src/features/iosSimFleet/FleetHostSource";
import {
  estimatePerSimulatorBytes,
  resolveCapacityLimits,
} from "../../../src/features/iosSimFleet/capacityPolicy";
import {
  parseTopFootprints,
  withFootprints,
} from "../../../src/features/iosSimFleet/footprintSnapshot";
import { formatFleetReport } from "../../../src/features/iosSimFleet/fleetReport";
import type {
  FleetCostReport,
  SimulatorCost,
  SimulatorInventoryEntry,
} from "../../../src/features/iosSimFleet/types";
import { logger } from "../../../src/utils/logger";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";

// #15288: the memory term summed per-process RSS, which counts the shared dyld cache and
// frameworks once per process, then clamped it at 6 GiB: 10 simulators on any large host.

const FIXTURES = join(import.meta.dir, "../../fixtures/ios-sim-fleet");
// One real booted simulator tree (266 processes) captured as `ps` and `top` on the same host.
const PS = readFileSync(join(FIXTURES, "ps-captured-one-booted-simulator.txt"), "utf8");
const TOP = readFileSync(join(FIXTURES, "top-captured-one-booted-simulator.txt"), "utf8");
const BOOTED_UDID = "18A2D9B1-CDFA-445A-93AA-A532EA4B5498";
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const host128 = { totalMemoryBytes: 128 * GIB, cpuCount: 16 };

describe("top footprint parsing", () => {
  test("parses the captured table, skipping the summary header", () => {
    const { footprints, skipped } = parseTopFootprints(TOP);
    expect(skipped).toBe(0);
    expect(footprints.size).toBe(parsePsSnapshot(PS).rows.length);
    expect(footprints.get(1)).toBe(27 * MIB);
    expect(footprints.get(183)).toBe(6882 * 1024);
  });

  test("handles units, change markers and comma decimals, and counts malformed rows", () => {
    const { footprints, skipped } = parseTopFootprints(
      "Processes: 3 total\nPID    MEM\n10     1G\n11     512M+\n12     8,5M-\n13     12\nbogus row\n",
    );
    expect([...footprints]).toEqual([
      [10, GIB],
      [11, 512 * MIB],
      [12, Math.round(8.5 * MIB)],
      [13, 12],
    ]);
    expect(skipped).toBe(1);
  });

  test("output without a PID/MEM header yields nothing instead of misreading the summary", () => {
    expect(
      parseTopFootprints("Processes: 3 total\nLoad Avg: 1, 2, 3\n10 20\n").footprints.size,
    ).toBe(0);
  });
});

describe("whole-tree footprint attribution", () => {
  const rows = withFootprints(parsePsSnapshot(PS).rows, parseTopFootprints(TOP).footprints);

  test("a real tree's footprint is a small fraction of its summed RSS", () => {
    const cost = attributeSimulatorProcesses(rows, [BOOTED_UDID]).get(BOOTED_UDID);
    expect(cost?.processCount).toBe(266);
    expect(cost?.rssBytes).toBeGreaterThan(20 * GIB);
    expect(cost?.footprintBytes).toBeGreaterThan(1.5 * GIB);
    expect(cost?.footprintBytes).toBeLessThan(6 * GIB);
    expect((cost?.rssBytes ?? 0) / (cost?.footprintBytes ?? 1)).toBeGreaterThan(5);
  });

  test("rows without a footprint leave the tree footprint absent, not zero", () => {
    const cost = attributeSimulatorProcesses(parsePsSnapshot(PS).rows, [BOOTED_UDID]).get(
      BOOTED_UDID,
    );
    expect(cost?.rssBytes).toBeGreaterThan(20 * GIB);
    expect(cost).not.toHaveProperty("footprintBytes");
  });

  test("a process top did not list contributes nothing instead of failing the tree", () => {
    const full = parseTopFootprints(TOP).footprints;
    const partial = new Map(full);
    const [dropped] = [...partial.keys()].filter((pid) => pid !== 1);
    partial.delete(dropped);
    const sample = withFootprints(parsePsSnapshot(PS).rows, partial);
    expect(sample.filter((row) => row.footprintBytes === undefined)).toHaveLength(1);
    const total = attributeSimulatorProcesses(sample, [BOOTED_UDID]).get(BOOTED_UDID);
    const whole = attributeSimulatorProcesses(rows, [BOOTED_UDID]).get(BOOTED_UDID);
    expect(total?.footprintBytes).toBe((whole?.footprintBytes ?? 0) - (full.get(dropped) ?? 0));
  });
});

function sources(options: { topError?: Error } = {}) {
  const executor = new FakeHostCommandExecutor();
  executor.setCommandResponse("ps -axo", { stdout: PS, stderr: "" } as never);
  executor.setCommandResponse("sysctl", { stdout: "1\n", stderr: "" } as never);
  if (options.topError) {
    executor.setCommandError("top", options.topError);
  } else {
    executor.setCommandResponse("top -l 1", { stdout: TOP, stderr: "" } as never);
  }
  const inventory: SimulatorInventoryEntry[] = [
    {
      udid: BOOTED_UDID,
      name: "AutoMobile CI iPhone",
      state: "Booted",
      runtime: "iOS-27-0",
      isAvailable: true,
    },
  ];
  const source = new CommandFleetHostSource(
    executor,
    new FakeTimer(),
    { totalMemoryBytes: () => 128 * GIB, cpuCount: () => 16, loadAverage1m: () => 1 },
    { simctl: new FakeSimctl() },
  );
  const collector = new IosSimFleetCostCollector(
    { readHostSnapshot: (o) => source.readHostSnapshot(o), readInventory: async () => inventory },
    new InMemoryBootDurationHistory(),
    new FakeTimer(),
  );
  return { executor, collector };
}

describe("collector and capacity from captured ps + top", () => {
  test("measures footprint, reports it, and sizes the simulator by it", async () => {
    const { collector } = sources();
    const report = await collector.collect();
    const sim = report.simulators[0];
    expect(sim.quality).toBe("measured");
    expect(sim.process?.footprintBytes).toBeGreaterThan(1.5 * GIB);
    expect(report.totals.footprintBytes).toBe(sim.process?.footprintBytes);
    expect(report.errors).toEqual([]);
    expect(formatFleetReport(report)[0]).toContain("footprint");
    expect(estimatePerSimulatorBytes(report)).toBe(sim.process?.footprintBytes ?? NaN);
  });

  test("a failed top read keeps ps data, surfaces the error and sizes by the default", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { collector } = sources({ topError: new Error("top timed out") });
      const report = await collector.collect();
      expect(report.simulators[0].quality).toBe("measured");
      expect(report.simulators[0].process?.footprintBytes).toBeUndefined();
      expect(report.simulators[0].process?.rssBytes).toBeGreaterThan(20 * GIB);
      expect(report.errors).toEqual(["memory footprint: top timed out"]);
      expect(estimatePerSimulatorBytes(report)).toBe(2.5 * GIB);
      expect(formatFleetReport(report)[0]).toContain("memory unmeasured");
    } finally {
      warn.mockRestore();
    }
  });
});

// Round 6 (#15288): 32 simulators ran healthy at 75.8 GiB total footprint (normal pressure, no
// swap) while each tree's summed RSS read 26.9 GiB. Footprint per simulator: 2117 MiB at 8-16
// simulators, 2436 MiB median at 32.
function fleet(count: number, footprintMiB: number): FleetCostReport {
  const simulators: SimulatorCost[] = Array.from({ length: count }, (_, index) => ({
    udid: `sim-${index}`,
    name: `r6-scale-${index}`,
    state: "Booted",
    runtime: "iOS-27-0",
    quality: "measured",
    process: {
      processCount: 223,
      rssBytes: 26.93 * GIB,
      footprintBytes: footprintMiB * MIB,
      cpuPercent: 0,
    },
  }));
  return {
    collectedAtMs: 0,
    host: { ...host128, loadAverage1m: 8, memoryPressure: "normal" },
    simulators,
    totals: {
      bootedCount: count,
      measuredCount: count,
      rssBytes: 0,
      cpuPercent: 0,
      diskBytes: 0,
    },
    errors: [],
  };
}

describe("round 6 scale numbers on a 128 GB / 16 core host", () => {
  test.each([
    { count: 9, footprintMiB: 2117, limit: 37 },
    { count: 32, footprintMiB: 2436, limit: 32 },
  ])("$count simulators at $footprintMiB MiB derive $limit", ({ count, footprintMiB, limit }) => {
    const bytes = estimatePerSimulatorBytes(fleet(count, footprintMiB));
    expect(bytes).toBe(footprintMiB * MIB);
    expect(resolveCapacityLimits({}, host128, bytes).maxBooted).toBe(limit);
  });

  test("the limit scales with host RAM instead of pinning near 10", () => {
    const bytes = estimatePerSimulatorBytes(fleet(8, 2436));
    const limitFor = (gib: number) =>
      resolveCapacityLimits({}, { totalMemoryBytes: gib * GIB, cpuCount: 64 }, bytes).maxBooted;
    expect([limitFor(64), limitFor(128), limitFor(256)]).toEqual([16, 32, 64]);
  });

  test("a measured average above the sanity bound is still clamped", () => {
    expect(estimatePerSimulatorBytes(fleet(2, 9 * 1024))).toBe(6 * GIB);
  });

  test("CPU is no longer the binding term at 32 simulators on 16 cores", () => {
    const limits = resolveCapacityLimits({}, host128, 2436 * MIB);
    expect(limits.maxBooted).toBe(32);
    expect(Math.floor((16 * 0.5) / 0.1)).toBeGreaterThan(limits.maxBooted);
  });
});
