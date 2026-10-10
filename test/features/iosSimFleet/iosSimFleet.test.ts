import { describe, expect, test } from "bun:test";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeFleetHostSource } from "../../fakes/FakeFleetHostSource";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import {
  IosSimCapacityGate,
  assertCapacityGranted,
} from "../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetMonitor } from "../../../src/features/iosSimFleet/FleetMonitor";
import {
  CommandFleetHostSource,
  parseMemoryPressureLevel,
} from "../../../src/features/iosSimFleet/FleetHostSource";
import {
  IOS_SIM_MAX_BOOTED_ENV,
  estimatePerSimulatorBytes,
  isPressured,
  resolveCapacityLimits,
} from "../../../src/features/iosSimFleet/capacityPolicy";
import {
  attributeSimulatorProcesses,
  parsePsSnapshot,
} from "../../../src/features/iosSimFleet/psSnapshot";
import { parseSimctlInventory } from "../../../src/features/iosSimFleet/simctlInventory";
import { formatFleetReport } from "../../../src/features/iosSimFleet/fleetReport";
import type { HostResources, HostSnapshot } from "../../../src/features/iosSimFleet/types";

const FIXTURES = join(import.meta.dir, "../../fixtures/ios-sim-fleet");
const PS = readFileSync(join(FIXTURES, "ps-snapshot-two-booted-simulators.txt"), "utf8");
const SIMCTL = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-simctl/list-devices.json"),
  "utf8",
);
const IOS27 = "2300914A-231E-4874-8F8A-40C3D2F1E24B";
const IOS18 = "BCC31307-1A19-4D67-A7F0-44FC98F78921";
const DUO = "490BEBFF-5F82-43CF-B7BC-59AE24229520";
const GIB = 1024 ** 3;

const calm: HostResources = {
  totalMemoryBytes: 128 * GIB,
  cpuCount: 16,
  loadAverage1m: 2,
  memoryPressure: "normal",
};

function inventoryWithBooted(...booted: string[]) {
  return parseSimctlInventory(SIMCTL).map((entry) =>
    booted.includes(entry.udid) ? { ...entry, state: "Booted" } : entry,
  );
}

function snapshot(resources: HostResources = calm): HostSnapshot {
  return { takenAtMs: 0, resources, processes: parsePsSnapshot(PS).rows };
}

function setup(booted: string[], resources: HostResources = calm) {
  const source = new FakeFleetHostSource();
  source.inventory = inventoryWithBooted(...booted);
  source.snapshot = snapshot(resources);
  const timer = new FakeTimer();
  const history = new InMemoryBootDurationHistory();
  const collector = new IosSimFleetCostCollector(source, history, timer);
  return { source, timer, history, collector };
}

describe("ps parsing and attribution", () => {
  test("parses captured rows and converts KiB to bytes", () => {
    const { rows, skipped } = parsePsSnapshot(PS);
    expect(skipped).toBe(0);
    expect(rows[0]).toMatchObject({ pid: 1, ppid: 0, command: "/sbin/launchd" });
    expect(rows.find((row) => row.pid === 90001)?.rssBytes).toBe(410112 * 1024);
  });

  test("counts malformed rows instead of dropping them silently", () => {
    expect(parsePsSnapshot("garbage\n  12 1 100 0.5 /bin/x\n").skipped).toBe(1);
  });

  test("attributes each process tree to its own simulator in one pass", () => {
    const cost = attributeSimulatorProcesses(parsePsSnapshot(PS).rows, [IOS27, IOS18]);
    expect(cost.get(IOS27)).toEqual({
      processCount: 4,
      rssBytes: (410112 + 220480 + 903168 + 150000) * 1024,
      cpuPercent: 38.5 + 12 + 9.5 + 1.2,
    });
    expect(cost.get(IOS18)?.processCount).toBe(2);
  });

  test("a process claimed by two simulators is attributed to the shared process", () => {
    const rows = [
      { pid: 1, ppid: 0, rssBytes: 10, cpuPercent: 1, command: "/a/CoreSimulator/Devices/A/x" },
      { pid: 2, ppid: 1, rssBytes: 10, cpuPercent: 1, command: "/CoreSimulator/Devices/B/x" },
    ];
    const cost = attributeSimulatorProcesses(rows, ["A", "B"]);
    expect(cost.get("A")?.processCount).toBe(1);
    expect(cost.has("B")).toBe(false);
  });
});

describe("fleet cost collector", () => {
  test("reports per-simulator cost, disk, totals from one snapshot", async () => {
    const { source, collector } = setup([IOS27, IOS18]);
    const report = await collector.collect();
    expect(source.snapshotReads).toBe(1);
    const ios27 = report.simulators.find((sim) => sim.udid === IOS27);
    expect(ios27?.quality).toBe("measured");
    expect(ios27?.diskBytes).toBe(7380619264);
    expect(report.totals.bootedCount).toBe(2);
    expect(report.totals.measuredCount).toBe(2);
    expect(report.simulators.find((sim) => sim.udid === DUO)?.quality).toBe("not-running");
  });

  test("a booted simulator with no visible processes is not reported as zero", async () => {
    const { collector, source } = setup([DUO]);
    const report = await collector.collect();
    const duo = report.simulators.find((sim) => sim.udid === DUO);
    expect(duo?.quality).toBe("no-processes");
    expect(duo?.process).toBeUndefined();
    expect(report.totals.measuredCount).toBe(0);
    expect(source.snapshotReads).toBe(1);
  });

  test("snapshot failure marks booted simulators unavailable with the error", async () => {
    const { collector, source } = setup([IOS27]);
    source.snapshot = new Error("ps timed out");
    const report = await collector.collect();
    const ios27 = report.simulators.find((sim) => sim.udid === IOS27);
    expect(ios27).toMatchObject({ quality: "unavailable", error: "ps timed out" });
    expect(ios27?.diskBytes).toBe(7380619264);
    expect(report.errors[0]).toContain("ps timed out");
  });

  test("inventory failure yields an empty report that carries the error", async () => {
    const { collector, source } = setup([]);
    source.inventoryError = new Error("simctl missing");
    const report = await collector.collect();
    expect(report.simulators).toEqual([]);
    expect(report.errors[0]).toContain("simctl missing");
  });

  test("records and surfaces the last boot duration with its profile", async () => {
    const { collector, history, timer } = setup([IOS27]);
    history.record({
      udid: IOS27,
      profileId: "lean-v1",
      durationMs: 41_000,
      recordedAtMs: timer.now(),
    });
    history.record({
      udid: IOS27,
      profileId: "lean-v1",
      durationMs: -1,
      recordedAtMs: timer.now(),
    });
    const report = await collector.collect();
    expect(report.simulators.find((sim) => sim.udid === IOS27)?.lastBoot).toMatchObject({
      profileId: "lean-v1",
      durationMs: 41_000,
    });
    expect(history.recentForProfile("lean-v1")).toHaveLength(1);
  });

  test("concurrent collects share one in-flight read", async () => {
    const { collector, source } = setup([IOS27]);
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = collector.collect();
    const second = collector.collect();
    release();
    expect(await first).toBe(await second);
    expect(source.inventoryReads).toBe(1);
    await collector.collect();
    expect(source.inventoryReads).toBe(2);
  });

  test("formats a readable report", async () => {
    const { collector } = setup([IOS27]);
    const lines = formatFleetReport(await collector.collect());
    expect(lines[0]).toContain("iPhone 18 Pro");
    expect(lines[0]).toContain("GiB RSS");
    expect(lines.at(-1)).toContain("shutdown simulator(s)");
  });
});

describe("capacity policy", () => {
  test("derives the limit from the smaller of memory and cores", () => {
    expect(resolveCapacityLimits({}, { totalMemoryBytes: 128 * GIB, cpuCount: 16 })).toEqual({
      maxBooted: 8,
      source: "derived",
    });
    expect(resolveCapacityLimits({}, { totalMemoryBytes: 16 * GIB, cpuCount: 16 }).maxBooted).toBe(
      2,
    );
    expect(resolveCapacityLimits({}, { totalMemoryBytes: 2 * GIB, cpuCount: 2 }).maxBooted).toBe(1);
  });

  test("env override wins; an invalid override warns and falls back", () => {
    const resources = { totalMemoryBytes: 16 * GIB, cpuCount: 16 };
    expect(resolveCapacityLimits({ [IOS_SIM_MAX_BOOTED_ENV]: "5" }, resources)).toEqual({
      maxBooted: 5,
      source: "env",
    });
    const bad = resolveCapacityLimits({ [IOS_SIM_MAX_BOOTED_ENV]: "0" }, resources);
    expect(bad.source).toBe("derived");
    expect(bad.warning).toContain(IOS_SIM_MAX_BOOTED_ENV);
  });

  test("uses measured memory to budget per simulator, clamped", async () => {
    const { collector } = setup([IOS27]);
    const report = await collector.collect();
    expect(estimatePerSimulatorBytes(report)).toBe((410112 + 220480 + 903168 + 150000) * 1024);
    expect(estimatePerSimulatorBytes(undefined)).toBe(3 * GIB);
  });

  test("pressure thresholds", () => {
    expect(isPressured(calm)).toBe(false);
    expect(isPressured({ ...calm, memoryPressure: "warn" })).toBe(true);
    expect(isPressured({ ...calm, loadAverage1m: 24 })).toBe(true);
    expect(isPressured({ ...calm, memoryPressure: "unknown", loadAverage1m: null })).toBe(false);
    expect(isPressured(undefined)).toBe(false);
  });
});

describe("capacity gate", () => {
  const env = { [IOS_SIM_MAX_BOOTED_ENV]: "2" };

  test("allows a boot below the limit", async () => {
    const { collector, timer } = setup([IOS27]);
    const decision = await new IosSimCapacityGate(collector, timer, { env }).evaluateBoot();
    expect(decision).toMatchObject({ outcome: "allow", bootedCount: 1 });
  });

  test("refuses at capacity and reports why", async () => {
    const { collector, timer } = setup([IOS27, IOS18]);
    const decision = await new IosSimCapacityGate(collector, timer, { env }).evaluateBoot();
    expect(decision).toMatchObject({
      outcome: "refuse",
      reason: "at-capacity",
      retryAfterMs: 5000,
    });
  });

  test("prefers a compatible warm device over a new boot, even at capacity", async () => {
    const { collector, timer, history } = setup([IOS27, IOS18]);
    history.record({ udid: IOS18, profileId: "lean-v1", durationMs: 30_000, recordedAtMs: 0 });
    const gate = new IosSimCapacityGate(collector, timer, { env });
    expect(await gate.evaluateBoot({ profileId: "lean-v1" })).toEqual({
      outcome: "reuse-warm",
      udid: IOS18,
    });
    expect(
      await gate.evaluateBoot({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        excludeUdids: [IOS18],
      }),
    ).toMatchObject({ outcome: "refuse" });
  });

  // #11100: the boot path boots the requested UDID regardless, so a warm device
  // must not admit it past maxBooted.
  test("admitBoot still refuses at capacity when a compatible warm device exists", async () => {
    const { collector, timer, history } = setup([IOS27, IOS18]);
    history.record({ udid: IOS18, profileId: "lean-v1", durationMs: 30_000, recordedAtMs: 0 });
    const gate = new IosSimCapacityGate(collector, timer, { env });

    const result = await gate.admitBoot(
      { profileId: "lean-v1", excludeUdids: ["NEW-UDID"] },
      { bootUdid: "NEW-UDID" },
    );

    expect(result).toMatchObject({
      decision: { outcome: "refuse", reason: "at-capacity" },
    });
    expect(result.releaseAdmission).toBeUndefined();
  });

  test("admitBoot reports a warm device as a hint when a boot fits", async () => {
    const { collector, timer, history } = setup([IOS27]);
    history.record({ udid: IOS27, profileId: "lean-v1", durationMs: 30_000, recordedAtMs: 0 });
    const gate = new IosSimCapacityGate(collector, timer, { env });

    const result = await gate.admitBoot(
      { profileId: "lean-v1", excludeUdids: ["NEW-UDID"] },
      { bootUdid: "NEW-UDID" },
    );

    expect(result.decision).toEqual({ outcome: "reuse-warm", udid: IOS27 });
    expect(result.releaseAdmission).toBeDefined();
    result.releaseAdmission?.();
  });

  test("a pressured host under the count limit still admits, and reports the pressure (#11209)", async () => {
    const { collector, timer } = setup([IOS27], { ...calm, memoryPressure: "warn" });
    const gate = new IosSimCapacityGate(collector, timer, {
      env: { [IOS_SIM_MAX_BOOTED_ENV]: "4" },
    });
    for (let boots = 0; boots < 5; boots++) {
      const result = await gate.admitBoot(undefined, { bootUdid: `NEW-${boots}` });
      expect(result.decision.outcome).toBe("allow");
      result.releaseAdmission?.();
    }
    expect((await gate.evaluateBoot()).outcome).toBe("allow");
    expect(await gate.describeCapacity()).toMatchObject({
      hostPressure: { sustained: true, memoryPressure: "warn" },
    });
  });

  test("describeCapacity reads without advancing the pressure streak (#11209)", async () => {
    const { collector, timer } = setup([IOS27], { ...calm, memoryPressure: "warn" });
    const gate = new IosSimCapacityGate(collector, timer, {
      env: { [IOS_SIM_MAX_BOOTED_ENV]: "4" },
    });
    for (let reads = 0; reads < 5; reads++) {
      await gate.describeCapacity();
    }
    expect(await gate.describeCapacity()).toMatchObject({
      hostPressure: { sustained: false, consecutiveSamples: 0 },
    });
  });

  test("the first boot is never deferred by pressure", async () => {
    const { collector, timer } = setup([], { ...calm, memoryPressure: "critical" });
    const gate = new IosSimCapacityGate(collector, timer, { env, sustainedSamples: 1 });
    expect((await gate.evaluateBoot()).outcome).toBe("allow");
  });

  test("admitBoot refuses at once at the limit without sleeping, and assert throws the typed error", async () => {
    const { collector, timer } = setup([IOS27, IOS18]);
    const gate = new IosSimCapacityGate(collector, timer, { env });
    const startedAt = timer.now();
    const result = await gate.admitBoot(undefined, {});
    expect(timer.now()).toBe(startedAt);
    expect(result.decision.outcome).toBe("refuse");
    expect(result.releaseAdmission).toBeUndefined();
    let thrown: unknown;
    try {
      assertCapacityGranted(result);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BootCapacityExhaustedError);
    expect(thrown).toMatchObject({
      details: {
        code: "capacity_exhausted",
        retryable: true,
        retryAfterMs: 5_000,
        limit: 2,
        booted: 2,
        platform: "ios",
      },
    });
  });

  test("admitBoot honors cancellation", async () => {
    const { collector, timer } = setup([IOS27, IOS18]);
    const gate = new IosSimCapacityGate(collector, timer, { env });
    const controller = new AbortController();
    controller.abort();
    await expect(gate.admitBoot(undefined, { signal: controller.signal })).rejects.toThrow();
  });

  test("admitBoot bounds a stalled fleet sample", async () => {
    const { collector, timer, source } = setup([IOS27]);
    source.gate = new Promise<void>(() => {});
    const gate = new IosSimCapacityGate(collector, timer, { env });
    const wait = gate.admitBoot(undefined, {});
    timer.advanceTime(15_000);
    await expect(wait).rejects.toThrow("collecting iOS simulator capacity");
  });

  test("an admitted boot counts toward the limit until it is released", async () => {
    const { collector, timer } = setup([IOS27]);
    const gate = new IosSimCapacityGate(collector, timer, { env });
    // One free slot (1 booted, limit 2): two concurrent boots must not both be admitted.
    const [first, second] = await Promise.all([
      gate.admitBoot(undefined, { bootUdid: "NEW-A" }),
      gate.admitBoot(undefined, { bootUdid: "NEW-B" }),
    ]);
    expect([first.decision.outcome, second.decision.outcome].sort()).toEqual(["allow", "refuse"]);
    const admitted = first.decision.outcome === "allow" ? first : second;
    expect(admitted.releaseAdmission).toBeDefined();
    admitted.releaseAdmission?.();
    const third = await gate.admitBoot(undefined, { bootUdid: "NEW-C" });
    expect(third.decision.outcome).toBe("allow");
  });

  test("an admitted boot is not double-counted once the fleet shows it Booted", async () => {
    const { collector, timer, source } = setup([IOS27]);
    const gate = new IosSimCapacityGate(collector, timer, {
      env: { [IOS_SIM_MAX_BOOTED_ENV]: "3" },
    });
    const admitted = await gate.admitBoot(undefined, { bootUdid: IOS18 });
    expect(admitted.decision).toMatchObject({ outcome: "allow", bootedCount: 1 });
    source.inventory = inventoryWithBooted(IOS27, IOS18);
    expect(await gate.evaluateBoot()).toMatchObject({ outcome: "allow", bootedCount: 2 });
  });
});

describe("fleet monitor", () => {
  test("ticks never overlap while a sample is slow", async () => {
    const { collector, timer, source } = setup([IOS27]);
    const gate = new IosSimCapacityGate(collector, timer, { env: {} });
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const monitor = new IosSimFleetMonitor(gate, timer, 1000);
    monitor.start();
    timer.advanceTime(1000);
    timer.advanceTime(1000);
    timer.advanceTime(1000);
    expect(source.inventoryReads).toBe(1);
    release();
    await monitor.stop();
    expect(source.inventoryReads).toBe(1);
  });
});

describe("command-backed host source", () => {
  test("issues only read-only argv commands and reads resources", async () => {
    const executor = new FakeHostCommandExecutor();
    executor.setCommandResponse("ps -axo", { stdout: PS, stderr: "" } as never);
    executor.setCommandResponse("sysctl", { stdout: "2\n", stderr: "" } as never);
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["list", "devices", "--json"], SIMCTL);
    const source = new CommandFleetHostSource(
      executor,
      new FakeTimer(),
      {
        totalMemoryBytes: () => 64 * GIB,
        cpuCount: () => 10,
        loadAverage1m: () => null,
      },
      simctl,
    );
    const host = await source.readHostSnapshot();
    expect(host.resources).toEqual({
      totalMemoryBytes: 64 * GIB,
      cpuCount: 10,
      loadAverage1m: null,
      memoryPressure: "warn",
    });
    expect(await source.readInventory()).toHaveLength(21);
    expect(executor.getExecutedCommands().sort()).toEqual([
      "ps -axo pid=,ppid=,rss=,pcpu=,command=",
      "sysctl -n kern.memorystatus_vm_pressure_level",
    ]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: ["list", "devices", "--json"], timeoutMs: undefined },
    ]);
  });

  test("pressure levels map and unknown stays unknown", () => {
    expect(parseMemoryPressureLevel("1")).toBe("normal");
    expect(parseMemoryPressureLevel("4\n")).toBe("critical");
    expect(parseMemoryPressureLevel("")).toBe("unknown");
  });
});
