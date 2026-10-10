import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import {
  CommandFleetHostSource,
  type HostOsInfo,
} from "../../../src/features/iosSimFleet/FleetHostSource";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../../src/features/iosSimFleet/capacityPolicy";
import { parseSimctlInventory } from "../../../src/features/iosSimFleet/simctlInventory";
import type { SimulatorInventoryEntry } from "../../../src/features/iosSimFleet/types";
import { logger } from "../../../src/utils/logger";
import { FakeFleetHostSource } from "../../fakes/FakeFleetHostSource";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const SIMCTL = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-simctl/list-devices.json"),
  "utf8",
);
const BOOTED_UDID = "2300914A-231E-4874-8F8A-40C3D2F1E24B";

function oneBooted(): SimulatorInventoryEntry[] {
  return parseSimctlInventory(SIMCTL).map((entry) =>
    entry.udid === BOOTED_UDID ? { ...entry, state: "Booted" } : entry,
  );
}

function gateWithFailingPs(os: HostOsInfo): IosSimCapacityGate {
  const commandSource = new CommandFleetHostSource(
    new FakeHostCommandExecutor(), // empty ps output => the process read fails
    new FakeTimer(),
    os,
    new FakeSimCtlClient(),
  );
  const timer = new FakeTimer();
  return new IosSimCapacityGate(
    new IosSimFleetCostCollector(
      {
        readHostSnapshot: (o) => commandSource.readHostSnapshot(o),
        readInventory: async () => oneBooted(),
      },
      new InMemoryBootDurationHistory(),
      timer,
    ),
    timer,
    { env: {} },
  );
}

describe("iOS capacity limit when host snapshot reads fail (#11389)", () => {
  test("describeCapacity reports the derived limit when only ps fails", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const gate = gateWithFailingPs({
        totalMemoryBytes: () => 128 * GIB,
        cpuCount: () => 16,
        loadAverage1m: () => null,
      });
      expect((await gate.describeCapacity()).limit).toBe(8);
    } finally {
      warn.mockRestore();
    }
  });

  test("unreadable os totals keep the conservative limit 1 and warn once", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const gate = gateWithFailingPs({
        totalMemoryBytes: () => {
          throw new Error("os unavailable");
        },
        cpuCount: () => 16,
        loadAverage1m: () => null,
      });
      expect((await gate.describeCapacity()).limit).toBe(1);
      await gate.describeCapacity();
      const unreadable = warn.mock.calls.filter((c) => String(c[0]).includes("unreadable"));
      expect(unreadable.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("an unusable override warns once, not on every evaluation", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fleet = new FakeFleetHostSource();
      fleet.inventory = oneBooted();
      fleet.snapshot = {
        takenAtMs: 0,
        resources: {
          totalMemoryBytes: 64 * GIB,
          cpuCount: 16,
          loadAverage1m: 1,
          memoryPressure: "normal",
        },
        processes: [],
      };
      const timer = new FakeTimer();
      const gate = new IosSimCapacityGate(
        new IosSimFleetCostCollector(fleet, new InMemoryBootDurationHistory(), timer),
        timer,
        { env: { [IOS_SIM_MAX_BOOTED_ENV]: "0" } },
      );
      await gate.describeCapacity();
      await gate.describeCapacity();
      expect(warn.mock.calls.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
