import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatConsoleOutput } from "../../../src/doctor/formatter";
import { checkIosSimulatorFleetCost } from "../../../src/doctor/checks/iosSimFleet";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../../src/features/iosSimFleet/capacityPolicy";
import type { FleetCostSource } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { parsePsSnapshot } from "../../../src/devices/bootAdmission/psSnapshot";
import { parseSimctlInventory } from "../../../src/features/iosSimFleet/simctlInventory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { FakeFleetHostSource } from "../../fakes/FakeFleetHostSource";
import { FakeTimer } from "../../fakes/FakeTimer";

const FIXTURES = join(import.meta.dir, "../../fixtures/ios-sim-fleet");
const GIB = 1024 ** 3;

function fleet(booted: string[], booting: string[] = []): FleetCostSource {
  const source = new FakeFleetHostSource();
  source.inventory = parseSimctlInventory(
    readFileSync(join(FIXTURES, "../ios-simctl/list-devices.json"), "utf8"),
  ).map((entry) => {
    if (booted.includes(entry.udid)) {
      return { ...entry, state: "Booted" };
    }
    return booting.includes(entry.udid) ? { ...entry, state: "Booting" } : entry;
  });
  source.snapshot = {
    takenAtMs: 0,
    resources: {
      totalMemoryBytes: 128 * GIB,
      cpuCount: 16,
      loadAverage1m: 1,
      memoryPressure: "normal",
    },
    processes: parsePsSnapshot(
      readFileSync(join(FIXTURES, "ps-snapshot-two-booted-simulators.txt"), "utf8"),
    ).rows,
  };
  return new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), new FakeTimer());
}

const IOS27 = "2300914A-231E-4874-8F8A-40C3D2F1E24B";
const IOS18 = "BCC31307-1A19-4D67-A7F0-44FC98F78921";

describe("checkIosSimulatorFleetCost", () => {
  test("skips off macOS", async () => {
    const result = await checkIosSimulatorFleetCost({
      platform: () => "linux",
      createFleetSource: () => fleet([]),
      env: () => ({}),
    });
    expect(result.status).toBe("skip");
  });

  test("passes within capacity and lists measured cost", async () => {
    const result = await checkIosSimulatorFleetCost({
      platform: () => "darwin",
      createFleetSource: () => fleet([IOS27]),
      env: () => ({}),
    });
    expect(result.status).toBe("pass");
    // The console formatter prints `value` in place of the message: it must carry the limit.
    expect(result.value).toContain("1/");
    expect(result.value).toContain("booted simulators (limit derived)");
    // The synthetic ps fixture carries no footprint: cost shows as unmeasured, never as RSS.
    expect(result.detail).toContain("memory unmeasured");
    expect(result.detail).not.toContain("RSS");
  });

  test("warns when a new boot would exceed capacity", async () => {
    const result = await checkIosSimulatorFleetCost({
      platform: () => "darwin",
      createFleetSource: () => fleet([IOS27, IOS18]),
      env: () => ({ [IOS_SIM_MAX_BOOTED_ENV]: "2" }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("exceed capacity");
    expect(result.recommendation).toContain(IOS_SIM_MAX_BOOTED_ENV);
  });

  test("counts a Booting simulator toward the limit like the gate does", async () => {
    const result = await checkIosSimulatorFleetCost({
      platform: () => "darwin",
      createFleetSource: () => fleet([IOS27], [IOS18]),
      env: () => ({ [IOS_SIM_MAX_BOOTED_ENV]: "2" }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("2/2 booted simulators");
    expect(result.message).toContain("exceed capacity");
  });

  test("a throwing source is a skip, not a crash", async () => {
    const result = await checkIosSimulatorFleetCost({
      platform: () => "darwin",
      createFleetSource: () => ({
        collectFresh: async () => {
          throw new Error("boom");
        },
        collect: async () => {
          throw new Error("boom");
        },
      }),
      env: () => ({}),
    });
    expect(result.status).toBe("skip");
    expect(result.message).toContain("boom");
  });

  test("text output shows the derived limit, not a bare count (#15310)", async () => {
    const check = await checkIosSimulatorFleetCost({
      platform: () => "darwin",
      createFleetSource: () => fleet([IOS27]),
      env: () => ({}),
    });
    const output = formatConsoleOutput(
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        version: "0.0.0",
        platform: "darwin",
        arch: "arm64",
        system: { checks: [] },
        ios: { checks: [check] },
        autoMobile: { checks: [] },
        summary: { total: 1, passed: 1, warnings: 0, failed: 0, skipped: 0 },
        recommendations: [],
      },
      false,
    );

    expect(output).toMatch(
      /\[PASS\] iOS Simulator Fleet Cost: 1\/\d+ booted simulators \(limit derived\)/,
    );
  });
});
