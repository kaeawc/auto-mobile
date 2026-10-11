import { describe, expect, test } from "bun:test";
import { IosSimCapacityGate } from "../../../../src/features/iosSimFleet/CapacityGate";
import { InMemoryBootDurationHistory } from "../../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../../src/features/iosSimFleet/FleetCostCollector";
import type {
  HostSnapshot,
  SimulatorInventoryEntry,
} from "../../../../src/features/iosSimFleet/types";
import type { FleetHostSource } from "../../../../src/features/iosSimFleet/FleetHostSource";
import { BootCapacityExhaustedError } from "../../../../src/models/BootCapacityExhaustedError";
import { FakeTimer } from "../../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const A = "AAAAAAAA-0000-0000-0000-000000000001";
const B = "BBBBBBBB-0000-0000-0000-000000000002";

function sim(udid: string, state: string): SimulatorInventoryEntry {
  return { udid, name: udid, state, runtime: "iOS-18", isAvailable: true };
}

const SNAPSHOT: HostSnapshot = {
  takenAtMs: 0,
  resources: {
    totalMemoryBytes: 64 * GIB,
    cpuCount: 16,
    memoryPressure: "normal",
    loadAverage1m: null,
  },
  processes: [],
};

class ScriptedSource implements FleetHostSource {
  readonly pending: Array<(entries: SimulatorInventoryEntry[]) => void> = [];
  immediate: SimulatorInventoryEntry[] | undefined;
  async readHostSnapshot(): Promise<HostSnapshot> {
    return SNAPSHOT;
  }
  readInventory(): Promise<SimulatorInventoryEntry[]> {
    if (this.immediate) {
      return Promise.resolve(this.immediate);
    }
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

function build(source: ScriptedSource): IosSimCapacityGate {
  const timer = new FakeTimer();
  const collector = new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer);
  return new IosSimCapacityGate(collector, timer, {
    env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "1" },
  });
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function outcome(check: Promise<void>): Promise<unknown> {
  return check.then(
    () => "capacity available",
    (error: unknown) => error,
  );
}

/**
 * `assertCapacityAvailable` is the check callers run BEFORE a side effect they would have to undo
 * (a managed-slot replacement deleting the slot's device, creating a simulator). The Android gate
 * takes it inside a ledger sample window; the iOS gate decides on a plain `collect()` with no
 * window, so a boot that finishes while the listing is open is in neither the ledger nor the
 * listing and the check passes at the limit.
 */
describe("hunt: iOS read-only capacity check against a listing older than a finished boot", () => {
  test("a boot that finishes while the check's own listing is open still holds its slot", async () => {
    const source = new ScriptedSource();
    const gate = build(source);
    source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    expect(first.decision.outcome).toBe("allow");

    source.immediate = undefined; // simctl is slow: the check's listing stays open
    const check = outcome(gate.assertCapacityAvailable());
    await tick();
    expect(source.pending.length).toBe(1);

    // A finishes booting and releases its admission; the open listing was read before that.
    first.releaseAdmission?.();
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

    // Limit 1 and A is booted: the check must refuse, as an admission in the same spot does.
    expect(await check).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("the check does not join a listing that started before the boot it must count finished", async () => {
    const source = new ScriptedSource();
    const gate = build(source);
    source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    source.immediate = undefined;
    const reading = gate.describeCapacity(); // another caller's listing, begun while A is Shutdown
    await tick();
    expect(source.pending.length).toBe(1);
    first.releaseAdmission?.(); // A is Booted now and holds its slot only in simctl

    // Called after A finished: a listing begun now would show A Booted.
    const check = outcome(gate.assertCapacityAvailable());
    await tick();
    for (const resolve of source.pending.slice(1)) {
      resolve([sim(A, "Booted"), sim(B, "Shutdown")]);
    }
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

    expect(await check).toBeInstanceOf(BootCapacityExhaustedError);
    await reading;
  });
});
