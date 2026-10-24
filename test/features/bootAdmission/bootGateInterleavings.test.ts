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
 * of devices running: it must never pass the limit. Larger walks are partitioned by breadth-first
 * roots into disjoint tests; every order is still replayed against a fresh real gate.
 *
 * #11564 adds an emulator started outside AutoMobile: its qemu process runs before adb lists it,
 * it takes a slot no admission accounts for, and it may exit and give the slot back.
 *
 * An admitted Android boot goes through the emulator client's own slot handling
 * (`spawnUnderBootAdmission`): the launcher process exists from the spawn, it becomes the qemu
 * process a moment later, startup validation ends later still, and only then can adb list it.
 * From the spawn on the boot is one admission and at most one counted process, and must count
 * once: not twice once its qemu process shows, and not zero times beside an external emulator
 * while only the launcher runs.
 *
 * #11588: a capacity sample is two reads, the adb listing and the process table, taken at
 * different moments in either order. The "split" shapes take each read as a step of its own, so
 * a boot can spawn and be listed between them: the process table then predates the boot's process
 * while the adb listing already shows the boot, and the external emulator is in the table only.
 * The gate's count holds for either order of the reads there. It cannot for two external
 * emulators, one only in an older process table and one only in a newer adb listing: no
 * admission tells them apart. The source therefore reads adb first ("adbFirst"): an emulator adb
 * lists already has a process, so the later process table shows it too.
 */

const GIB = 1024 ** 3;

/** `admitters` boots compete for `limit` slots while one reader lists the fleet. */
interface Shape {
  limit: number;
  admitters: number;
  /**
   * An emulator nobody admitted starts at any point (Android). Then adb lists it ("lists"), it
   * exits unlisted ("exits"), either and an exit after the listing ("any"), or it just keeps
   * running unlisted ("stays"): the full life cycle beside two admissions is thousands of
   * orders, so the larger shapes take one part each.
   */
  external?: "lists" | "exits" | "any" | "stays";
  /** Leave the reader out to keep a larger shape fast. */
  noReader?: boolean;
  /** A spawned emulator may exit before its startup validation ends, giving its slot back. */
  earlyExit?: boolean;
  /**
   * Which steps of an emulator's startup the walk takes apart; the rest happen with the spawn.
   * "launcher": the launcher runs and is handed off before its qemu process shows. "validation":
   * the qemu process shows at the spawn and startup validation ends later. "all": each on its
   * own. "none" keeps a larger shape fast.
   */
  startup: "none" | "launcher" | "validation" | "all";
  /**
   * How a capacity sample reads adb and the process table (Android). Left out, both are read as
   * the sample starts. "split": each is read in a step of its own, in either order, with any
   * other step in between, and the sample ends in a later step still. "adbFirst": the same,
   * with the adb read always the earlier one, as `CommandAndroidCapacitySource` takes them.
   */
  reads?: "split" | "adbFirst";
  /**
   * A second emulator nobody admitted starts and is listed by adb in one step, at any point, and
   * keeps running (Android).
   */
  secondExternal?: boolean;
  /** Steps every order starts with: the fleet the walk begins from, which keeps the walk small. */
  prefix?: string[];
}

/** Let queued promise continuations run; no timer involved. */
async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
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

/** Breadth-first partition: terminal and violating nodes remain roots even before `depth`. */
async function walkRoots(
  create: () => Scenario,
  limit: number,
  prefix: string[],
  depth: number,
): Promise<string[][]> {
  const pending = [prefix];
  const roots: string[][] = [];
  for (let index = 0; index < pending.length; index++) {
    const path = pending[index];
    const scenario = create();
    for (const action of path) {
      await scenario.run(action);
    }
    const enabled = scenario.enabled();
    if (
      scenario.admitted() > limit ||
      scenario.admittedPastLimit.length > 0 ||
      enabled.length === 0 ||
      path.length - prefix.length === depth
    ) {
      roots.push(path);
    } else {
      pending.push(...enabled.map((action) => [...path, action]));
    }
  }
  return roots;
}

/** Modulo partitions are disjoint and cover every root, including any interior violation. */
async function exploreSlice(
  create: () => Scenario,
  limit: number,
  prefix: string[],
  depth: number,
  part: number,
  parts: number,
): Promise<Exploration> {
  const roots = await walkRoots(create, limit, prefix, depth);
  const result: Exploration = { orders: 0, overLimit: [], wrongFinalCount: [], unexpected: [] };
  for (let index = part; index < roots.length; index += parts) {
    const explored = await exploreEveryOrder(create, limit, roots[index]);
    result.orders += explored.orders;
    result.overLimit.push(...explored.overLimit);
    result.wrongFinalCount.push(...explored.wrongFinalCount);
    result.unexpected.push(...explored.unexpected);
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
  /** Serials of the external emulators whose process runs; a read taken now shows them. */
  readonly externalsRunning = new Set<string>();
  /** Per admitter: the external emulators its capacity sample showed, in either of its reads. */
  private readonly sampledExternals = new Map<number, Set<string>>();
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

  /** A read of this admitter's capacity sample showed this external emulator. */
  showedExternal(index: number, serial: string): void {
    this.sampledExternals.set(index, new Set(this.sampledExternals.get(index)).add(serial));
  }

  /**
   * The sample showed an external emulator when a read found its process or its adb row.
   * An admission beside it is over the limit unless it has exited since; a refusal needs the
   * external emulators shown, the admitted boots, or a boot that held a slot during the sample
   * and has exited since, to fill the limit.
   */
  private judge(index: number, outcome: "admitted" | "refused"): void {
    const shown = [...(this.sampledExternals.get(index) ?? [])];
    const sampled = shown.length;
    const stillRunning = shown.filter((serial) => this.externalsRunning.has(serial)).length;
    const { limit } = this.shape;
    if (outcome === "admitted" && this.admitted() + stillRunning > limit) {
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
    // A reader samples in its own ledger window, on a listing begun no earlier than that window.
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
      // Include the boot-permit acquisition continuations before enumerating the next action.
      await settle(40);
    },
  };
}

function androidScenario(shape: Shape): Scenario {
  const timer = new FakeTimer();
  const listed = new Set<string>();
  /** Serials whose qemu process runs: in the process table from spawn, before adb lists them. */
  const processes = new Map<string, number>();
  const EXTERNAL_SERIAL = "emulator-5580";
  const SECOND_EXTERNAL_SERIAL = "emulator-5582";
  const EXTERNAL_SERIALS = [EXTERNAL_SERIAL, SECOND_EXTERNAL_SERIAL];
  const actors = new Actors(shape);
  /** The admitter whose `start` step is running: the next sample is its own. */
  let sampler: number | undefined;
  /** Samples held open: what each read found, once it was taken, and who decides on it. */
  const samples = new Map<
    number,
    { owner?: number; serials?: string[]; pids?: number[]; end: () => void }
  >();
  let sampleCount = 0;
  const readAdb = (id: number): void => {
    const sample = samples.get(id);
    if (sample) {
      sample.serials = [...listed];
      const { owner } = sample;
      if (owner !== undefined) {
        EXTERNAL_SERIALS.filter((external) => listed.has(external)).forEach((external) =>
          actors.showedExternal(owner, external),
        );
      }
    }
  };
  const readPs = (id: number): void => {
    const sample = samples.get(id);
    if (sample) {
      sample.pids = [...processes.values()];
      const { owner } = sample;
      if (owner !== undefined) {
        EXTERNAL_SERIALS.filter((external) => processes.has(external)).forEach((external) =>
          actors.showedExternal(owner, external),
        );
      }
    }
  };
  const source: AndroidCapacitySource = {
    sample: () =>
      new Promise<AndroidCapacitySample>((resolve) => {
        const id = sampleCount++;
        const sample = {
          owner: sampler,
          serials: undefined as string[] | undefined,
          pids: undefined as number[] | undefined,
          end: () => {
            samples.delete(id);
            const pids = sample.pids ?? [];
            resolve({
              emulatorSerials: sample.serials ?? [],
              emulatorProcessRssBytes: pids.map(() => 3 * GIB),
              emulatorProcessIds: pids.map((pid) => ({ pid, ppid: 1 })),
              host: { totalMemoryBytes: 64 * GIB, cpuCount: 16 },
              errors: [],
            });
          },
        };
        samples.set(id, sample);
        if (shape.reads === undefined) {
          readAdb(id);
          readPs(id);
        }
      }),
  };
  /** A sample's reads still to take, then its end: a read never follows the sample's end. */
  const sampleActions = (): string[] =>
    [...samples].flatMap(([id, sample]) => {
      const reads = [
        ...(sample.serials === undefined ? [`adb:${id}`] : []),
        ...(sample.pids === undefined ? [`ps:${id}`] : []),
      ];
      if (reads.length === 0) {
        return [`end:${id}`];
      }
      return shape.reads === "adbFirst" ? reads.slice(0, 1) : reads;
    });
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { [ANDROID_MAX_BOOTED_ENV]: String(shape.limit) },
  });
  const admissions: Array<BootAdmission | undefined> = [];
  /** Spawned emulators whose startup validation is still running. */
  const validating = new Map<number, { child: EventEmitter; settle: (alive: boolean) => void }>();
  /** The pid of the launcher the client spawns; the launcher becomes the qemu process. */
  const launcherPid = (index: number): number => 1_000 + index;
  const validated = new Set<number>();
  const serial = (index: number): string => `emulator-${5554 + index * 2}`;
  /** What the emulator client does with an admission from the cold spawn on. */
  const spawn = (index: number, admission: BootAdmission): void => {
    const child = Object.assign(new EventEmitter(), { pid: launcherPid(index) });
    const launch = spawnUnderBootAdmission(admission, undefined, (onSpawn) => {
      // Only the launcher runs so far: no qemu process. The client reports it at once.
      onSpawn(child, serial(index));
      return new Promise<{ process: typeof child; reservedDeviceId: string }>((resolve, reject) =>
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
  let externalStarted = false;
  const externalActions = (): string[] => {
    if (!shape.external) {
      return [];
    }
    if (!externalStarted) {
      return ["externalStart"];
    }
    if (!actors.externalsRunning.has(EXTERNAL_SERIAL)) {
      return [];
    }
    const lists = shape.external === "lists" || shape.external === "any";
    const exits = shape.external === "exits" || shape.external === "any";
    return [
      ...(lists && !listed.has(EXTERNAL_SERIAL) ? ["externalList"] : []),
      ...(exits ? ["externalExit"] : []),
    ];
  };

  const actions: Record<string, (index: number) => void> = {
    start: (index) => {
      sampler = index;
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
      );
    },
    // A reader's count drops a handed-off boot it sees listed; an older open sample does not see it.
    read: () => {
      sampler = undefined;
      actors.trackRead(gate.describeCapacity());
    },
    // The sample's adb listing is read now: it shows the emulators adb lists at this step.
    adb: readAdb,
    // The sample's process table is read now: it shows the qemu processes running at this step.
    ps: readPs,
    end: (id) => samples.get(id)?.end(),
    // The emulator process was spawned and its serial is reserved; adb does not list it yet.
    spawn: (index) => {
      const admission = admissions[index];
      if (admission) {
        spawn(index, admission);
      }
      // The steps this shape does not take apart follow at once, in their order.
      if (shape.startup === "none" || shape.startup === "validation") {
        actions.qemu(index);
      }
      if (shape.startup === "none") {
        actions.validate(index);
      }
    },
    // The launcher became the qemu process: the process table shows the emulator from here on.
    qemu: (index) => {
      processes.set(serial(index), launcherPid(index));
      if (shape.startup === "launcher") {
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
      actors.externalsRunning.add(EXTERNAL_SERIAL);
      processes.set(EXTERNAL_SERIAL, 2_000);
    },
    // Another emulator nobody admitted: a qemu process and an adb row at once, from here on.
    secondExternal: () => {
      actors.externalsRunning.add(SECOND_EXTERNAL_SERIAL);
      processes.set(SECOND_EXTERNAL_SERIAL, 2_001);
      listed.add(SECOND_EXTERNAL_SERIAL);
    },
    externalList: () => {
      listed.add(EXTERNAL_SERIAL);
    },
    // Gone from the process table and from adb; a listing already running still shows it.
    externalExit: () => {
      actors.externalsRunning.delete(EXTERNAL_SERIAL);
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
      ...(shape.secondExternal && !actors.externalsRunning.has(SECOND_EXTERNAL_SERIAL)
        ? ["secondExternal"]
        : []),
      ...sampleActions(),
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
        const next = processes.has(serial(index)) ? "validate" : "qemu";
        return [`${next}:${index}`, ...(shape.earlyExit ? [`exit:${index}`] : [])];
      }),
    ],
    run: async (action) => {
      const [name, index] = action.split(":");
      actions[name](Number(index));
      await settle();
    },
  };
}

interface Slices {
  depth: number;
  orders: number[];
}

type PinnedShape = [Shape, number, Slices?];

const BASE_SHAPE: Shape = { limit: 1, admitters: 2, startup: "validation" };
const BASE_WALKS = [
  ["iOS", iosScenario, 336, { depth: 3, orders: [54, 90, 72, 60, 60] }],
  ["Android", androidScenario, 648, { depth: 4, orders: [58, 70, 68, 90, 78, 78, 38, 50, 60, 58] }],
] as const;

/** Total and measured per-slice order pins: changing a count means the walk changed. */
const EXTERNAL_SHAPES: PinnedShape[] = [
  [
    { limit: 1, admitters: 1, external: "any", startup: "none" },
    1199,
    { depth: 4, orders: [137, 126, 185, 143, 173, 87, 113, 106, 129] },
  ],
  [
    { limit: 1, admitters: 2, external: "lists", noReader: true, startup: "validation" },
    498,
    { depth: 3, orders: [156, 126, 123, 93] },
  ],
  [
    { limit: 1, admitters: 2, external: "exits", noReader: true, startup: "validation" },
    519,
    { depth: 4, orders: [139, 138, 133, 109] },
  ],
  [
    { limit: 2, admitters: 2, external: "lists", noReader: true, startup: "none" },
    1103,
    { depth: 4, orders: [110, 158, 174, 198, 127, 78, 90, 168] },
  ],
  [
    { limit: 2, admitters: 2, external: "exits", noReader: true, startup: "none" },
    1193,
    { depth: 4, orders: [135, 144, 145, 110, 131, 147, 103, 137, 141] },
  ],
  // The smallest shape where a launcher that is not a qemu process yet could be taken for the
  // external emulator's process: both run, and the second admission has to be refused.
  [
    { limit: 2, admitters: 2, external: "stays", noReader: true, startup: "launcher" },
    1137,
    { depth: 4, orders: [70, 175, 140, 144, 111, 140, 146, 144, 8, 39, 8, 12] },
  ],
];

const STARTUP_SHAPES: PinnedShape[] = [
  // The smallest shape with the double count: one boot spawned and still validating, one slot
  // free, and a second admission that has to be granted.
  [
    { limit: 2, admitters: 2, noReader: true, startup: "all" },
    462,
    { depth: 3, orders: [126, 126, 126, 84] },
  ],
  [
    { limit: 2, admitters: 2, noReader: true, earlyExit: true, startup: "validation" },
    287,
    { depth: 2, orders: [160, 127] },
  ],
  [
    { limit: 2, admitters: 2, noReader: true, earlyExit: true, startup: "launcher" },
    287,
    { depth: 2, orders: [160, 127] },
  ],
  [
    { limit: 1, admitters: 2, earlyExit: true, startup: "validation" },
    1056,
    { depth: 4, orders: [162, 188, 119, 146, 126, 169, 146] },
  ],
];

/** `count` boots are admitted and none has spawned, beside an unlisted external emulator if any. */
function admittedBoots(count: number, external: "external" | "alone"): string[] {
  return [
    ...(external === "external" ? ["externalStart"] : []),
    ...Array.from({ length: count }, (_, index) => [
      `start:${index}`,
      `ps:${index}`,
      `adb:${index}`,
      `end:${index}`,
    ]).flat(),
  ];
}

/** A split-read shape that starts with boots already admitted beside a running external emulator. */
function besideExternal(
  limit: number,
  shape: Partial<Shape> & Pick<Shape, "external" | "startup">,
): Shape {
  return {
    limit,
    admitters: limit,
    noReader: true,
    reads: "split",
    prefix: admittedBoots(limit - 1, "external"),
    ...shape,
  };
}

/**
 * Shapes whose samples read adb and the process table in separate steps (#11588), with the
 * total and per-slice orders each one walks. Larger ones hold too (checked by hand) and take too long to keep: one
 * admission, a reader and an external emulator ("any") against a limit of one (158,380 orders),
 * the hole's shape beside a reader (12,600), two admissions with no external emulator from an
 * empty fleet against a limit of two (6,864), the hole's shape with every startup step, early
 * exits and the external emulator's whole life (41,216), and a limit of three with launcher
 * steps and the external emulator being listed (92,400).
 */
const SPLIT_READ_SHAPES: PinnedShape[] = [
  [
    { limit: 1, admitters: 1, external: "any", noReader: true, startup: "none", reads: "split" },
    155,
  ],
  [
    { limit: 1, admitters: 2, noReader: true, startup: "none", reads: "split" },
    700,
    { depth: 3, orders: [184, 166, 184, 166] },
  ],
  // The smallest shape with the hole: the external emulator and one admitted boot fill a limit of
  // two, the boot spawns and is listed between the second sample's two reads, and the second
  // admission has to be refused.
  [besideExternal(2, { external: "stays", startup: "none" }), 30],
  // The boot's process may also show, or exit, between the two reads.
  [besideExternal(2, { external: "stays", earlyExit: true, startup: "launcher" }), 102],
  // The external emulator may be listed, or exit and free its slot, between the reads too.
  [besideExternal(2, { external: "lists", startup: "none" }), 210],
  [
    besideExternal(2, { external: "exits", startup: "none" }),
    285,
    { depth: 3, orders: [150, 135] },
  ],
  // The same hole one slot up: two admitted boots and the external emulator fill a limit of three.
  [
    besideExternal(3, { external: "stays", startup: "none" }),
    840,
    { depth: 4, orders: [160, 172, 170, 172, 166] },
  ],
  // No external emulator: a boot whose process shows, or that is listed, between the reads counts
  // once, and the free slot is granted.
  [
    {
      limit: 2,
      admitters: 2,
      noReader: true,
      startup: "validation",
      reads: "split",
      prefix: admittedBoots(1, "alone"),
    },
    240,
  ],
];

/**
 * Two external emulators, the second one started and listed at any point (#11588). The first
 * runs unlisted from the start, so a process table read before the second started and an adb
 * listing read after it show one emulator each.
 */
function twoExternals(shape: Pick<Shape, "limit" | "admitters" | "reads">): Shape {
  return {
    external: "stays",
    secondExternal: true,
    noReader: true,
    startup: "none",
    prefix: ["externalStart"],
    ...shape,
  };
}

/** Two admissions from only the first external emulator against a limit of three hold too (4,200 orders, checked by hand). */
const TWO_EXTERNAL_SHAPES: PinnedShape[] = [
  // The smallest shape: both external emulators fill a limit of two and the boot is refused.
  [twoExternals({ limit: 2, admitters: 1, reads: "adbFirst" }), 7],
  // One slot up, beside a boot admitted before the second external emulator starts.
  [
    {
      ...twoExternals({ limit: 3, admitters: 2, reads: "adbFirst" }),
      prefix: admittedBoots(1, "external"),
    },
    207,
  ],
];

function describeShape(shape: Shape): string {
  const alreadyAdmitted = (shape.prefix ?? []).filter((step) => step.startsWith("start:")).length;
  const parts = [
    `${shape.admitters} admission(s)`,
    ...(shape.noReader ? [] : ["a reader"]),
    ...(shape.external ? [`an external emulator (${shape.external})`] : []),
    ...(shape.earlyExit ? ["emulators that may exit during startup"] : []),
    ...(shape.startup === "none" ? [] : [`startup steps (${shape.startup})`]),
    ...(shape.secondExternal ? ["a second external emulator"] : []),
    ...(shape.reads === "split" ? ["adb and ps read in separate steps"] : []),
    ...(shape.reads === "adbFirst" ? ["adb read in a step before ps"] : []),
    ...(alreadyAdmitted > 0 ? [`${alreadyAdmitted} already admitted`] : []),
  ];
  return `Android: ${parts.join(", ")} against a limit of ${shape.limit}`;
}

async function expectEveryOrderHolds(
  create: () => Scenario,
  limit: number,
  orders: number,
  prefix: string[] = [],
  slice?: { depth: number; part: number; parts: number },
): Promise<void> {
  const result = slice
    ? await exploreSlice(create, limit, prefix, slice.depth, slice.part, slice.parts)
    : await exploreEveryOrder(create, limit, prefix);

  // The first few orders are enough to reproduce; hundreds would drown the report.
  expect(result.overLimit.slice(0, 5)).toEqual([]);
  // No refusal without cause either: a slot nothing holds is granted.
  expect(result.wrongFinalCount.slice(0, 5)).toEqual([]);
  expect(result.unexpected.slice(0, 5)).toEqual([]);
  expect(result.orders).toBe(orders);
}

/** Small walks keep their original test; larger walks pin every measured slice separately. */
function testWalk(
  name: string,
  create: () => Scenario,
  shape: Shape,
  total: number,
  slices?: Slices,
): void {
  if (!slices) {
    test(name, async () => {
      await expectEveryOrderHolds(create, shape.limit, total, shape.prefix);
    });
    return;
  }
  const { depth, orders } = slices;
  for (const [part, count] of orders.entries()) {
    test(`${name}, orders part ${part + 1} of ${orders.length}`, async () => {
      await expectEveryOrderHolds(create, shape.limit, count, shape.prefix, {
        depth,
        part,
        parts: orders.length,
      });
    });
  }
}

describe("boot capacity gates never admit past the limit in any interleaving (#11537)", () => {
  // Three admissions against a limit of two also hold (40,492 iOS and 73,260 Android orders,
  // checked by hand), but take seconds; this shape already contains every failing order found.
  for (const [platform, create, orders, slices] of BASE_WALKS) {
    testWalk(
      `${platform}: two admissions and a reader against a limit of one`,
      () => create(BASE_SHAPE),
      BASE_SHAPE,
      orders,
      { depth: slices.depth, orders: [...slices.orders] },
    );
  }
});

describe("an external emulator adb has not listed takes a slot in any interleaving (#11564)", () => {
  // The smallest shape with the hole: a limit of two holds the external emulator and one admitted
  // boot that has not spawned, and the second admission has to be refused.
  for (const [shape, orders, slices] of EXTERNAL_SHAPES) {
    testWalk(describeShape(shape), () => androidScenario(shape), shape, orders, slices);
  }
});

describe("a spawned emulator still validating its startup takes one slot in any interleaving (#11564)", () => {
  for (const [shape, orders, slices] of STARTUP_SHAPES) {
    testWalk(describeShape(shape), () => androidScenario(shape), shape, orders, slices);
  }
});

describe("a boot listed after the process table was read still counts beside an external emulator (#11588)", () => {
  for (const [shape, orders, slices] of SPLIT_READ_SHAPES) {
    testWalk(describeShape(shape), () => androidScenario(shape), shape, orders, slices);
  }
});

describe("two external emulators, one in each read, are two when adb is read first (#11588)", () => {
  for (const [shape, orders, slices] of TWO_EXTERNAL_SHAPES) {
    testWalk(describeShape(shape), () => androidScenario(shape), shape, orders, slices);
  }

  // Why the source orders its reads: with the process table read first, no count over the two
  // listings can tell one emulator seen twice from two emulators seen once each.
  test("the same fleet is admitted past the limit when the process table may be read first", async () => {
    const shape = twoExternals({ limit: 2, admitters: 1, reads: "split" });

    const result = await exploreEveryOrder(() => androidScenario(shape), shape.limit, shape.prefix);

    expect(result.overLimit).toContain(
      "externalStart > start:0 > ps:0 > secondExternal > adb:0 > end:0",
    );
  });
});

describe("interleaving slices preserve the exhaustive walk", () => {
  test("every entry's slice pins sum to its unchanged total", () => {
    for (const [, , total, slices] of BASE_WALKS) {
      expect(slices.orders.reduce((sum, count) => sum + count, 0)).toBe(total);
    }
    for (const [, total, slices] of [
      ...EXTERNAL_SHAPES,
      ...STARTUP_SHAPES,
      ...SPLIT_READ_SHAPES,
      ...TWO_EXTERNAL_SHAPES,
    ]) {
      expect((slices?.orders ?? [total]).reduce((sum, count) => sum + count, 0)).toBe(total);
    }
  });

  test("slicing a holding split-read shape preserves all orders without violations", async () => {
    const [shape, total] = SPLIT_READ_SHAPES[0];
    const create = () => androidScenario(shape);
    const unsliced = await exploreEveryOrder(create, shape.limit, shape.prefix);
    const slices = [];
    for (let part = 0; part < 3; part++) {
      slices.push(await exploreSlice(create, shape.limit, shape.prefix ?? [], 2, part, 3));
    }
    expect(unsliced.orders).toBe(total);
    expect(slices.reduce((sum, slice) => sum + slice.orders, 0)).toBe(unsliced.orders);
    expect(unsliced.overLimit).toEqual([]);
    expect(slices.flatMap((slice) => slice.overLimit)).toEqual([]);
  });

  test("slicing preserves every order and interior violation of the failing split-read shape", async () => {
    const shape = twoExternals({ limit: 2, admitters: 1, reads: "split" });
    const create = () => androidScenario(shape);
    const unsliced = await exploreEveryOrder(create, shape.limit, shape.prefix);
    const slices = [];
    // Past the violating admission: it must become a root rather than disappear on expansion.
    for (let part = 0; part < 3; part++) {
      slices.push(await exploreSlice(create, shape.limit, shape.prefix ?? [], 6, part, 3));
    }
    expect(slices.reduce((sum, slice) => sum + slice.orders, 0)).toBe(unsliced.orders);
    expect(slices.flatMap((slice) => slice.overLimit).sort()).toEqual(unsliced.overLimit.sort());
  });
});
