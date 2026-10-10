import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
import { spawnUnderBootAdmission } from "../../../src/utils/android-cmdline-tools/spawnUnderBootAdmission";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * #11537: every order of admit / listing start / listing end / boot / release against the real
 * gates, ledger and collector. A listing reports the fleet as it was when it STARTED and may end
 * in any order, so a decision can rest on a listing older than any boot that began after it.
 * Boots always succeed and nothing shuts down, so the number of admissions granted is the number
 * of devices running: it must never pass the limit.
 *
 * #11564 adds an emulator started outside AutoMobile: its qemu process runs before adb lists it,
 * it takes a slot no admission accounts for, and it may exit and give the slot back.
 *
 * An admitted Android boot goes through the emulator client's own slot handling
 * (`spawnUnderBootAdmission`): its process exists from the spawn, startup validation ends later,
 * and only then can adb list it. Between spawn and validation the boot is one process and one
 * admission, and must count once.
 */

const GIB = 1024 ** 3;

/** `admitters` boots compete for `limit` slots while one reader lists the fleet. */
interface Shape {
  limit: number;
  admitters: number;
  /**
   * An emulator nobody admitted starts at any point (Android). Then adb lists it ("lists"), it
   * exits unlisted ("exits"), or either and an exit after the listing ("any"): the full life
   * cycle beside two admissions is thousands of orders, so the larger shapes take one half each.
   */
  external?: "lists" | "exits" | "any";
  /** Leave the reader out to keep a larger shape fast. */
  noReader?: boolean;
  /** A spawned emulator may exit before its startup validation ends, giving its slot back. */
  earlyExit?: boolean;
  /**
   * Spawn and the end of startup validation as one step, to keep a larger shape fast: with the
   * slot handed off at spawn, validation changes nothing the gate counts.
   */
  instantStartup?: boolean;
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
  /** Admissions granted beside as many devices as the limit, counting the external emulator. */
  admittedPastLimit: string[];
  /** Refusals although the admitted boots and the external emulator left a slot free. */
  needlessRefusals: string[];
  /** Nothing but admitted boots takes a slot, so exactly `limit` of them end up admitted. */
  fillsLimit: boolean;
}

interface Exploration {
  orders: number;
  overLimit: string[];
  wrongFinalCount: string[];
  unexpected: string[];
}

/**
 * Every order of the enabled actions that starts with `prefix`. One scenario runs down the first
 * enabled action to the end of an order; every other enabled action on the way is queued and
 * later replayed on a fresh scenario, so each order costs one replay rather than one per step.
 */
async function exploreEveryOrder(
  create: () => Scenario,
  limit: number,
  prefix: string[] = [],
): Promise<Exploration> {
  const result: Exploration = { orders: 0, overLimit: [], wrongFinalCount: [], unexpected: [] };
  const pending: string[][] = [prefix];
  const descend = async (start: string[]): Promise<void> => {
    const scenario = create();
    const path = [...start];
    for (const action of path) {
      await scenario.run(action);
    }
    for (;;) {
      if (scenario.admitted() > limit || scenario.admittedPastLimit.length > 0) {
        result.overLimit.push(path.join(" > "));
        return;
      }
      const [first, ...others] = scenario.enabled();
      if (first === undefined) {
        break;
      }
      pending.push(...others.map((other) => [...path, other]));
      path.push(first);
      await scenario.run(first);
    }
    const order = path.join(" > ");
    result.orders += 1;
    // Each decision below the limit finds a free slot, so exactly `limit` boots are admitted.
    const filled = !scenario.fillsLimit || scenario.admitted() === limit;
    if (!filled || scenario.needlessRefusals.length > 0) {
      result.wrongFinalCount.push(order);
    }
    result.unexpected.push(...scenario.unexpected.map((problem) => `${order}: ${problem}`));
  };
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    await descend(next);
  }
  return result;
}

/** Shared bookkeeping: who started, what each decision was, which actor may act next. */
class Actors {
  readonly outcomes: Outcome[] = [];
  readonly unexpected: string[] = [];
  readonly admittedPastLimit: string[] = [];
  readonly needlessRefusals: string[] = [];
  readStarted: boolean;
  /** The external emulator's process runs; a capacity sample starting now shows it. */
  externalRunning = false;
  /** Per admitter: the external emulator ran when its capacity sample started. */
  private readonly sampledExternal: boolean[] = [];
  /**
   * Per admitter: the admitted boots that held a slot at any point of its capacity sample. One
   * that exited since still counts for that decision: nothing tells the gate whether the listing
   * predates the exit (#11537).
   */
  private readonly sampledBoots: Array<Set<number>> = [];
  /** Admitted boots whose emulator exited: the slot is free again. */
  readonly exited = new Set<number>();

  constructor(private readonly shape: Shape) {
    this.readStarted = shape.noReader === true;
  }

  /** Admitted boots still holding a slot. */
  admitted(): number {
    return this.holders().length;
  }

  private holders(): number[] {
    return this.outcomes.flatMap((outcome, index) =>
      outcome === "admitted" && !this.exited.has(index) ? [index] : [],
    );
  }

  /** Admitters are interchangeable, so only the lowest unstarted one may start. */
  startActions(): string[] {
    const next = this.outcomes.length;
    return [
      ...(next < this.shape.admitters ? [`start:${next}`] : []),
      ...(this.readStarted ? [] : ["read"]),
    ];
  }

  track(index: number, decision: Promise<"admitted" | "refused">): void {
    this.outcomes[index] = "pending";
    this.sampledExternal[index] = this.externalRunning;
    this.sampledBoots[index] = new Set(this.holders());
    decision.then(
      (outcome) => {
        this.outcomes[index] = outcome;
        this.judge(index, outcome);
      },
      (error: unknown) => {
        this.outcomes[index] = "refused";
        this.unexpected.push(String(error));
      },
    );
  }

  /**
   * The sample showed the external emulator's process exactly when it ran as the sample started.
   * An admission beside it is over the limit unless it has exited since; a refusal needs it, the
   * admitted boots, or a boot that held a slot during the sample and has exited since, to fill
   * the limit.
   */
  private judge(index: number, outcome: "admitted" | "refused"): void {
    const sampled = this.sampledExternal[index] ? 1 : 0;
    const { limit } = this.shape;
    if (outcome === "admitted" && this.admitted() + (this.externalRunning ? sampled : 0) > limit) {
      this.admittedPastLimit.push(`admitter ${index}`);
    }
    if (outcome === "admitted") {
      this.outcomes.forEach((other, pending) => {
        if (other === "pending") {
          this.sampledBoots[pending].add(index);
        }
      });
    }
    if (outcome === "refused" && this.sampledBoots[index].size + sampled < limit) {
      this.needlessRefusals.push(`admitter ${index}`);
    }
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
  const actors = new Actors(shape);
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
    admittedPastLimit: actors.admittedPastLimit,
    needlessRefusals: actors.needlessRefusals,
    fillsLimit: true,
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
  /** Serials whose qemu process runs: in the process table from spawn, before adb lists them. */
  const processes = new Set<string>();
  const listings = new HeldListings<AndroidCapacitySample>();
  const source: AndroidCapacitySource = {
    sample: () =>
      listings.start({
        emulatorSerials: [...listed],
        emulatorProcessRssBytes: [...processes].map(() => 3 * GIB),
        host: { totalMemoryBytes: 64 * GIB, cpuCount: 16 },
        errors: [],
      }),
  };
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { [ANDROID_MAX_BOOTED_ENV]: String(shape.limit) },
  });
  const actors = new Actors(shape);
  const admissions: Array<BootAdmission | undefined> = [];
  /** Spawned emulators whose startup validation is still running. */
  const validating = new Map<number, { child: EventEmitter; settle: (alive: boolean) => void }>();
  const validated = new Set<number>();
  const serial = (index: number): string => `emulator-${5554 + index * 2}`;
  /** What the emulator client does with an admission from the cold spawn on. */
  const spawn = (index: number, admission: BootAdmission): void => {
    const child = new EventEmitter();
    const launch = spawnUnderBootAdmission(admission, undefined, (onSpawn) => {
      // The qemu process exists from here on; the client reports it before validating startup.
      processes.add(serial(index));
      onSpawn(child, serial(index));
      return new Promise<{ process: EventEmitter; reservedDeviceId: string }>((resolve, reject) =>
        validating.set(index, {
          child,
          settle: (alive) =>
            alive
              ? resolve({ process: child, reservedDeviceId: serial(index) })
              : reject(new Error("emulator exited during startup")),
        }),
      );
    });
    // An early exit rejects the launch; the scenario's `exit` step is that failure.
    launch.catch(() => undefined);
  };
  const EXTERNAL_SERIAL = "emulator-5580";
  let externalStarted = false;
  const externalActions = (): string[] => {
    if (!shape.external) {
      return [];
    }
    if (!externalStarted) {
      return ["externalStart"];
    }
    if (!actors.externalRunning) {
      return [];
    }
    const listable = shape.external !== "exits" && !listed.has(EXTERNAL_SERIAL);
    return [
      ...(listable ? ["externalList"] : []),
      ...(shape.external === "lists" ? [] : ["externalExit"]),
    ];
  };

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
    // The emulator process was spawned and its serial is reserved; adb does not list it yet.
    spawn: (index) => {
      const admission = admissions[index];
      if (admission) {
        spawn(index, admission);
      }
      if (shape.instantStartup) {
        actions.validate(index);
      }
    },
    // Startup validation ended with the emulator alive.
    validate: (index) => {
      validating.get(index)?.settle(true);
      validating.delete(index);
      validated.add(index);
    },
    // The emulator died during startup validation: no process, and its slot is free again.
    exit: (index) => {
      const startup = validating.get(index);
      validating.delete(index);
      processes.delete(serial(index));
      actors.exited.add(index);
      startup?.child.emit("exit", 1, null);
      startup?.settle(false);
    },
    // Someone else's emulator: a qemu process from here on, in no admission and not in adb yet.
    externalStart: () => {
      externalStarted = true;
      actors.externalRunning = true;
      processes.add(EXTERNAL_SERIAL);
    },
    externalList: () => {
      listed.add(EXTERNAL_SERIAL);
    },
    // Gone from the process table and from adb; a listing already running still shows it.
    externalExit: () => {
      actors.externalRunning = false;
      processes.delete(EXTERNAL_SERIAL);
      listed.delete(EXTERNAL_SERIAL);
    },
    // adb lists the emulator from here on; a listing already running does not.
    list: (index) => {
      listed.add(serial(index));
    },
  };

  return {
    unexpected: actors.unexpected,
    admittedPastLimit: actors.admittedPastLimit,
    needlessRefusals: actors.needlessRefusals,
    fillsLimit: !shape.external && !shape.earlyExit,
    admitted: () => actors.admitted(),
    enabled: () => [
      ...actors.startActions(),
      ...externalActions(),
      ...listings.openIds().map((id) => `end:${id}`),
      ...actors.outcomes.flatMap((outcome, index) => {
        if (outcome !== "admitted" || listed.has(serial(index)) || actors.exited.has(index)) {
          return [];
        }
        if (validated.has(index)) {
          return [`list:${index}`];
        }
        if (!validating.has(index)) {
          return [`spawn:${index}`];
        }
        return [`validate:${index}`, ...(shape.earlyExit ? [`exit:${index}`] : [])];
      }),
    ],
    run: async (action) => {
      const [name, index] = action.split(":");
      actions[name](Number(index));
      await settle();
    },
  };
}

/** Android shapes with the orders each one walks: a changed count means the walk changed. */
const EXTERNAL_SHAPES: Array<[Shape, number]> = [
  [{ limit: 1, admitters: 1, external: "any", instantStartup: true }, 1199],
  [{ limit: 1, admitters: 2, external: "lists", noReader: true }, 498],
  [{ limit: 1, admitters: 2, external: "exits", noReader: true }, 519],
  [{ limit: 2, admitters: 2, external: "lists", noReader: true, instantStartup: true }, 1103],
  [{ limit: 2, admitters: 2, external: "exits", noReader: true, instantStartup: true }, 1193],
];

const STARTUP_SHAPES: Array<[Shape, number]> = [
  // The smallest shape with the double count: one boot spawned and still validating, one slot
  // free, and a second admission that has to be granted.
  [{ limit: 2, admitters: 2, noReader: true }, 126],
  [{ limit: 2, admitters: 2, noReader: true, earlyExit: true }, 287],
  [{ limit: 1, admitters: 2, earlyExit: true }, 1056],
];

function describeShape(shape: Shape): string {
  const parts = [
    `${shape.admitters} admission(s)`,
    ...(shape.noReader ? [] : ["a reader"]),
    ...(shape.external ? [`an external emulator (${shape.external})`] : []),
    ...(shape.earlyExit ? ["emulators that may exit during startup"] : []),
  ];
  return `Android: ${parts.join(", ")} against a limit of ${shape.limit}`;
}

async function expectEveryOrderHolds(
  create: () => Scenario,
  limit: number,
  orders: number,
): Promise<void> {
  const result = await exploreEveryOrder(create, limit);

  // The first few orders are enough to reproduce; hundreds would drown the report.
  expect(result.overLimit.slice(0, 5)).toEqual([]);
  // No refusal without cause either: a slot nothing holds is granted.
  expect(result.wrongFinalCount.slice(0, 5)).toEqual([]);
  expect(result.unexpected.slice(0, 5)).toEqual([]);
  expect(result.orders).toBe(orders);
}

describe("boot capacity gates never admit past the limit in any interleaving (#11537)", () => {
  // Three admissions against a limit of two also hold (40,492 iOS and 73,260 Android orders,
  // checked by hand), but take seconds; this shape already contains every failing order found.
  const shape: Shape = { limit: 1, admitters: 2 };
  for (const [platform, create, orders] of [
    ["iOS", iosScenario, 218],
    ["Android", androidScenario, 648],
  ] as const) {
    test(`${platform}: two admissions and a reader against a limit of one`, async () => {
      await expectEveryOrderHolds(() => create(shape), shape.limit, orders);
    });
  }
});

describe("an external emulator adb has not listed takes a slot in any interleaving (#11564)", () => {
  // The smallest shape with the hole: a limit of two holds the external emulator and one admitted
  // boot that has not spawned, and the second admission has to be refused.
  for (const [shape, orders] of EXTERNAL_SHAPES) {
    test(describeShape(shape), async () => {
      await expectEveryOrderHolds(() => androidScenario(shape), shape.limit, orders);
    });
  }
});

describe("a spawned emulator still validating its startup takes one slot in any interleaving (#11564)", () => {
  for (const [shape, orders] of STARTUP_SHAPES) {
    test(describeShape(shape), async () => {
      await expectEveryOrderHolds(() => androidScenario(shape), shape.limit, orders);
    });
  }
});
