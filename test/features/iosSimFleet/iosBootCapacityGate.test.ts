import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { describe, expect, test } from "bun:test";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import type {
  HostSnapshot,
  SimulatorInventoryEntry,
} from "../../../src/features/iosSimFleet/types";
import type {
  FleetHostSource,
  FleetReadOptions,
} from "../../../src/features/iosSimFleet/FleetHostSource";
import { BootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const A = "AAAAAAAA-0000-0000-0000-000000000001";
const B = "BBBBBBBB-0000-0000-0000-000000000002";
const ENV = { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "1" };

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
  readInventory(_options?: FleetReadOptions): Promise<SimulatorInventoryEntry[]> {
    if (this.immediate) {
      return Promise.resolve(this.immediate);
    }
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

function build(source: ScriptedSource, env: NodeJS.ProcessEnv = ENV) {
  const timer = new FakeTimer();
  const collector = new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer);
  return { gate: new IosSimCapacityGate(collector, timer, { env }), timer };
}

/** Let queued promise continuations run; no timer involved. */
async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("iOS boot capacity gate", () => {
  test("holds a reset slot at the host limit across shutdown and rejects concurrent create", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
    source.immediate = [sim(A, "Booted"), sim(B, "Booted")];
    const held = await gate.reserveBoot({ replacingDeviceId: A, timeoutMs: 1000, reason: "reset" });
    expect((await gate.describeCapacity()).admissionsByReason).toEqual({
      reset: 1,
      create: 0,
      restart: 0,
    });
    const startCreate = Promise.withResolvers<void>();
    const concurrentCreate = startCreate.promise.then(() =>
      gate.admitBoot(undefined, { bootUdid: "new", reason: "create" }),
    );
    await held.run(async () => {
      source.immediate = [sim(A, "Shutdown"), sim(B, "Booted")];
      expect(await gate.describeCapacity()).toMatchObject({
        limit: 2,
        booted: 1,
        inFlight: 1,
        admissionsByReason: { reset: 1, create: 0, restart: 0 },
      });
      startCreate.resolve();
      expect((await concurrentCreate).decision.outcome).toBe("refuse");
      const reset = await gate.admitBoot(undefined, { bootUdid: A, reason: "reset" });
      expect(reset.releaseAdmission).toBeDefined();
      source.immediate = [sim(A, "Booted"), sim(B, "Booted")];
      reset.releaseAdmission?.();
    });
    held.release();
    expect(await gate.describeCapacity()).toMatchObject({
      booted: 2,
      inFlight: 0,
      admissionsByReason: { reset: 0, create: 0, restart: 0 },
    });
  });

  test("capacity distinguishes create and restart admissions", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
    source.immediate = [];
    const create = await gate.admitBoot(undefined, { bootUdid: A, reason: "create" });
    const restart = await gate.admitBoot(undefined, { bootUdid: B, reason: "restart" });
    expect((await gate.describeCapacity()).admissionsByReason).toEqual({
      reset: 0,
      create: 1,
      restart: 1,
    });
    create.releaseAdmission?.();
    restart.releaseAdmission?.();
  });
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

  // #11537: boot A is admitted AND released while B's listing is open. B's window opened with an
  // empty ledger, and its listing predates A's boot, so only the window can hold A's slot.
  test("a boot admitted and released inside another admission's listing still holds its slot", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source);
    const first = gate.admitBoot(undefined, { bootUdid: A });
    await tick();
    const second = gate.admitBoot(undefined, { bootUdid: B });
    await tick();
    expect(source.pending.length).toBe(2);

    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);
    const admitted = await first;
    expect(admitted.decision.outcome).toBe("allow");
    admitted.releaseAdmission?.(); // A finished booting: it now holds its slot only in simctl
    source.pending[1]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

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

  // A `simctl list` that started before the caller's own sample window opened can predate a boot
  // that was released in between: the gate's sample must start no earlier than its window.
  test("the admission sample does not join a listing that started before its window", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source);
    source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    source.immediate = undefined;
    const reading = gate.describeCapacity(); // a listing that starts while A is still Shutdown
    await tick();
    expect(source.pending.length).toBe(1);
    first.releaseAdmission?.(); // A finished booting: it now holds its slot only in simctl

    const second = gate.admitBoot(undefined, { bootUdid: B });
    await tick();
    expect(source.pending.length).toBe(2);
    source.pending[1]([sim(A, "Booted"), sim(B, "Shutdown")]);
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

    expect((await second).decision.outcome).toBe("refuse");
    await reading;
  });

  test("admissions whose windows opened together share one listing", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
    source.immediate = undefined;
    const one = gate.admitBoot(undefined, { bootUdid: A });
    const two = gate.admitBoot(undefined, { bootUdid: B });
    await tick();
    expect(source.pending.length).toBe(1);
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

    expect((await one).decision.outcome).toBe("allow");
    expect((await two).decision.outcome).toBe("allow");
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

test("replacement reserves one slot before deletion and binds without another fleet sample", async () => {
  const source = new ScriptedSource();
  const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
  source.immediate = [sim(A, "Booted"), sim(B, "Booted")];
  const reservation = await gate.reserveBoot({ replacingDeviceId: A, timeoutMs: 60_000 });
  expect(await gate.describeCapacity()).toMatchObject({ booted: 2, inFlight: 0 });
  source.immediate = [sim(B, "Booted")];
  reservation.markReplacedDeviceGone();
  expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 1 });
  expect((await gate.admitBoot(undefined, { bootUdid: "COMPETITOR" })).decision.outcome).toBe(
    "refuse",
  );
  const admitted = await reservation.run(async () => {
    await gate.assertCapacityAvailable();
    // No post-delete count: even failed discovery cannot take away the admitted slot.
    source.immediate = undefined;
    return await gate.admitBoot(undefined, { bootUdid: "NEW" });
  });
  expect(source.pending).toHaveLength(0);
  reservation.release();
  source.immediate = [sim(B, "Booted")];
  expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 1 });
  source.immediate.push(sim("NEW", "Booted"));
  expect(await gate.describeCapacity()).toMatchObject({ booted: 2, inFlight: 0 });
  admitted.releaseAdmission?.();
  admitted.releaseAdmission?.();
  await expect(reservation.run(async () => {})).rejects.toThrow("consumed");
});

test("unused iOS replacement reservations release idempotently", async () => {
  const source = new ScriptedSource();
  const { gate } = build(source);
  source.immediate = [sim(A, "Booted")];
  const held = await gate.reserveBoot({ replacingDeviceId: A, timeoutMs: 60_000 });
  source.immediate = [];
  held.release();
  held.release();
  expect(await gate.describeCapacity()).toMatchObject({ booted: 0, inFlight: 0 });
  const next = await gate.admitBoot(undefined, { bootUdid: B });
  expect(next.decision.outcome).toBe("allow");
  next.releaseAdmission?.();
});

test.each(["Booted", "Booting"])("replacement carries its %s slot above the cap", async (state) => {
  const source = new ScriptedSource();
  const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
  source.immediate = [sim(A, state), sim(B, "Booted"), sim("C", "Booted")];
  const held = await gate.reserveBoot({ replacingDeviceId: A, timeoutMs: 1000, reason: "reset" });
  source.immediate = [sim(A, "Shutdown"), sim(B, "Booted"), sim("C", "Booted")];
  expect(await gate.describeCapacity()).toMatchObject({ inFlight: 1 });
  expect((await gate.admitBoot(undefined, { bootUdid: "NEW" })).decision.outcome).toBe("refuse");
  held.release();
});

test("Shutdown replacement still refuses and names external simulators", async () => {
  const source = new ScriptedSource();
  const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
  source.immediate = [sim(A, "Shutdown"), sim(B, "Booted"), sim("C", "Booted")];
  const reservation = gate.reserveBoot({ replacingDeviceId: A, timeoutMs: 1000, reason: "reset" });
  await expect(reservation).rejects.toBeInstanceOf(BootCapacityExhaustedError);
  await expect(reservation).rejects.toMatchObject({ details: { externalDevices: [B, "C"] } });
});

test("reservation without replacement refuses at the cap", async () => {
  const source = new ScriptedSource();
  const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
  source.immediate = [sim(A, "Booted"), sim(B, "Booted")];
  await expect(gate.reserveBoot({ timeoutMs: 1000 })).rejects.toBeInstanceOf(
    BootCapacityExhaustedError,
  );
});

test("a non-reset replacement still refuses when other simulators fill the cap", async () => {
  const source = new ScriptedSource();
  const { gate } = build(source, { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" });
  source.immediate = [sim(A, "Booted"), sim(B, "Booted"), sim("C", "Booted")];
  await expect(gate.reserveBoot({ replacingDeviceId: A, timeoutMs: 1000 })).rejects.toBeInstanceOf(
    BootCapacityExhaustedError,
  );
});
