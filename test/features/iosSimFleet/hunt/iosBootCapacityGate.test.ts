import { describe, expect, test } from "bun:test";
import { IosSimCapacityGate } from "../../../../src/features/iosSimFleet/CapacityGate";
import { InMemoryBootDurationHistory } from "../../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../../src/features/iosSimFleet/FleetCostCollector";
import type {
  HostSnapshot,
  SimulatorInventoryEntry,
} from "../../../../src/features/iosSimFleet/types";
import type {
  FleetHostSource,
  FleetReadOptions,
} from "../../../../src/features/iosSimFleet/FleetHostSource";
import { BootedDeviceDiscoveryIncompleteError } from "../../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeTimer } from "../../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const A = "AAAAAAAA-0000-0000-0000-000000000001";
const B = "BBBBBBBB-0000-0000-0000-000000000002";
const ENV = { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "1" };

function sim(udid: string, state: string): SimulatorInventoryEntry {
  return { udid, name: udid, state, runtime: "iOS-18", isAvailable: true };
}

const SNAPSHOT = {
  takenAtMs: 0,
  resources: {
    totalMemoryBytes: 64 * GIB,
    cpuCount: 16,
    memoryPressure: "normal",
    loadAverage1m: null,
  },
  processes: [],
} as unknown as HostSnapshot;

class ScriptedSource implements FleetHostSource {
  readonly pending: Array<(entries: SimulatorInventoryEntry[]) => void> = [];
  immediate: SimulatorInventoryEntry[] | undefined;
  async readHostSnapshot(): Promise<HostSnapshot> {
    return SNAPSHOT;
  }
  readInventory(_options?: FleetReadOptions): Promise<SimulatorInventoryEntry[]> {
    if (this.immediate) {
      return Promise.resolve(this.immediate);
    }
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

function build(source: ScriptedSource) {
  const timer = new FakeTimer();
  const collector = new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer);
  return { gate: new IosSimCapacityGate(collector, timer, { env: ENV }), timer };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("hunt: iOS boot capacity gate", () => {
  // A listing taken before boot A's slot was visible, still in flight when A finishes booting
  // and releases its ledger entry, undercounts A: neither the ledger nor the stale listing
  // holds A's slot, so a second boot is admitted over a limit of 1.
  test("a sample started before a boot finished does not admit past the limit", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source);
    source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    expect(first.decision.outcome).toBe("allow");

    source.immediate = undefined; // second listing hangs open (simctl is slow)
    const second = gate.admitBoot(undefined, { bootUdid: B });
    await tick();
    expect(source.pending.length).toBe(1);

    // A finishes booting and releases; the in-flight listing still shows it Shutdown.
    first.releaseAdmission?.();
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

    expect((await second).decision.outcome).toBe("refuse");
  });

  // The boot's own target never needs a second slot (decide() excludes it from the listing
  // count), yet a ledger entry for the SAME udid is counted as another in-flight boot.
  test("a second admission for a udid already in flight does not count its own target twice", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source);
    source.immediate = [sim(A, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    expect(first.decision.outcome).toBe("allow");
    const again = await gate.admitBoot(undefined, { bootUdid: A });
    expect(again.decision.outcome).toBe("allow");
  });

  // Unknown count => retryable discovery_incomplete (owner contract). A listing that outlives the
  // 15 s sample bound (simctl's own bound is 60 s) surfaces as an untyped ActionableError, while
  // the Android gate's listing timeout is typed discovery_incomplete.
  test("a sample timeout is reported as discovery_incomplete", async () => {
    const source = new ScriptedSource();
    const { gate, timer } = build(source);
    const admission = gate.admitBoot(undefined, { bootUdid: A });
    admission.catch(() => {});
    await tick();
    timer.advanceTime(15_000);
    await expect(admission).rejects.toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
  });
});
