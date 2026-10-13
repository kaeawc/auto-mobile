import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  RECLAIM_GUARD_ABANDON_AGE_MS,
  acquireExclusiveLockSteps,
  releaseExclusiveLockSteps,
  tryAcquireExclusiveLock,
  readExclusiveLockContent,
  readLockOwnerPid,
  formatLockContent,
  type ExclusiveLockOptions,
  type LockStep,
} from "../../src/utils/fileLock";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { SeededRandom } from "../fakes/SeededRandom";
import { FakeTimer } from "../fakes/FakeTimer";

export const PATH = "/locks/resource.lock";
export const NOW = 20_000;
export const OLD = "99\nstale\n\nold-generation";
type Steps<T> = Generator<LockStep, T, void>;

/** A pending descriptor names the operation the NEXT advance will execute. */
export class Racer<T> {
  pending: IteratorResult<LockStep, T>;
  readonly trace: LockStep[] = [];

  constructor(readonly steps: Steps<T>) {
    this.pending = steps.next();
  }

  advance(): void {
    if (!this.pending.done) {
      this.trace.push(this.pending.value);
      this.pending = this.steps.next();
    }
  }

  finish(check: () => void = () => {}): T {
    for (let count = 0; !this.pending.done; count++) {
      if (count > 1024) {
        throw new Error("Unbounded lock attempt");
      }
      this.advance();
      check();
    }
    return this.pending.value;
  }

  until(predicate: (step: LockStep) => boolean): void {
    for (let count = 0; !this.pending.done && !predicate(this.pending.value); count++) {
      if (count > 1024) {
        throw new Error("Missing requested step");
      }
      this.advance();
    }
    expect(this.pending.done).toBe(false);
  }
}

export function fixture(raw = OLD) {
  const clock = new FakeTimer();
  clock.advanceTime(NOW);
  const fs = new FakeLockFileSystem(() => clock.now());
  fs.seed(PATH, raw, 0);
  const live = new Set([101, 202, 303, 404]);
  const idGenerator = new FakeIdGenerator();
  const options = (pid: number): ExclusiveLockOptions => ({
    pid,
    ownerToken: `owner-${pid}`,
    fileSystem: fs,
    idGenerator,
    now: () => clock.now(),
    isProcessRunning: (owner) => live.has(owner),
    ownerGeneration: {
      current: () => "current-generation",
      compare: (_owner, generation) => (generation === "old-generation" ? "different" : "same"),
    },
  });
  const acquire = (pid: number) => new Racer(acquireExclusiveLockSteps(PATH, options(pid)));
  return { fs, live, options, acquire, clock };
}

export function pauseAfterJudgement(racer: Racer<boolean>): void {
  racer.until((step) => step.op === "writeFile" && step.path.includes(".reclaim."));
}

export function exactHolder(fs: FakeLockFileSystem, pid: number): void {
  expect(fs.exists(PATH)).toBe(true);
  expect(fs.readText(PATH)).toBe(
    formatLockContent(pid, `owner-${pid}`, undefined, "current-generation"),
  );
  expect(readExclusiveLockContent(PATH, fs)?.pid).toBe(pid);
  expect(readLockOwnerPid(PATH, () => true, undefined, fs)).toBe(pid);
}

export function prefix(fs: FakeLockFileSystem): string {
  const { ino, mtimeMs } = fs.stat(PATH);
  const hash = createHash("sha256").update(fs.readText(PATH)).digest("hex").slice(0, 32);
  return `${PATH}.reclaim.${ino}.${mtimeMs}.${hash}`;
}

export interface Actor {
  pid: number;
  options: ExclusiveLockOptions;
  racer: Racer<boolean | void>;
  phase: "acquiring" | "holding" | "releasing" | "finished" | "crashed";
  attempts: number;
}

export function assertBelievers(fs: FakeLockFileSystem, actors: Actor[]): void {
  const believers = actors.filter((actor) => actor.phase === "holding");
  expect(believers.length).toBeLessThanOrEqual(1);
  for (const actor of believers) {
    exactHolder(fs, actor.pid);
  }
}

export function advanceActor(actor: Actor, f: ReturnType<typeof fixture>): void {
  if (actor.phase === "holding") {
    // Release relinquishes belief at invocation; its rename is the owner's voluntary removal.
    actor.phase = "releasing";
    actor.racer = new Racer(releaseExclusiveLockSteps(PATH, actor.pid, `owner-${actor.pid}`, f.fs));
  }
  actor.racer.advance();
  if (!actor.racer.pending.done) {
    return;
  }
  if (actor.phase === "releasing") {
    actor.phase = "finished";
  } else if (actor.racer.pending.value) {
    actor.phase = "holding";
  } else if (++actor.attempts < 6) {
    actor.racer = new Racer(acquireExclusiveLockSteps(PATH, actor.options));
  } else {
    actor.phase = "finished";
  }
}

function originalStale(seed: number): string {
  const kind = seed % 4;
  return kind === 0 ? "" : kind === 3 ? "101\nprevious-instance" : OLD;
}

export function runSchedule(seed: number): void {
  const kind = seed % 4;
  const raw = originalStale(seed);
  const f = fixture(raw);
  if (kind === 2) {
    f.live.add(99); // Live PID with provably different generation.
  }
  const random = new SeededRandom(seed);
  const actors: Actor[] = [101, 202, 303, ...(seed % 3 === 0 ? [404] : [])].map((pid) => {
    const options = { ...f.options(pid), reclaimOwnPid: kind === 3 && pid === 101 };
    return {
      pid,
      options,
      racer: new Racer(acquireExclusiveLockSteps(PATH, options)),
      phase: "acquiring",
      attempts: 0,
    };
  });
  const trace: string[] = [];
  if (seed % 3 === 0 && kind !== 3) {
    // A crashed reclaimer's PID is recycled by a live process with no generation evidence.
    const options: ExclusiveLockOptions = {
      ...f.options(707),
      ownerGeneration: { current: () => undefined, compare: () => "different" },
    };
    const racer = new Racer(acquireExclusiveLockSteps(PATH, options));
    const guard = `${prefix(f.fs)}.0`;
    racer.until((step) => step.op === "stat" && step.path === PATH && f.fs.exists(guard));
    actors.push({ pid: 707, options, racer, phase: "crashed", attempts: 0 });
    f.live.add(707);
    trace.push("707 CRASHED RECLAIMER, PID REUSED WITHOUT GENERATION EVIDENCE");
  }
  // Start every stale observer before any removal; a fourth actor is also fresh
  // in rows that insert it after the original stale instance has gone.
  for (const actor of actors.slice(0, 3)) {
    if (kind !== 3 || actor.pid === 101) {
      pauseAfterJudgement(actor.racer as Racer<boolean>);
    }
  }
  for (const actor of actors) {
    trace.push(...actor.racer.trace.map((step) => `${actor.pid} ${JSON.stringify(step)}`));
  }
  try {
    executeSchedule({ seed, random, f, actors, trace });
  } catch (error) {
    throw new Error(`seed=${seed}\n${trace.join("\n")}`, { cause: error });
  }
}

function executeSchedule(context: {
  seed: number;
  random: SeededRandom;
  f: ReturnType<typeof fixture>;
  actors: Actor[];
  trace: string[];
}): void {
  const { seed, random, f, actors, trace } = context;
  let freshAdded = false;
  for (let count = 0; count < 1200; count++) {
    if (!freshAdded && (!f.fs.exists(PATH) || f.fs.readText(PATH) !== originalStale(seed))) {
      f.live.add(606);
      actors.push({
        pid: 606,
        options: f.options(606),
        racer: f.acquire(606),
        phase: "acquiring",
        attempts: 0,
      });
      freshAdded = true;
      trace.push("606 FRESH ACTOR");
    }
    const active = actors.filter(
      (actor) => actor.phase !== "finished" && actor.phase !== "crashed",
    );
    if (!active.length) {
      break;
    }
    const actor = random.pick(active);
    const step = actor.racer.pending.done
      ? "voluntary-release"
      : JSON.stringify(actor.racer.pending.value);
    trace.push(`${actor.pid} ${step}`);
    if (seed % 2 === 1 && random.next() < 0.025) {
      actor.phase = "crashed";
      f.live.delete(actor.pid);
      trace.push(`${actor.pid} CRASH`);
    } else {
      checkMutation(actor, f, actors);
    }
    assertBelievers(f.fs, actors);
  }
  expect(actors.every((actor) => actor.phase === "finished" || actor.phase === "crashed")).toBe(
    true,
  );
  if (actors.every((actor) => actor.phase !== "crashed")) {
    expect(f.fs.paths()).toEqual([]); // Every successful holder voluntarily released.
  }
  // (d) No stuck state: all actors have finished/crashed before aging abandoned guards.
  f.clock.advanceTime(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
  f.live.add(505);
  let acquired = false;
  for (let attempt = 0; attempt < 6 && !acquired; attempt++) {
    acquired = tryAcquireExclusiveLock(PATH, f.options(505));
  }
  expect(acquired).toBe(true);
  exactHolder(f.fs, 505);
}

export function checkMutation(actor: Actor, f: ReturnType<typeof fixture>, actors: Actor[]): void {
  const foreignBeliever = actors.some(
    (other) => other.pid !== actor.pid && other.phase === "holding",
  );
  const before = foreignBeliever ? f.fs.readText(PATH) : undefined;
  const start = f.fs.operations.length;
  advanceActor(actor, f);
  const operations = f.fs.operations.slice(start);
  if (before !== undefined) {
    expect(
      operations.some(
        (op) => op.path === PATH && ["rename", "unlink", "writeFile"].includes(op.op),
      ),
    ).toBe(false);
    expect(f.fs.readText(PATH)).toBe(before);
  }
}
