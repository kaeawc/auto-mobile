import { describe, expect, test } from "bun:test";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import type {
  AndroidCapacitySample,
  AndroidCapacitySource,
} from "../../../src/features/bootAdmission/AndroidCapacitySource";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import type { FleetHostSource } from "../../../src/features/iosSimFleet/FleetHostSource";
import type {
  HostSnapshot,
  SimulatorInventoryEntry,
} from "../../../src/features/iosSimFleet/types";
import type { BootAdmission } from "../../../src/models/BootAdmission";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * #11537: every order of admit / listing start / listing end / boot / release against the real
 * gates, ledger and collector. A listing reports the fleet as it was when it STARTED and may end
 * in any order, so a decision can rest on a listing older than any boot that began after it.
 * Boots always succeed and nothing shuts down, so the number of admissions granted is the number
 * of devices running: it must never pass the limit.
 */

const GIB = 1024 ** 3;

/** `admitters` boots compete for `limit` slots while one reader lists the fleet. */
interface Shape {
  limit: number;
  admitters: number;
}

/** Let queued promise continuations run; no timer involved. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Listings held open: each resolves, when ended, with the snapshot taken as it started. */
class HeldListings<T> {
  private readonly open = new Map<number, () => void>();
  private started = 0;

  start(snapshot: T): Promise<T> {
    const id = this.started++;
    return new Promise((resolve) => this.open.set(id, () => resolve(snapshot)));
  }

  openIds(): number[] {
    return [...this.open.keys()];
  }

  end(id: number): void {
    const resolve = this.open.get(id);
    this.open.delete(id);
    resolve?.();
  }
}

type Outcome = "pending" | "admitted" | "refused";

interface Scenario {
  /** Actions that may run next. */
  enabled(): string[];
  run(action: string): Promise<void>;
  admitted(): number;
  /** Anything other than an admission or a capacity refusal. */
  unexpected: string[];
}

interface Exploration {
  orders: number;
  overLimit: string[];
  wrongFinalCount: string[];
  unexpected: string[];
}

/** Depth-first over every enabled action, replaying each prefix on a fresh scenario. */
async function exploreEveryOrder(create: () => Scenario, limit: number): Promise<Exploration> {
  const result: Exploration = { orders: 0, overLimit: [], wrongFinalCount: [], unexpected: [] };
  const visit = async (path: string[]): Promise<void> => {
    const scenario = create();
    for (const action of path) {
      await scenario.run(action);
    }
    const order = path.join(" > ");
    if (scenario.admitted() > limit) {
      result.overLimit.push(order);
      return;
    }
    const next = scenario.enabled();
    if (next.length === 0) {
      result.orders += 1;
      // Each decision below the limit finds a free slot, so exactly `limit` boots are admitted.
      if (scenario.admitted() !== limit) {
        result.wrongFinalCount.push(order);
      }
      result.unexpected.push(...scenario.unexpected.map((problem) => `${order}: ${problem}`));
      return;
    }
    for (const action of next) {
      await visit([...path, action]);
    }
  };
  await visit([]);
  return result;
}

/** Shared bookkeeping: who started, what each decision was, which actor may act next. */
class Actors {
  readonly outcomes: Outcome[] = [];
  readonly unexpected: string[] = [];
  readStarted = false;

  constructor(private readonly admitters: number) {}

  admitted(): number {
    return this.outcomes.filter((outcome) => outcome === "admitted").length;
  }

  /** Admitters are interchangeable, so only the lowest unstarted one may start. */
  startActions(): string[] {
    const next = this.outcomes.length;
    return [
      ...(next < this.admitters ? [`start:${next}`] : []),
      ...(this.readStarted ? [] : ["read"]),
    ];
  }

  track(index: number, decision: Promise<"admitted" | "refused">): void {
    this.outcomes[index] = "pending";
    decision.then(
      (outcome) => {
        this.outcomes[index] = outcome;
      },
      (error: unknown) => {
        this.outcomes[index] = "refused";
        this.unexpected.push(String(error));
      },
    );
  }

  trackRead(read: Promise<unknown>): void {
    this.readStarted = true;
    read.catch((error: unknown) => this.unexpected.push(String(error)));
  }
}

const IOS_UDIDS = [
  "AAAAAAAA-0000-0000-0000-000000000001",
  "BBBBBBBB-0000-0000-0000-000000000002",
  "CCCCCCCC-0000-0000-0000-000000000003",
];

const IOS_HOST: HostSnapshot = {
  takenAtMs: 0,
  resources: {
    totalMemoryBytes: 64 * GIB,
    cpuCount: 16,
    memoryPressure: "normal",
    loadAverage1m: null,
  },
  processes: [],
};

function iosScenario(shape: Shape): Scenario {
  const timer = new FakeTimer();
  const booted = new Set<string>();
  const listings = new HeldListings<SimulatorInventoryEntry[]>();
  const source: FleetHostSource = {
    readHostSnapshot: async () => IOS_HOST,
    readInventory: () =>
      listings.start(
        IOS_UDIDS.map((udid) => ({
          udid,
          name: udid,
          state: booted.has(udid) ? "Booted" : "Shutdown",
          runtime: "iOS-18",
          isAvailable: true,
        })),
      ),
  };
  const collector = new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer);
  const gate = new IosSimCapacityGate(collector, timer, {
    env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: String(shape.limit) },
  });
  const actors = new Actors(shape.admitters);
  const releases: Array<(() => void) | undefined> = [];
  const released = new Set<number>();

  const actions: Record<string, (index: number) => void> = {
    start: (index) =>
      actors.track(
        index,
        gate.admitBoot(undefined, { bootUdid: IOS_UDIDS[index] }).then((admission) => {
          releases[index] = admission.releaseAdmission;
          return admission.decision.outcome === "refuse" ? "refused" : "admitted";
        }),
      ),
    // A reader's listing is one an admission must not rest on if it began before its window.
    read: () => actors.trackRead(gate.describeCapacity()),
    end: (id) => listings.end(id),
    // The simulator is Booted from here on; a listing already running still shows it Shutdown.
    boot: (index) => {
      booted.add(IOS_UDIDS[index]);
    },
    // The boot call returned: the ledger entry ends and only `simctl` holds the slot.
    release: (index) => {
      released.add(index);
      releases[index]?.();
    },
  };

  return {
    unexpected: actors.unexpected,
    admitted: () => actors.admitted(),
    enabled: () => [
      ...actors.startActions(),
      ...listings.openIds().map((id) => `end:${id}`),
      ...actors.outcomes.flatMap((outcome, index) => {
        if (outcome !== "admitted" || released.has(index)) {
          return [];
        }
        return booted.has(IOS_UDIDS[index]) ? [`release:${index}`] : [`boot:${index}`];
      }),
    ],
    run: async (action) => {
      const [name, index] = action.split(":");
      actions[name](Number(index));
      await settle();
    },
  };
}

function androidScenario(shape: Shape): Scenario {
  const timer = new FakeTimer();
  const listed = new Set<string>();
  const listings = new HeldListings<AndroidCapacitySample>();
  // The process table shows no emulator, so only the adb listing and the ledger hold a slot.
  const source: AndroidCapacitySource = {
    sample: () =>
      listings.start({
        emulatorSerials: [...listed],
        emulatorProcessRssBytes: [],
        host: { totalMemoryBytes: 64 * GIB, cpuCount: 16 },
        errors: [],
      }),
  };
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { [ANDROID_MAX_BOOTED_ENV]: String(shape.limit) },
  });
  const actors = new Actors(shape.admitters);
  const admissions: Array<BootAdmission | undefined> = [];
  const handedOff = new Set<number>();
  const serial = (index: number): string => `emulator-${5554 + index * 2}`;

  const actions: Record<string, (index: number) => void> = {
    start: (index) =>
      actors.track(
        index,
        gate.admit({ timeoutMs: 60_000, avdName: `avd-${index}` }).then(
          (admission) => {
            admissions[index] = admission;
            return "admitted" as const;
          },
          (error: unknown) => {
            if (error instanceof BootCapacityExhaustedError) {
              return "refused" as const;
            }
            throw error;
          },
        ),
      ),
    // A reader's count drops a handed-off boot it sees listed; an older open sample does not see it.
    read: () => actors.trackRead(gate.describeCapacity()),
    end: (id) => listings.end(id),
    // The emulator process was spawned and its serial is known; adb does not list it yet.
    handOff: (index) => {
      handedOff.add(index);
      admissions[index]?.handOff(serial(index));
    },
    // adb lists the emulator from here on; a listing already running does not.
    list: (index) => {
      listed.add(serial(index));
    },
  };

  return {
    unexpected: actors.unexpected,
    admitted: () => actors.admitted(),
    enabled: () => [
      ...actors.startActions(),
      ...listings.openIds().map((id) => `end:${id}`),
      ...actors.outcomes.flatMap((outcome, index) => {
        if (outcome !== "admitted" || listed.has(serial(index))) {
          return [];
        }
        return handedOff.has(index) ? [`list:${index}`] : [`handOff:${index}`];
      }),
    ],
    run: async (action) => {
      const [name, index] = action.split(":");
      actions[name](Number(index));
      await settle();
    },
  };
}

describe("boot capacity gates never admit past the limit in any interleaving (#11537)", () => {
  // Three admissions against a limit of two also hold (40,492 iOS and 73,260 Android orders,
  // checked by hand), but take seconds; this shape already contains every failing order found.
  const shape: Shape = { limit: 1, admitters: 2 };
  for (const [platform, create] of [
    ["iOS", iosScenario],
    ["Android", androidScenario],
  ] as const) {
    test(`${platform}: two admissions and a reader against a limit of one`, async () => {
      const result = await exploreEveryOrder(() => create(shape), shape.limit);

      // The first few orders are enough to reproduce; hundreds would drown the report.
      expect(result.overLimit.slice(0, 5)).toEqual([]);
      expect(result.wrongFinalCount.slice(0, 5)).toEqual([]);
      expect(result.unexpected.slice(0, 5)).toEqual([]);
      expect(result.orders).toBeGreaterThan(200);
    });
  }
});
