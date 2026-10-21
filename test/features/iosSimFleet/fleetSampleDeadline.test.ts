import { describe, expect, test } from "bun:test";
import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../src/features/bootAdmission/BootAdmissionGate";
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

const A = "AAAAAAAA-0000-0000-0000-000000000001";
const BOOTED_A: SimulatorInventoryEntry[] = [
  { udid: A, name: A, state: "Booted", runtime: "iOS-18", isAvailable: true },
];

/**
 * Commands that stay open until the test answers them or their own `timeoutMs` elapses, as a real
 * executor kills a hung `simctl`/`ps` at its timeout. `live` is how many are still running.
 */
class HangingSource implements FleetHostSource {
  readonly inventories: Array<(entries: SimulatorInventoryEntry[]) => void> = [];
  readonly snapshotOptions: FleetReadOptions[] = [];
  live = 0;

  constructor(private readonly timer: FakeTimer) {}

  readInventory(options: FleetReadOptions = {}): Promise<SimulatorInventoryEntry[]> {
    return this.command(options, (resolve) => this.inventories.push(resolve));
  }

  readHostSnapshot(options: FleetReadOptions = {}): Promise<HostSnapshot> {
    this.snapshotOptions.push(options);
    return this.command(options, () => {}); // `ps` hangs
  }

  private command<T>(options: FleetReadOptions, answer: (resolve: (value: T) => void) => void) {
    this.live += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const end = () => {
        const first = !done;
        done = true;
        this.live -= first ? 1 : 0;
        return first;
      };
      answer((value) => end() && resolve(value));
      if (options.timeoutMs !== undefined) {
        this.timer.setTimeout(
          () => end() && reject(new Error(`killed after ${options.timeoutMs}ms`)),
          options.timeoutMs,
        );
      }
    });
  }
}

function build() {
  const timer = new FakeTimer();
  const source = new HangingSource(timer);
  const collector = new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer);
  const gate = new IosSimCapacityGate(collector, timer, {
    env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "4" },
  });
  return { gate, timer, source, collector };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

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

const READS: Array<[string, (gate: IosSimCapacityGate) => Promise<unknown>]> = [
  ["the capacity check", (gate) => gate.assertCapacityAvailable()],
  ["the capacity report", (gate) => gate.describeCapacity()],
  ["a boot admission", (gate) => gate.admitBoot(undefined, { bootUdid: A })],
];

/**
 * One fleet sample is a listing followed by a host snapshot. Both share the sample's one deadline
 * (#14496): a listing that answers just before it leaves the snapshot only what is left, so a run
 * the gate abandoned at the deadline has ended too and an immediate retry does not stack on it.
 */
describe("an iOS fleet sample is bounded as a whole, not per phase", () => {
  test.each(READS)(
    "%s: a slow listing then a hung snapshot ends the whole run at the sample deadline",
    async (_name, read) => {
      const { gate, timer, source } = build();
      const first = settling(read(gate));
      await tick();
      expect(source.inventories.length).toBe(1);

      timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS - 1);
      source.inventories[0](BOOTED_A);
      await tick();
      expect(source.snapshotOptions[0]?.timeoutMs).toBe(1);

      timer.advanceTime(1);
      await tick();
      expect(first.answer).toMatchObject(DISCOVERY_INCOMPLETE);
      expect(source.live).toBe(0);

      // An immediate retry runs alone: nothing of the abandoned sample is still running.
      const retry = settling(read(gate));
      await tick();
      expect(source.live).toBe(1);
      expect(retry.answer).toBe("pending");
      timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS);
      await tick();
      expect(source.live).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a listing that uses up the whole budget starts no host snapshot", async () => {
    const { timer, source, collector } = build();
    const report = settling(collector.collectFresh({ deadlineMs: DEFAULT_SAMPLE_TIMEOUT_MS }));
    await tick();

    timer.advanceTime(DEFAULT_SAMPLE_TIMEOUT_MS - 1);
    source.inventories[0](BOOTED_A);
    timer.advanceTime(1); // the budget is spent before the collector resumes after the listing
    await tick();

    expect(source.snapshotOptions).toEqual([]);
    expect(source.live).toBe(0);
    expect(report.answer).toMatchObject({
      host: undefined,
      errors: [expect.stringContaining("host snapshot:")],
      simulators: [{ udid: A, quality: "unavailable" }],
    });
  });

  test("a relative timeout is the whole run's budget, measured from the run's start", async () => {
    const { timer, source, collector } = build();
    const report = settling(collector.collect({ timeoutMs: 1_000 }));
    await tick();

    timer.advanceTime(600);
    source.inventories[0](BOOTED_A);
    await tick();
    expect(source.snapshotOptions[0]?.timeoutMs).toBe(400);

    timer.advanceTime(400);
    await tick();
    expect(source.live).toBe(0);
    expect(report.answer).toMatchObject({ errors: [expect.stringContaining("host snapshot:")] });
  });
});
