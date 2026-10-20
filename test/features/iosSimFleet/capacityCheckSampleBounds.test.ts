import { describe, expect, test } from "bun:test";
import {
  BootAdmissionLedger,
  DEFAULT_SAMPLE_TIMEOUT_MS,
} from "../../../src/features/bootAdmission/BootAdmissionGate";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import type {
  FleetHostSource,
  FleetReadOptions,
} from "../../../src/features/iosSimFleet/FleetHostSource";
import type {
  HostSnapshot,
  SimulatorInventoryEntry,
} from "../../../src/features/iosSimFleet/types";
import { FakeTimer } from "../../fakes/FakeTimer";

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

/** `simctl list` answers at once (`immediate`) or stays open until the test resolves it. */
class ScriptedSource implements FleetHostSource {
  readonly pending: Array<(entries: SimulatorInventoryEntry[]) => void> = [];
  immediate: SimulatorInventoryEntry[] | undefined;
  readonly inventoryOptions: Array<FleetReadOptions | undefined> = [];
  readonly snapshotOptions: Array<FleetReadOptions | undefined> = [];
  async readHostSnapshot(options?: FleetReadOptions): Promise<HostSnapshot> {
    this.snapshotOptions.push(options);
    return SNAPSHOT;
  }
  readInventory(options?: FleetReadOptions): Promise<SimulatorInventoryEntry[]> {
    this.inventoryOptions.push(options);
    if (this.immediate) {
      return Promise.resolve(this.immediate);
    }
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

/** A ledger that counts the sample windows still open, so a leaked one is visible. */
class CountingLedger extends BootAdmissionLedger {
  liveWindows = 0;
  override beginSample() {
    const window = super.beginSample();
    this.liveWindows += 1;
    // The ledger recognises its own window object, so count on that one instead of wrapping it.
    const close = window.close.bind(window);
    let closed = false;
    window.close = () => {
      if (!closed) {
        closed = true;
        this.liveWindows -= 1;
      }
      close();
    };
    return window;
  }
}

function build(source: ScriptedSource) {
  const timer = new FakeTimer();
  const ledger = new CountingLedger(timer);
  const collector = new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer);
  const gate = new IosSimCapacityGate(collector, timer, {
    env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "1" },
    ledger,
  });
  return { gate, timer, ledger };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** The settled answer of a capacity read, or "pending" while it has none. */
function settling(read: Promise<unknown>): { answer: unknown } {
  const state: { answer: unknown } = { answer: "pending" };
  read.then(
    (value) => {
      state.answer = value ?? "capacity available";
    },
    (error: unknown) => {
      state.answer = error;
    },
  );
  return state;
}

const DISCOVERY_INCOMPLETE = { code: "discovery_incomplete", retryable: true, platform: "ios" };

/**
 * The read-only capacity reads sample inside a ledger window, as an admission does (#11643). A
 * `simctl list` that never returns must therefore not hang the caller or hold the window open:
 * the sample is bounded and cancellable like `admitBoot`'s, and an unfinished one is an unknown
 * count (`discovery_incomplete`), never "capacity available".
 */
describe("iOS read-only capacity reads take a bounded, cancellable sample", () => {
  test("the fresh sample's commands carry the sample budget so an abandoned run ends too (#13801)", async () => {
    const source = new ScriptedSource();
    source.immediate = [sim(A, "Shutdown")];
    const { gate } = build(source);

    await gate.assertCapacityAvailable();

    expect(source.inventoryOptions).toEqual([{ timeoutMs: DEFAULT_SAMPLE_TIMEOUT_MS }]);
    expect(source.snapshotOptions[0]?.timeoutMs).toBe(DEFAULT_SAMPLE_TIMEOUT_MS);
  });

  test("a hung simctl listing ends the check with discovery_incomplete at the sample deadline", async () => {
    const source = new ScriptedSource();
    const { gate, timer, ledger } = build(source);
    const check = settling(gate.assertCapacityAvailable());
    await tick();
    expect(source.pending.length).toBe(1);
    expect(ledger.liveWindows).toBe(1);

    timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS - 1);
    await tick();
    expect(check.answer).toBe("pending");

    timer.advanceTime(1);
    await tick();
    expect(check.answer).toMatchObject(DISCOVERY_INCOMPLETE);
    expect(ledger.liveWindows).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a cancelled caller is released at once and leaves no window open", async () => {
    const source = new ScriptedSource();
    const { gate, timer, ledger } = build(source);
    const controller = new AbortController();
    const check = settling(gate.assertCapacityAvailable({ signal: controller.signal }));
    await tick();
    expect(ledger.liveWindows).toBe(1);

    const reason = new Error("caller gave up");
    controller.abort(reason);
    await tick();

    expect(check.answer).toBe(reason);
    expect(ledger.liveWindows).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a caller that is already cancelled starts no listing and opens no window", async () => {
    const source = new ScriptedSource();
    const { gate, ledger } = build(source);
    const reason = new Error("already cancelled");

    const check = settling(gate.assertCapacityAvailable({ signal: AbortSignal.abort(reason) }));
    await tick();

    expect(check.answer).toBe(reason);
    expect(source.pending.length).toBe(0);
    expect(ledger.liveWindows).toBe(0);
  });

  test("a listing that returns after the check timed out is not judged as capacity available", async () => {
    const source = new ScriptedSource();
    const { gate, timer } = build(source);
    const check = settling(gate.assertCapacityAvailable());
    await tick();
    timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS);
    await tick();

    source.pending[0]([sim(A, "Shutdown")]); // an empty fleet, far too late
    await tick();

    expect(check.answer).toMatchObject(DISCOVERY_INCOMPLETE);
  });

  test("a hung listing ends the capacity report with discovery_incomplete and closes its window", async () => {
    const source = new ScriptedSource();
    const { gate, timer, ledger } = build(source);
    const report = settling(gate.describeCapacity());
    await tick();
    expect(ledger.liveWindows).toBe(1);

    timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS);
    await tick();

    expect(report.answer).toMatchObject(DISCOVERY_INCOMPLETE);
    expect(ledger.liveWindows).toBe(0);
  });

  test("the capacity report counts a boot that finished while its listing was open, as the check does", async () => {
    // listDevices' capacity block and a boot decided at the same instant must agree: with the
    // limit at 1 and A booted, "booted 0, in flight 0" beside a capacity_exhausted refusal is two
    // answers for one host state.
    const source = new ScriptedSource();
    const { gate } = build(source);
    source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    expect(first.decision.outcome).toBe("allow");

    source.immediate = undefined; // simctl is slow: both reads share one open listing
    const report = settling(gate.describeCapacity());
    const check = settling(gate.assertCapacityAvailable());
    await tick();
    expect(source.pending.length).toBe(1);

    // A finishes booting and releases its admission; the open listing was read before that.
    first.releaseAdmission?.();
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);
    await tick();

    expect(check.answer).toMatchObject({ code: "capacity_exhausted" });
    expect(report.answer).toMatchObject({ limit: 1, booted: 0, inFlight: 1 });
  });

  test("the capacity report does not join a listing that began before a boot it must count finished", async () => {
    const source = new ScriptedSource();
    const { gate } = build(source);
    source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
    const first = await gate.admitBoot(undefined, { bootUdid: A });
    source.immediate = undefined;
    const earlier = settling(gate.evaluateBoot()); // another caller's listing, A still Shutdown
    await tick();
    expect(source.pending.length).toBe(1);
    first.releaseAdmission?.(); // A is Booted now and holds its slot only in simctl

    const report = settling(gate.describeCapacity());
    await tick();
    expect(source.pending.length).toBe(2);
    source.pending[1]([sim(A, "Booted"), sim(B, "Shutdown")]);
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);
    await tick();

    expect(report.answer).toMatchObject({ limit: 1, booted: 1, inFlight: 0 });
    expect(earlier.answer).toMatchObject({ outcome: "allow" });
  });

  test("a boot released any number of microtasks after the listing answers still holds its slot for the check", async () => {
    const answers: Array<{ microtasks: number; answer: unknown }> = [];
    for (let microtasks = 0; microtasks <= 24; microtasks++) {
      const source = new ScriptedSource();
      const { gate, ledger } = build(source);
      source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
      const first = await gate.admitBoot(undefined, { bootUdid: A });
      expect(first.decision.outcome).toBe("allow");

      source.immediate = undefined;
      const check = settling(gate.assertCapacityAvailable());
      await tick();
      expect(source.pending.length).toBe(1);
      source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);
      for (let i = 0; i < microtasks; i++) {
        await Promise.resolve();
      }
      first.releaseAdmission?.();
      await tick();
      answers.push({ microtasks, answer: check.answer });
      expect(ledger.liveWindows).toBe(0);
    }

    for (const { microtasks, answer } of answers) {
      expect(answer, `N=${microtasks}`).toMatchObject({ code: "capacity_exhausted" });
    }
  });

  test("a boot released any number of microtasks after the listing answers still holds its slot for the capacity report", async () => {
    const answers: Array<{ microtasks: number; answer: unknown }> = [];
    for (let microtasks = 0; microtasks <= 24; microtasks++) {
      const source = new ScriptedSource();
      const { gate, ledger } = build(source);
      source.immediate = [sim(A, "Shutdown"), sim(B, "Shutdown")];
      const first = await gate.admitBoot(undefined, { bootUdid: A });
      expect(first.decision.outcome).toBe("allow");

      source.immediate = undefined;
      const report = settling(gate.describeCapacity());
      await tick();
      expect(source.pending.length).toBe(1);
      source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);
      for (let i = 0; i < microtasks; i++) {
        await Promise.resolve();
      }
      first.releaseAdmission?.();
      await tick();
      answers.push({ microtasks, answer: report.answer });
      expect(ledger.liveWindows).toBe(0);
    }

    for (const { microtasks, answer } of answers) {
      expect(answer, `N=${microtasks}`).toMatchObject({ limit: 1, booted: 0, inFlight: 1 });
    }
  });

  test("a caller aborted after the listing resolves but before judgment rejects and closes its window", async () => {
    const source = new ScriptedSource();
    const { gate, timer, ledger } = build(source);
    const controller = new AbortController();
    const check = settling(gate.assertCapacityAvailable({ signal: controller.signal }));
    await tick();
    expect(source.pending.length).toBe(1);
    source.pending[0]([sim(A, "Shutdown"), sim(B, "Shutdown")]);

    // Deadline cleanup proves the listing won the race; the gate has yet to judge it.
    for (let i = 0; i < 20 && timer.getPendingTimeoutCount() > 0; i++) {
      await Promise.resolve();
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(ledger.liveWindows).toBe(1);
    expect(check.answer).toBe("pending");
    const reason = new Error("cancelled before judgment");
    controller.abort(reason);
    await tick();

    expect(check.answer).toBe(reason);
    expect(ledger.liveWindows).toBe(0);
  });
});
