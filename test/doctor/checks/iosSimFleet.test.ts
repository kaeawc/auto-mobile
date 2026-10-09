import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkIosSimulatorFleetCost } from "../../../src/doctor/checks/iosSimFleet";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../../src/features/iosSimFleet/capacityPolicy";
import type { FleetCostSource } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import { parseSimctlInventory } from "../../../src/features/iosSimFleet/simctlInventory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { FakeFleetHostSource } from "../../fakes/FakeFleetHostSource";
import { FakeTimer } from "../../fakes/FakeTimer";

const FIXTURES = join(import.meta.dir, "../../fixtures/ios-sim-fleet");
const GIB = 1024 ** 3;

function fleet(booted: string[]): FleetCostSource {
  const source = new FakeFleetHostSource();
  source.inventory = parseSimctlInventory(
    readFileSync(join(FIXTURES, "simctl-list-devices.json"), "utf8"),
  ).map((entry) => (booted.includes(entry.udid) ? { ...entry, state: "Booted" } : entry));
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
    expect(result.value).toBe(1);
    expect(result.detail).toContain("RSS");
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

  test("a throwing source is a skip, not a crash", async () => {
    const result = await checkIosSimulatorFleetCost({
      platform: () => "darwin",
      createFleetSource: () => ({
        collect: async () => {
          throw new Error("boom");
        },
      }),
      env: () => ({}),
    });
    expect(result.status).toBe("skip");
    expect(result.message).toContain("boom");
  });
});
