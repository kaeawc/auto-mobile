import { beforeAll, describe, expect, test } from "bun:test";
import {
  SessionManager,
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  type SessionDeviceAssigner,
  type SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
import type { SessionRowWriter } from "../../src/daemon/sessionRowWriter";
import { FileTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { fixedBackoff } from "../../src/utils/Backoff";
import { BusyRewritePersistence } from "../fakes/BusyRewritePersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { FaultPlan, type FaultKind } from "../fakes/FaultPlan";

const UUID = "fault-uuid";
const DEVICE = "fake-android";
const FILE = "/in-memory/w2/intents.jsonl";
const WINDOW = 1_000_000_000;
const CRASH = Symbol("process-discarded");
const KINDS: FaultKind[] = ["reject", "hang-until-released", "delay", "crash-after"];
const SCENARIOS = [
  "terminal release",
  "non-terminal release",
  "terminal superseded by rebind and lift",
  "forced stuck release",
  "create after lift with parked terminal",
  "shutdown drain with failing write",
] as const;
type Scenario = (typeof SCENARIOS)[number];
interface Result {
  points: string[];
  violations: string[];
  triggered: boolean;
}
const flush = async () => {
  for (let turn = 0; turn < 100; turn++) {
    await Promise.resolve();
  }
};

function lift(manager: SessionManager): void {
  const method = Reflect.get(manager, "liftTerminalFence") as (uuid: string) => void;
  method.call(manager, UUID);
}

function writerOf(manager: SessionManager): SessionRowWriter {
  return Reflect.get(manager, "rowWriter") as SessionRowWriter;
}

class Run {
  readonly timer = new FakeTimer();
  readonly files = new FakeTerminalReleaseJournalFileSystem();
  readonly plan: FaultPlan;
  readonly violations: string[] = [];
  readonly effects: string[] = [];
  manager: SessionManager;
  lastGeneration = 0;
  private managerGeneration = 0;
  private unpark?: () => void;
  private parked?: ReturnType<typeof Promise.withResolvers<void>>;

  constructor(
    at?: number,
    kind?: FaultKind,
    readonly persistence = new FakeDeviceSessionPersistence(),
  ) {
    this.plan = new FaultPlan(this.timer, at, kind, (fault, resume) => {
      // A synchronous FS wait freezes this process, including JS deadlines and callbacks.
      this.timer.setCurrentTime(
        this.timer.now() + (fault === "delay" ? 7 : SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1),
      );
      resume();
    });
    this.manager = this.newManager();
    const mark = this.persistence.markReleased.bind(this.persistence);
    this.persistence.markReleased = (...args) => {
      this.effects.push(`attempt:${args[3]}`);
      return mark(...args);
    };
    const upsert = this.persistence.upsertActiveSession.bind(this.persistence);
    this.persistence.upsertActiveSession = async (...args) => {
      const generation = await upsert(...args);
      this.lastGeneration = generation;
      return generation;
    };
  }

  newManager(): SessionManager {
    const manager = new SessionManager(this.timer, this.persistence, {
      barrier: () => new FakeDbWriteBarrier(),
    });
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId(`fault-daemon-${++this.managerGeneration}`);
    manager.setTerminalReleaseRetryBackoff(fixedBackoff(11));
    manager.setSupersededRowReassertBackoff(fixedBackoff(13));
    const journal = new FileTerminalReleaseJournal(FILE, this.files);
    const record = journal.record.bind(journal);
    journal.record = (intent) => {
      const durability = record(intent);
      this.effects.push(`record:${intent.reason}:${durability}`);
      return durability;
    };
    manager.attachTerminalReleaseJournal(journal);
    manager.onSessionRelease((_id, _device, reason) => this.effects.push(`notice:${reason}`));
    return manager;
  }

  create() {
    return this.manager.createSession(UUID, DEVICE, "android", WINDOW, WINDOW, "Fake_AVD");
  }

  /** Drive the manager's original promises without introducing real sleeps. */
  async settle(work: Promise<unknown>): Promise<unknown> {
    let done = false;
    let failure: unknown;
    let result: unknown;
    void work.then(
      (value) => {
        done = true;
        result = value;
      },
      (error: unknown) => {
        done = true;
        failure = error;
      },
    );
    for (let turn = 0; turn < 100; turn++) {
      await flush();
      if (this.plan.crashed) {
        throw CRASH;
      }
      if (done) {
        if (failure) {
          throw failure;
        }
        return result;
      }
      const next = this.timer.getMsUntilNextDueEvent();
      await this.timer.advanceTimeAsync(next ?? SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1);
      this.plan.release();
    }
    throw new Error("simulation failed to settle");
  }

  async complete(operation: () => Promise<unknown>): Promise<void> {
    try {
      await this.settle(operation());
    } catch (error) {
      if (error === CRASH) {
        throw error;
      }
      // One injected rejection can surface to the caller; retry its public operation once.
      await this.settle(operation());
    }
  }

  parkTerminal(): void {
    this.parked = Promise.withResolvers<void>();
    const mark = this.persistence.markReleased.bind(this.persistence);
    this.unpark = () => {
      this.persistence.markReleased = mark;
    };
    let first = true;
    this.persistence.markReleased = async (...args) => {
      this.effects.push(`attempt:${args[3]}`);
      if (first) {
        first = false;
        await this.parked!.promise;
      }
      if (this.plan.crashed) {
        await new Promise<void>(() => {});
      }
      await mark(...args);
    };
  }

  async supersede(recreate: boolean): Promise<void> {
    this.parkTerminal();
    let current = true;
    const release = recreate
      ? this.manager.releaseSession(UUID, "explicit-release")
      : this.manager.releaseSessionUnlessSuperseded(
          UUID,
          `device-disconnected:${DEVICE}`,
          () => current,
        );
    // The gate parks the injected statement before its synchronous SQLite-equivalent effect.
    await flush();
    current = false;
    await this.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1);
    await this.complete(() => release);
    if (recreate) {
      lift(this.manager);
      await this.complete(() => this.create());
    } else {
      await this.complete(() => this.manager.rebindSession(UUID, "fake-rebound", "android"));
    }
    this.parked!.resolve();
    await flush();
  }

  async force(reason = "heartbeat-timeout"): Promise<void> {
    const teardown = Promise.withResolvers<Promise<void>[]>();
    Reflect.set(this.manager, "drainReleaseTeardown", () => teardown.promise);
    const release = this.manager.releaseSession(UUID, reason);
    await flush();
    if (!this.manager.forceStuckRelease(UUID)) {
      throw new Error("forced scenario never entered a release");
    }
    teardown.resolve([]);
    await this.complete(() => release);
  }

  async shutdown(): Promise<void> {
    this.persistence.failure = "release";
    await this.force("explicit-release");
    await flush();
    // The scenario's first failure leaves an intent; drain gets one immediate retry.
    this.persistence.failure = null;
    await this.settle(this.manager.drainReleasePromises(30_000));
  }

  async restart(): Promise<void> {
    this.manager.stopCleanupTimer();
    this.persistence.faultPlan = undefined;
    this.persistence.failure = null;
    this.files.faultPlan = undefined;
    this.unpark?.();
    this.parked?.resolve();
    this.manager = this.newManager();
    const pool: SessionDeviceAssigner = {
      assignDeviceToSession: async (id, _platform, target) =>
        (
          await this.manager.createSession(
            id,
            target?.deviceId ?? DEVICE,
            "android",
            WINDOW,
            WINDOW,
            target?.stableDeviceId ?? "Fake_AVD",
            target?.liveness,
            target?.initialOwnership,
          )
        ).assignedDevice,
    };
    const before = await this.persistence.getSession(UUID);
    const intent = new FileTerminalReleaseJournal(FILE, this.files).loadUnconfirmed()[0];
    if (!intent && before?.status === "active") {
      // Bootstrap marks a dead daemon's active rows recoverable before manager rehydration.
      await this.persistence.markReleased(UUID, "released", this.timer.now(), "daemon-restart");
    }
    await this.manager.rehydratePersistedSessions(pool);
    this.manager.stopCleanupTimer();
  }

  async oracle(scenario: Scenario, crashed: boolean): Promise<void> {
    this.persistence.faultPlan = undefined;
    this.files.faultPlan = undefined;
    const journal = new FileTerminalReleaseJournal(FILE, this.files);
    const intent = journal.loadUnconfirmed().find((entry) => entry.sessionId === UUID);
    if (crashed || intent) {
      // A crash oracle is the committed disk prefix, never the remainder of the scenario.
      const before = await this.persistence.getSession(UUID);
      const expected = intent?.reason ?? before?.release_reason;
      await this.restart();
      const row = await this.persistence.getSession(UUID);
      if (expected && row?.release_reason !== expected) {
        this.violations.push(`restart lost ${expected}: ${row?.release_reason}`);
      }
      if (intent && this.manager.findSession(UUID)) {
        this.violations.push("restart revived a terminal UUID");
      }
      if (crashed) {
        if (
          !expected &&
          (row?.status !== "active" ||
            row.release_reason !== null ||
            !this.manager.findSession(UUID) ||
            row.stable_identity_generation !== this.lastGeneration)
        ) {
          this.violations.push(
            `crash lost the live disk prefix: ${row?.status}/${row?.release_reason}`,
          );
        }
        if (expected && this.manager.findSession(UUID)) {
          this.violations.push(`crash revived ended prefix ${expected}`);
        }
        return;
      }
    }
    const row = await this.persistence.getSession(UUID);
    const live = this.manager.findSession(UUID);
    const liveScenario = scenario.includes("superseded") || scenario.includes("create after");
    if (liveScenario) {
      if (
        !live ||
        row?.status !== "active" ||
        row.release_reason !== null ||
        row.stable_identity_generation !== this.lastGeneration
      ) {
        this.violations.push(
          `live oracle: ${row?.status}/${row?.release_reason}/${row?.stable_identity_generation}, last=${this.lastGeneration}`,
        );
      }
    } else {
      const reason =
        scenario === "non-terminal release"
          ? "plan-auto-release"
          : scenario === "forced stuck release"
            ? "heartbeat-timeout"
            : "explicit-release";
      if (live || row?.release_reason !== reason || row.status === "active") {
        this.violations.push(
          `ended oracle expected ${reason}: ${row?.status}/${row?.release_reason}`,
        );
      }
    }
    if (scenario !== "forced stuck release" && scenario !== "shutdown drain with failing write") {
      const notice = this.effects.findIndex((effect) =>
        effect.startsWith("notice:explicit-release"),
      );
      if (notice >= 0) {
        const record = this.effects.findIndex((effect) =>
          effect.startsWith("record:explicit-release:"),
        );
        const attempt = this.effects.indexOf("attempt:explicit-release");
        if (record < 0 || attempt < record || notice < attempt) {
          this.violations.push(`write-first/journal ordering: ${this.effects.join(",")}`);
        }
      }
    }
    if (this.timer.getSleepHistory().length) {
      this.violations.push("used sleep instead of the injected timer");
    }
  }
}

async function simulate(scenario: Scenario, at?: number, kind?: FaultKind): Promise<Result> {
  const run = new Run(at, kind);
  await run.create();
  run.persistence.faultPlan = run.plan;
  run.files.faultPlan = run.plan;
  let crashed = false;
  try {
    await run.complete(() => run.manager.getOrCreateSession(UUID));
    switch (scenario) {
      case "terminal release":
        await run.complete(() => run.manager.releaseSession(UUID, "explicit-release"));
        break;
      case "non-terminal release":
        await run.complete(() => run.manager.releaseSession(UUID, "plan-auto-release"));
        break;
      case "terminal superseded by rebind and lift":
        await run.supersede(false);
        break;
      case "create after lift with parked terminal":
        await run.supersede(true);
        break;
      case "forced stuck release":
        await run.force();
        break;
      case "shutdown drain with failing write":
        await run.shutdown();
        break;
    }
    run.plan.release();
    await run.settle(run.manager.drainReleasePromises(30_000));
    await run.timer.advanceTimeAsync(60_000);
    await flush();
    await run.settle(writerOf(run.manager).drain());
  } catch (error) {
    crashed = error === CRASH;
    if (!crashed) {
      run.violations.push(`scenario: ${String(error)}`);
    }
  }
  await run.oracle(scenario, crashed);
  run.manager.stopCleanupTimer();
  return { points: run.plan.points, violations: run.violations, triggered: run.plan.triggered };
}

// Agreement-test pattern: the simulation matrix is outside the 100ms per-test budget.
const results = new Map<string, Result>();
const counts = new Map<Scenario, number>();
beforeAll(async () => {
  for (const scenario of SCENARIOS) {
    const dry = await simulate(scenario);
    results.set(`${scenario}/dry`, dry);
    counts.set(scenario, dry.points.length * KINDS.length);
    for (let k = 1; k <= dry.points.length; k++) {
      for (const kind of KINDS) {
        results.set(`${scenario}/${k}/${kind}`, await simulate(scenario, k, kind));
      }
    }
    console.info(
      `Fault matrix: ${scenario}: ${dry.points.length} points, ${counts.get(scenario)} cases`,
    );
  }
});

describe("SessionRowWriter fault injection", () => {
  for (const scenario of SCENARIOS) {
    test(scenario, () => {
      const cases = Array.from(results.entries()).filter(([key]) => key.startsWith(`${scenario}/`));
      expect(cases.length).toBe(counts.get(scenario)! + 1);
      const failures = cases.flatMap(([key, result]) => [
        ...result.violations.map((violation) => `${key}: ${violation}`),
        ...(key.endsWith("/dry") || result.triggered ? [] : [`${key}: fault never reached`]),
      ]);
      expect(failures).toEqual([]);
    });
  }
});

function terminalSnapshot(): SessionReleaseSnapshot {
  return {
    sessionId: UUID,
    deviceId: DEVICE,
    terminal: true,
    releaseReason: "explicit-release",
    releasedAtMs: 0,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: WINDOW, ageMs: 0 },
  };
}

test("production generation guard refuses an uncaptured terminal desire after same UUID publish", async () => {
  const run = new Run();
  await run.create();
  await run.manager.releaseSession(UUID, "plan-auto-release");
  const snapshot = terminalSnapshot();
  const writer = writerOf(run.manager);
  writer.noteRelease(snapshot);
  run.manager["sessionSlots"].setTerminalSnapshot(UUID, snapshot);
  lift(run.manager);
  await run.create();
  const generation = run.lastGeneration;
  const persist = Reflect.get(run.manager, "persistSessionRelease") as (
    snapshot: SessionReleaseSnapshot,
  ) => Promise<boolean>;
  // This synthetic snapshot deliberately has no captured SQL generation: the in-process
  // desire/live guard must refuse it, including the manager's forced/rollback adapter path.
  expect(await persist.call(run.manager, snapshot)).toBe(true);
  expect(await run.persistence.getSession(UUID)).toMatchObject({
    status: "active",
    release_reason: null,
    stable_identity_generation: generation,
  });
  expect(new FileTerminalReleaseJournal(FILE, run.files).loadUnconfirmed()).toEqual([]);
  run.manager.stopCleanupTimer();
});

test("create after lift synchronously cancels its parked terminal desire and journal intent", async () => {
  const run = new Run();
  await run.create();
  await run.manager.releaseSession(UUID, "plan-auto-release");
  const snapshot = terminalSnapshot();
  const writer = writerOf(run.manager);
  const options = Promise.withResolvers<{}>();
  const journal = Reflect.get(run.manager, "terminalReleaseJournal") as FileTerminalReleaseJournal;
  journal.record({ sessionId: UUID, reason: snapshot.releaseReason, at: 0 });
  run.manager["sessionSlots"].setTerminalSnapshot(UUID, snapshot);
  // bun:sqlite cannot interleave mid-statement. Park at the retry/precondition seam and
  // exercise the real manager lift + publish boundary; the matrix also parks issued statements.
  writer.desire(UUID, { snapshot, terminal: true, precondition: () => options.promise });
  const outcome = writer.result(UUID);
  lift(run.manager);
  expect(writer.pendingSnapshot(UUID)).toBeUndefined();
  expect(await outcome).toBe(false);
  expect(journal.loadUnconfirmed()).toEqual([]);
  await run.create();
  const generation = run.lastGeneration;
  options.resolve({});
  await writer.settled(UUID);
  expect(await run.persistence.getSession(UUID)).toMatchObject({
    status: "active",
    release_reason: null,
    stable_identity_generation: generation,
  });
  run.manager.stopCleanupTimer();
});

test("a parked terminal statement cannot overwrite a recreated UUID generation", async () => {
  const run = new Run();
  await run.create();
  const plan = new FaultPlan(run.timer, 1, "hang-until-released");
  run.persistence.faultPlan = plan;
  const released = run.manager.releaseSession(UUID, "explicit-release");
  await flush();
  expect(plan.points).toEqual(["markReleased"]);
  // Production bun:sqlite is synchronous. The injected await parks immediately before the
  // statement's generation check, the only meaningful in-process park/retry boundary.
  await run.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1);
  await released;
  lift(run.manager);
  await run.create();
  const generation = run.lastGeneration;
  plan.release();
  await flush();
  expect(await run.manager.drainReleasePromises(30_000)).toBe(true);
  expect(await run.persistence.getSession(UUID)).toMatchObject({
    status: "active",
    release_reason: null,
    stable_identity_generation: generation,
  });
  run.manager.stopCleanupTimer();
});

test("a newer live generation during retry preparation refuses and settles the terminal desire", async () => {
  const run = new Run();
  await run.create();
  const writer = writerOf(run.manager);
  const snapshot = terminalSnapshot();
  const gate = Promise.withResolvers<void>();
  const journal = Reflect.get(run.manager, "terminalReleaseJournal") as FileTerminalReleaseJournal;
  journal.record({ sessionId: UUID, reason: snapshot.releaseReason, at: 0 });
  let refused = false;
  writer.onRowLanded((event) => {
    refused = event.refused;
    journal.resolve(event.snapshot.sessionId, event.snapshot.releaseReason);
  });
  run.persistence.failure = "release";
  writer.desire(UUID, {
    snapshot,
    terminal: true,
    initialPrecondition: {},
    precondition: () => Promise.resolve({}),
    beforeWrite: () => gate.promise,
  });
  await flush();
  run.persistence.failure = null;
  await run.timer.advanceTimeAsync(11);
  await flush();
  writer.noteLive(UUID);
  gate.resolve();
  await writer.settled(UUID);
  expect(refused).toBe(true);
  expect(writer.pending(UUID)).toBe(false);
  expect(journal.loadUnconfirmed()).toEqual([]);
  expect(await run.persistence.getSession(UUID)).toMatchObject({
    status: "active",
    release_reason: null,
  });
  run.manager.stopCleanupTimer();
});

test("a forced terminal fence carries its known SQL generation across lift and recreation", async () => {
  const run = new Run();
  await run.create();
  const plan = new FaultPlan(run.timer, 1, "hang-until-released");
  run.persistence.faultPlan = plan;
  await run.force("explicit-release");
  await flush();
  expect(plan.points).toEqual(["markReleased"]);
  await run.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1);
  await flush();
  lift(run.manager);
  await run.create();
  const generation = run.lastGeneration;
  plan.release();
  await flush();
  expect(await run.manager.drainReleasePromises(30_000)).toBe(true);
  expect(await run.persistence.getSession(UUID)).toMatchObject({
    status: "active",
    release_reason: null,
    stable_identity_generation: generation,
  });
  run.manager.stopCleanupTimer();
});

test("forced release survives rebind and a timed-out re-persist that fails late", async () => {
  const persistence = new BusyRewritePersistence();
  const run = new Run(undefined, undefined, persistence);
  await run.create();
  const rebindGate = Promise.withResolvers<void>();
  persistence.duringPlainUpsert = () => rebindGate.promise;
  const rebind = run.manager.rebindSession(UUID, "fake-rebound", "android");
  await flush();
  // A failed first forced write leaves F durable and current while the rebind lands active.
  persistence.failReleaseWrites = 1;
  run.manager.setTerminalReleaseRetryBackoff(fixedBackoff(20_000));
  const released = run.manager.releaseSession(UUID, "heartbeat-timeout");
  await flush();
  expect(run.manager.forceStuckRelease(UUID)?.stage).toBe("awaiting-rebind");
  await flush();
  expect(await persistence.getSession(UUID)).toMatchObject({ status: "active" });
  expect(run.manager["sessionSlots"].getTerminalSnapshot(UUID)?.releaseReason).toBe(
    "heartbeat-timeout",
  );
  run.manager.setTerminalReleaseRetryBackoff(fixedBackoff(11));
  const plan = new FaultPlan(run.timer, 2, "hang-until-released");
  // The in-flight rebind lands, then its compensating terminal re-persist is parked.
  persistence.faultPlan = plan;
  rebindGate.resolve();
  await flush();
  expect(plan.points).toEqual(["upsertActiveSession", "markReleased"]);
  await run.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1);
  await rebind;
  await released;
  persistence.failure = "release";
  plan.release();
  await flush();
  expect(new FileTerminalReleaseJournal(FILE, run.files).loadUnconfirmed()).toHaveLength(1);
  persistence.failure = null;
  await run.timer.advanceTimeAsync(11);
  await flush();
  expect(await run.manager.drainReleasePromises(30_000)).toBe(true);
  expect(await persistence.getSession(UUID)).toMatchObject({
    status: "expired",
    release_reason: "heartbeat-timeout",
  });
  expect(run.manager.findSession(UUID)).toBeNull();
  await run.restart();
  expect(run.manager.findSession(UUID)).toBeNull();
  expect(await persistence.getSession(UUID)).toMatchObject({ release_reason: "heartbeat-timeout" });
  expect(run.timer.getSleepHistory()).toEqual([]);
  run.manager.stopCleanupTimer();
});

test("uncaptured manager terminal fallback cannot overwrite a recreated UUID while parked", async () => {
  const persistence = new BusyRewritePersistence();
  const run = new Run(undefined, undefined, persistence);
  const session = await run.create();
  // Some manager release paths have no known generation. Remove only that optional capture;
  // keep the real release, deadline, fallback, lift and publish paths. This guard is in-process
  // scoped: synchronous bun:sqlite cannot pause mid-statement, so park the read after a miss.
  const generations = Reflect.get(run.manager, "persistedRowGenerations") as WeakMap<
    object,
    number
  >;
  generations.delete(session);
  persistence.refuseGuardedReleaseWrites = 1;
  const plan = new FaultPlan(run.timer, 1, "hang-until-released");
  persistence.faultPlan = plan;
  const released = run.manager.releaseSession(UUID, "explicit-release");
  await flush();
  expect(plan.points).toEqual(["getSession"]);
  const snapshot = run.manager["sessionSlots"].getTerminalSnapshot(UUID)!;
  const captures = Reflect.get(run.manager, "releaseRowGenerations") as WeakMap<object, number>;
  expect(captures.has(snapshot)).toBe(false);
  await run.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS + 1);
  await released;
  lift(run.manager);
  await run.create();
  const generation = run.lastGeneration;
  plan.release();
  await flush();
  expect(await run.manager.drainReleasePromises(30_000)).toBe(true);
  expect(await persistence.getSession(UUID)).toMatchObject({
    status: "active",
    release_reason: null,
    stable_identity_generation: generation,
  });
  expect(new FileTerminalReleaseJournal(FILE, run.files).loadUnconfirmed()).toEqual([]);
  expect(run.timer.getSleepHistory()).toEqual([]);
  run.manager.stopCleanupTimer();
});
