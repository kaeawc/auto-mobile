import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import {
  CommandFleetHostSource,
  type FleetHostSource,
} from "../../../src/features/iosSimFleet/FleetHostSource";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../../src/features/iosSimFleet/capacityPolicy";
import { parseSimctlInventory } from "../../../src/features/iosSimFleet/simctlInventory";
import type { SimulatorInventoryEntry } from "../../../src/features/iosSimFleet/types";
import { logger } from "../../../src/utils/logger";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
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

describe("boot capacity gate parity", () => {
  // The Android source reads RAM/cores from `os`, so a failed `ps` leaves the derived limit intact.
  // The iOS host snapshot is one Promise.all over `ps` + os totals: a failed `ps` throws away the
  // os totals too, `report.host` is undefined and the gate falls back to a limit of 1.
  test("a failed ps snapshot does not collapse the iOS derived limit to 1 on a big host", async () => {
    const psFailsExecutor = new FakeHostCommandExecutor(); // empty ps output => unparseable
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["list", "devices", "--json"], SIMCTL);
    const commandSource = new CommandFleetHostSource(
      psFailsExecutor,
      new FakeTimer(),
      { totalMemoryBytes: () => 128 * GIB, cpuCount: () => 16, loadAverage1m: () => null },
      simctl,
    );
    const source: FleetHostSource = {
      readHostSnapshot: (options) => commandSource.readHostSnapshot(options),
      readInventory: async () => oneBooted(),
    };
    const timer = new FakeTimer();
    const collector = new IosSimFleetCostCollector(
      source,
      new InMemoryBootDurationHistory(),
      timer,
    );
    const gate = new IosSimCapacityGate(collector, timer, { env: {} });

    // 128 GiB / 16 cores => derived limit 8; one simulator is booted, so a second boot fits.
    const admission = await gate.admitBoot(undefined, {});

    expect(admission.decision.outcome).toBe("allow");
  });

  // The Android gate logs an unusable AUTOMOBILE_ANDROID_MAX_BOOTED; the iOS gate never does.
  test("an unusable AUTOMOBILE_IOS_SIM_MAX_BOOTED is warned about, as on Android", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const android = new AndroidBootAdmissionGate(
        new FakeAndroidCapacitySource(),
        new FakeTimer(),
        {
          env: { [ANDROID_MAX_BOOTED_ENV]: "lots" },
        },
      );
      await android.describeCapacity();
      expect(warn.mock.calls.length).toBeGreaterThan(0);
      warn.mockClear();

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
      const ios = new IosSimCapacityGate(
        new IosSimFleetCostCollector(fleet, new InMemoryBootDurationHistory(), timer),
        timer,
        { env: { [IOS_SIM_MAX_BOOTED_ENV]: "lots" } },
      );
      await ios.describeCapacity();

      expect(warn.mock.calls.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});
