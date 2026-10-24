import { expect, test } from "bun:test";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import type { FleetCostSource } from "../../../src/features/iosSimFleet/FleetCostCollector";
import {
  estimatePerSimulatorBytes,
  resolveCapacityLimits,
} from "../../../src/features/iosSimFleet/capacityPolicy";
import type { FleetCostReport, SimulatorCost } from "../../../src/features/iosSimFleet/types";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;

test.each(["admitted", "external Booting"])(
  "a heavy %s simulator preserves its measured RSS through row-index matching",
  (kind) => {
    const { report } = setup([
      simulator("heavy", 6, kind === "external Booting" ? "Booting" : "Booted"),
      simulator("settled", 1.5),
    ]);
    const boots = kind === "admitted" ? [{ deviceId: "heavy", handedOff: false }] : [];
    const bytes = estimatePerSimulatorBytes(report, boots);
    expect(bytes).toBe(3.75 * GIB);
    expect(
      resolveCapacityLimits({}, { totalMemoryBytes: 16 * GIB, cpuCount: 8 }, bytes).maxBooted,
    ).toBe(2);
  },
);

function simulator(udid: string, gib?: number, state = "Booted"): SimulatorCost {
  return {
    udid,
    name: udid,
    runtime: "iOS-18",
    state,
    quality: gib === undefined ? "no-processes" : "measured",
    process:
      gib === undefined ? undefined : { rssBytes: gib * GIB, cpuPercent: 0, processCount: 1 },
  };
}

function setup(simulators: SimulatorCost[] = [simulator("settled", 3.5)]) {
  const report: FleetCostReport = {
    collectedAtMs: 0,
    host: {
      totalMemoryBytes: 16 * GIB,
      cpuCount: 8,
      loadAverage1m: null,
      memoryPressure: "normal",
    },
    simulators,
    totals: { bootedCount: 0, measuredCount: 0, rssBytes: 0, cpuPercent: 0, diskBytes: 0 },
    errors: [],
  };
  const source: FleetCostSource = {
    collect: async () => report,
    collectFresh: async () => report,
  };
  const gate = new IosSimCapacityGate(source, new FakeTimer(), {
    env: { AUTOMOBILE_IOS_SIM_BOOT_CONCURRENCY: "100" },
  });
  return { report, source, gate };
}

// #13862: listing a newly booted simulator must not turn a limit of two into three.
test("a 0.8 GiB boot beside a settled 3.5 GiB simulator keeps limit two through settlement", async () => {
  const { report, gate } = setup();
  expect((await gate.describeCapacity()).limit).toBe(2);
  const boot = await gate.admitBoot(undefined, { bootUdid: "new" });
  expect(boot.decision.outcome).toBe("allow");
  expect((await gate.describeCapacity()).limit).toBe(2);

  report.simulators.push(simulator("new", 0.8));
  expect(await gate.describeCapacity()).toMatchObject({ limit: 2, booted: 2, inFlight: 0 });
  expect((await gate.evaluateBoot()).outcome).toBe("refuse");
  expect((await gate.admitBoot(undefined, { bootUdid: "third" })).decision.outcome).toBe("refuse");
  await expect(gate.assertCapacityAvailable()).rejects.toBeInstanceOf(BootCapacityExhaustedError);

  report.simulators[1] = simulator("new", 3.5);
  boot.releaseAdmission?.();
  expect((await gate.describeCapacity()).limit).toBe(2);
});

test.each(["Booting", "Booted"])(
  "an admitted %s simulator is excluded by UDID, not RSS order",
  async (state) => {
    const { report, gate } = setup();
    const boot = await gate.admitBoot(undefined, { bootUdid: "new" });
    report.simulators.unshift(simulator("new", 0.8, state));
    expect((await gate.describeCapacity()).limit).toBe(2);
    boot.releaseAdmission?.();
  },
);

test("an external Booting simulator is protected without an admission", async () => {
  const { gate } = setup([simulator("settled", 3.5), simulator("external", 0.8, "Booting")]);
  expect((await gate.describeCapacity()).limit).toBe(2);
  await expect(gate.assertCapacityAvailable()).rejects.toBeInstanceOf(BootCapacityExhaustedError);
});

test("an unmeasured Booting simulator is charged at least the 3 GiB default", async () => {
  const { gate } = setup([simulator("settled", 1.5), simulator("external", undefined, "Booting")]);
  // (1.5 + 3) / 2 = 2.25 GiB, so floor(8 / 2.25) = 3, rather than floor(8 / 1.5) = 5.
  expect((await gate.describeCapacity()).limit).toBe(3);
});

test("a lone admitted simulator's small RSS keeps the default-derived limit", async () => {
  const { gate, report } = setup([]);
  const boot = await gate.admitBoot(undefined, { bootUdid: "new" });
  report.simulators.push(simulator("new", 0.8));
  expect((await gate.describeCapacity()).limit).toBe(2);
  boot.releaseAdmission?.();
  // Release defines settlement: no new grace timer changes the existing steady-fleet behavior.
  expect((await gate.describeCapacity()).limit).toBe(5);
});

test("a boot released during sampling stays excluded for that sample", async () => {
  const { report, source, gate } = setup();
  const boot = await gate.admitBoot(undefined, { bootUdid: "new" });
  report.simulators.push(simulator("new", 0.8));
  source.collectFresh = async () => {
    boot.releaseAdmission?.();
    return report;
  };
  expect((await gate.describeCapacity()).limit).toBe(2);
  expect((await gate.describeCapacity()).limit).toBe(3);
});

test("duplicate admissions for one UDID charge the boot only once", async () => {
  const { report, gate } = setup([simulator("settled", 1)]);
  const first = await gate.admitBoot(undefined, { bootUdid: "new" });
  const second = await gate.admitBoot(undefined, { bootUdid: "new" });
  report.simulators.push(simulator("new", 0.8, "Booting"));
  expect((await gate.describeCapacity()).limit).toBe(4);
  first.releaseAdmission?.();
  second.releaseAdmission?.();
});

test("a replacement reservation keeps the heavy settled simulator in sizing", async () => {
  const { gate } = setup([simulator("old", 5), simulator("other", 2)]);
  expect((await gate.describeCapacity()).limit).toBe(2);
  const reservation = await gate.reserveBoot({ replacingDeviceId: "old", timeoutMs: 1000 });
  try {
    expect(await gate.describeCapacity()).toMatchObject({ limit: 2, booted: 2, inFlight: 0 });
    expect((await gate.evaluateBoot()).outcome).toBe("refuse");
  } finally {
    reservation.release();
  }
});

test("an anonymous boot's process id cannot match a simulator RSS row index", () => {
  const { report } = setup([simulator("settled", 5), simulator("other", 2)]);
  expect(estimatePerSimulatorBytes(report, [{ processId: 0, handedOff: false }])).toBe(3.5 * GIB);
});

test("an admission without a UDID still charges the policy default", async () => {
  const { gate } = setup([simulator("settled", 1.5)]);
  const boot = await gate.admitBoot(undefined, {});
  expect((await gate.describeCapacity()).limit).toBe(3);
  boot.releaseAdmission?.();
});

test.each([
  { rss: [], expectedGiB: 3, limit: 2 },
  { rss: [0.8], expectedGiB: 1.5, limit: 5 },
  { rss: [2], expectedGiB: 2, limit: 4 },
  { rss: [3.5], expectedGiB: 3.5, limit: 2 },
  { rss: [2, 4], expectedGiB: 3, limit: 2 },
  { rss: [12], expectedGiB: 6, limit: 1 },
])(
  "no in-flight boots: $rss GiB retains the previous estimate and limit",
  async ({ rss, expectedGiB, limit }) => {
    const { gate, report } = setup(rss.map((gib, index) => simulator(`settled-${index}`, gib)));
    expect(estimatePerSimulatorBytes(report)).toBe(expectedGiB * GIB);
    expect(
      resolveCapacityLimits({}, { totalMemoryBytes: 16 * GIB, cpuCount: 8 }, expectedGiB * GIB)
        .maxBooted,
    ).toBe(limit);
    expect((await gate.describeCapacity()).limit).toBe(limit);
  },
);
