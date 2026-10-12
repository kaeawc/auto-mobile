import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acquireExclusiveLockSteps,
  releaseExclusiveLockSteps,
  tryAcquireExclusiveLock,
  readExclusiveLockContent,
  readLockOwnerPid,
  formatLockContent,
  type ExclusiveLockOptions,
  type LockStep,
} from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { SeededRandom } from "../fakes/SeededRandom";

const PATH = "/locks/resource.lock";
const NOW = 20_000;
const OLD = "99\nstale\n\nold-generation";
type Steps<T> = Generator<LockStep, T, void>;

/** A pending descriptor names the operation the NEXT advance will execute. */
class Racer<T> {
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
      if (count > 200) {
        throw new Error("Unbounded lock attempt");
      }
      this.advance();
      check();
    }
    return this.pending.value;
  }

  until(predicate: (step: LockStep) => boolean): void {
    for (let count = 0; !this.pending.done && !predicate(this.pending.value); count++) {
      if (count > 200) {
        throw new Error("Missing requested step");
      }
      this.advance();
    }
    expect(this.pending.done).toBe(false);
  }
}

function fixture(raw = OLD) {
  const fs = new FakeLockFileSystem(() => NOW);
  fs.seed(PATH, raw, 0);
  const live = new Set([101, 202, 303, 404]);
  const options = (pid: number): ExclusiveLockOptions => ({
    pid,
    ownerToken: `owner-${pid}`,
    fileSystem: fs,
    now: () => NOW,
    isProcessRunning: (owner) => live.has(owner),
    ownerGeneration: {
      current: () => "current-generation",
      compare: (_owner, generation) => (generation === "old-generation" ? "different" : "same"),
    },
  });
  const acquire = (pid: number) => new Racer(acquireExclusiveLockSteps(PATH, options(pid)));
  return { fs, live, options, acquire };
}

function pauseAfterJudgement(racer: Racer<boolean>): void {
  racer.until((step) => step.op === "writeFile" && step.path.includes(".reclaim."));
}

function exactHolder(fs: FakeLockFileSystem, pid: number): void {
  expect(fs.exists(PATH)).toBe(true);
  expect(fs.readText(PATH)).toBe(
    formatLockContent(pid, `owner-${pid}`, undefined, "current-generation"),
  );
  expect(readExclusiveLockContent(PATH, fs)?.pid).toBe(pid);
  expect(readLockOwnerPid(PATH, () => true, undefined, fs)).toBe(pid);
}

function traceForLateReclaimer(): LockStep[] {
  const f = fixture();
  const late = f.acquire(202);
  pauseAfterJudgement(late);
  f.acquire(101).finish();
  const start = late.trace.length;
  late.finish();
  return late.trace.slice(start);
}

// Clearly labelled pre-fix model: faithful old rename -> verify -> non-clobbering
// restore sequence. Atomic publication is used for the fresh actors so the old
// remover alone still demonstrates I1/I2/I4/I5's defect.
function* preFixReclaim(fs: FakeLockFileSystem, pid: number): Steps<boolean> {
  yield { op: "readText", path: PATH };
  const observed = fs.readText(PATH);
  const marker = `${PATH}.${pid}.reclaim`;
  yield { op: "rename", path: PATH };
  fs.rename(PATH, marker);
  yield { op: "readText", path: marker };
  if (fs.readText(marker) !== observed) {
    yield { op: "link", path: PATH };
    try {
      fs.link(marker, PATH);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    yield { op: "unlink", path: marker };
    fs.unlink(marker);
    return false;
  }
  yield { op: "unlink", path: marker };
  fs.unlink(marker);
  const tmp = `${PATH}.${pid}.old-model.tmp`;
  yield { op: "writeFile", path: tmp };
  fs.writeFile(tmp, formatLockContent(pid, `owner-${pid}`));
  yield { op: "link", path: PATH };
  fs.link(tmp, PATH);
  yield { op: "unlink", path: tmp };
  fs.unlink(tmp);
  return true;
}

test.each([OLD, ""])("pre-fix model I1/I2/I4/I5: late rename displaces a winner (%j)", (raw) => {
  const f = fixture(raw);
  const late = new Racer(preFixReclaim(f.fs, 202));
  late.until((step) => step.op === "rename");
  expect(f.acquire(101).finish()).toBe(true);
  late.advance();
  expect(f.fs.exists(PATH)).toBe(false); // I4; crashing here strands the live owner (I5).
  expect(f.acquire(303).finish()).toBe(true);
  expect(late.finish()).toBe(false);
  // Both successful live acquisitions returned true. Restore lost EEXIST arbitration.
  expect(f.fs.readText(PATH)).toContain("303\n");
  expect(f.live.has(101) && f.live.has(303)).toBe(true);
});

test.each([
  ["I1 dead-owner", OLD],
  ["I2 ownerless-old", ""],
])("%s: late reclaimer never displaces the winner for a third racer", (_title, raw) => {
  const f = fixture(raw);
  const late = f.acquire(202);
  pauseAfterJudgement(late);
  expect(f.acquire(101).finish()).toBe(true);
  const start = late.trace.length;
  expect(late.finish(() => exactHolder(f.fs, 101))).toBe(false);
  expect(late.trace.slice(start).some((step) => step.op === "rename")).toBe(false);
  expect(f.acquire(303).finish(() => exactHolder(f.fs, 101))).toBe(false);
  expect(f.fs.paths()).toEqual([PATH]);
});

test("I3 atomic publication: every step exposes absent or complete owner content", () => {
  const f = fixture();
  f.fs.unlink(PATH);
  const first = f.acquire(101);
  const second = f.acquire(202);
  const random = new SeededRandom(75);
  while (!first.pending.done || !second.pending.done) {
    random.pick([first, second].filter((racer) => !racer.pending.done)).advance();
    if (f.fs.exists(PATH)) {
      expect(
        [101, 202].map((pid) =>
          formatLockContent(pid, `owner-${pid}`, undefined, "current-generation"),
        ),
      ).toContain(f.fs.readText(PATH));
    }
  }
  expect(Number(first.pending.value) + Number(second.pending.value)).toBe(1);
  expect(f.fs.paths()).toEqual([PATH]);
  expect([...first.trace, ...second.trace].some((step) => step.op === "openExclusive")).toBe(false);
});

test("I4: holder's lock and probes remain exact after EVERY late-reclaimer step", () => {
  const f = fixture();
  const late = f.acquire(202);
  pauseAfterJudgement(late);
  expect(f.acquire(101).finish()).toBe(true);
  expect(late.finish(() => exactHolder(f.fs, 101))).toBe(false);
  expect(f.fs.paths()).toEqual([PATH]);
});

const lateSteps = traceForLateReclaimer();
test.each(lateSteps.map((_step, index) => index))(
  "I5: late reclaimer crashes before remaining step %d without stranding a live holder",
  (index) => {
    const f = fixture();
    const late = f.acquire(202);
    pauseAfterJudgement(late);
    expect(f.acquire(101).finish()).toBe(true);
    for (let step = 0; step < index; step++) {
      late.advance();
      exactHolder(f.fs, 101);
    }
    f.live.delete(202); // Abandon generator; do NOT run finally on a simulated crash.
    exactHolder(f.fs, 101);
    expect(f.acquire(303).finish(() => exactHolder(f.fs, 101))).toBe(false);
    new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs)).finish();
    expect(f.acquire(303).finish()).toBe(true); // Crash litter never blocks another instance.
  },
);

function loneSteps(): LockStep[] {
  const f = fixture();
  const racer = f.acquire(101);
  racer.finish();
  return racer.trace;
}
const reclaimSteps = loneSteps();
test.each(reclaimSteps.map((_step, index) => index))(
  "crash safety: lone reclaimer crashes before operation %d, retry can acquire",
  (index) => {
    const f = fixture();
    const reclaimer = f.acquire(101);
    for (let step = 0; step < index; step++) {
      reclaimer.advance();
      // A successful actor is not a believer until its attempt returns.
      expect(reclaimer.pending.done).toBe(false);
    }
    f.live.delete(101);
    let acquired = false;
    for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
      acquired = f.acquire(303).finish();
    }
    expect(acquired).toBe(true);
    exactHolder(f.fs, 303);
  },
);

function prefix(fs: FakeLockFileSystem): string {
  const { ino, mtimeMs } = fs.stat(PATH);
  const hash = createHash("sha256").update(fs.readText(PATH)).digest("hex").slice(0, 32);
  return `${PATH}.reclaim.${ino}.${mtimeMs}.${hash}`;
}

test.each([
  ["dead owner", "same", false, true],
  ["LIVE owner", "same", true, false],
  ["live PID, different generation", "different", true, true],
  ["unknown generation", "unknown", true, false],
] as const)("guard chain: %s at k=0", (_title, verdict, running, wins) => {
  const f = fixture();
  const guard = `${prefix(f.fs)}.0`;
  f.fs.seed(guard, "707\nguard-owner\n\nguard-generation");
  const racer = new Racer(
    acquireExclusiveLockSteps(PATH, {
      ...f.options(101),
      isProcessRunning: (pid) => (pid === 707 ? running : f.live.has(pid)),
      ownerGeneration: { current: () => "current-generation", compare: () => verdict },
    }),
  );
  expect(racer.finish()).toBe(wins);
  if (wins) {
    expect(
      racer.trace.some((step) => step.op === "link" && step.path === guard.replace(/0$/, "1")),
    ).toBe(true);
    expect(f.fs.paths()).toEqual([PATH]);
  } else {
    expect(f.fs.readText(PATH)).toBe(OLD);
    expect(racer.trace.some((step) => step.op === "rename")).toBe(false);
    expect(f.fs.paths()).toEqual([PATH, guard].sort());
  }
});

test.each(["", "garbage", "101\nother\n\ncurrent-generation"])(
  "guard chain: malformed or same-PID guard %j is LIVE",
  (content) => {
    const f = fixture();
    const guard = `${prefix(f.fs)}.0`;
    f.fs.seed(guard, content);
    expect(f.acquire(101).finish()).toBe(false);
    expect(f.fs.paths()).toEqual([PATH, guard].sort());
    expect(f.fs.readText(PATH)).toBe(OLD);
  },
);

test("guard chain: vanished guard counts as LIVE and leaves stale lock untouched", () => {
  const f = fixture();
  const guard = `${prefix(f.fs)}.0`;
  f.fs.seed(guard, "707");
  const racer = f.acquire(101);
  racer.until((step) => step.op === "readText" && step.path === guard);
  f.fs.unlink(guard);
  expect(racer.finish()).toBe(false);
  expect(f.fs.paths()).toEqual([PATH]);
  expect(f.fs.readText(PATH)).toBe(OLD);
});

test("guard chain: 16 dead guards hit the cap and warn without removing the lock", () => {
  const f = fixture();
  const base = prefix(f.fs);
  for (let k = 0; k < 16; k++) {
    f.fs.seed(`${base}.${k}`, "707");
  }
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(f.acquire(101).finish()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chain exhausted"));
  } finally {
    warn.mockRestore();
  }
  expect(f.fs.readText(PATH)).toBe(OLD);
  expect(f.fs.paths().length).toBe(17);
});

test("guard chain: already removed instance is abandoned at step 3 without rename", () => {
  const f = fixture();
  const late = f.acquire(202);
  pauseAfterJudgement(late);
  expect(f.acquire(101).finish()).toBe(true);
  late.until((step) => step.op === "stat" && step.path === PATH);
  const offset = late.trace.length;
  expect(late.finish()).toBe(false);
  expect(late.trace.slice(offset).some((step) => step.op === "rename")).toBe(false);
  expect(f.fs.paths()).toEqual([PATH]);
  exactHolder(f.fs, 101);
});

test("R1 defence in depth: late legacy fd write before rename is restored without a third acquirer", () => {
  let now = 0;
  const fs = new FakeLockFileSystem(() => now);
  fs.mkdir("/locks");
  const fd = fs.openExclusive(PATH); // Legacy creator stalls before filling owner bytes.
  now = NOW;
  const reclaimer = new Racer(
    acquireExclusiveLockSteps(PATH, {
      pid: 202,
      fileSystem: fs,
      now: () => now,
      isProcessRunning: () => true,
    }),
  );
  reclaimer.until((step) => step.op === "rename" && step.path === PATH);
  fs.write(fd, "101\nlate-writer");
  fs.close(fd);
  expect(reclaimer.finish()).toBe(false);
  expect(fs.readText(PATH)).toBe("101\nlate-writer");
  expect(fs.paths()).toEqual([PATH]);
});

test("fallback ENOTSUP: wx acquire succeeds, genuine create error throws, reclaim cannot rename", () => {
  const f = fixture();
  f.fs.unlink(PATH);
  f.fs.linkError = "ENOTSUP";
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(f.acquire(101).finish()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.fs.paths()).toEqual([PATH]);
    f.fs.unlink(PATH);
    f.fs.openError = "EACCES";
    expect(() => f.acquire(101).finish()).toThrow("Failed to create exclusive lock file");
    expect(f.fs.paths()).toEqual([]);
    f.fs.openError = undefined;
    f.fs.seed(PATH, OLD);
    const racer = f.acquire(303);
    expect(racer.finish()).toBe(false);
    expect(racer.trace.some((step) => step.op === "rename")).toBe(false);
    expect(f.fs.readText(PATH)).toBe(OLD);
    expect(f.fs.paths()).toEqual([PATH]);
  } finally {
    warn.mockRestore();
  }
});

interface Actor {
  pid: number;
  options: ExclusiveLockOptions;
  racer: Racer<boolean | void>;
  phase: "acquiring" | "holding" | "releasing" | "finished" | "crashed";
  attempts: number;
}

function assertBelievers(fs: FakeLockFileSystem, actors: Actor[]): void {
  const believers = actors.filter((actor) => actor.phase === "holding");
  expect(believers.length).toBeLessThanOrEqual(1);
  for (const actor of believers) {
    exactHolder(fs, actor.pid);
  }
}

function advanceActor(actor: Actor, f: ReturnType<typeof fixture>): void {
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

function runSchedule(seed: number): void {
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
  f.live.add(505);
  let acquired = false;
  for (let attempt = 0; attempt < 6 && !acquired; attempt++) {
    acquired = tryAcquireExclusiveLock(PATH, f.options(505));
  }
  expect(acquired).toBe(true);
  exactHolder(f.fs, 505);
}

function checkMutation(actor: Actor, f: ReturnType<typeof fixture>, actors: Actor[]): void {
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

// One bounded schedule per row keeps each unit below the requested 15 ms budget.
const SEEDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 75, 76, 77,
  78, 12075, 12076, 12077, 12078,
];
test.each(SEEDS)("single-holder property: seeded schedule %d", runSchedule);

test("guard chain: unreadable guard counts as LIVE, even when its owner might be dead", () => {
  const f = fixture();
  const guard = `${prefix(f.fs)}.0`;
  f.fs.seed(guard, "707");
  const read = spyOn(f.fs, "readText");
  // Bun spies retain the original implementation through the bound prototype here.
  read.mockImplementation((path) => {
    if (path === guard) {
      throw Object.assign(new Error("unreadable guard"), { code: "EACCES" });
    }
    return FakeLockFileSystem.prototype.readText.call(f.fs, path);
  });
  try {
    expect(f.acquire(101).finish()).toBe(false);
    expect(f.fs.paths()).toEqual([PATH, guard].sort());
    expect(f.fs.readText(PATH)).toBe(OLD);
  } finally {
    read.mockRestore();
  }
});

test("guard chain: same-PID guard with provably different generation is superseded", () => {
  const f = fixture();
  const guard = `${prefix(f.fs)}.0`;
  f.fs.seed(guard, "101\nprevious\n\nold-generation");
  expect(f.acquire(101).finish()).toBe(true);
  expect(f.fs.paths()).toEqual([PATH]);
  exactHolder(f.fs, 101);
});

test.each(["mtime", "raw", "inode"])(
  "judgement and fingerprint: changed %s never reaches rename",
  (change) => {
    const f = fixture();
    const late = f.acquire(202);
    pauseAfterJudgement(late);
    if (change === "inode") {
      f.fs.seed(PATH, OLD, 0);
    } else {
      f.fs.update(
        PATH,
        change === "raw" ? `${OLD}\nchanged-metadata` : OLD,
        change === "mtime" ? 1 : 0,
      );
    }
    expect(late.finish()).toBe(false);
    expect(late.trace.some((step) => step.op === "rename")).toBe(false);
    expect(f.fs.paths()).toEqual([PATH]);
  },
);

test("guard cleanup: a genuine create error after removal always releases the guard and tmp", () => {
  const f = fixture();
  const racer = f.acquire(101);
  racer.until((step) => step.op === "mkdir" && !f.fs.exists(PATH));
  f.fs.linkError = "ENOTSUP";
  f.fs.openError = "EACCES";
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(() => racer.finish()).toThrow("Failed to create exclusive lock file");
    expect(f.fs.paths()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

function publicationSteps(): LockStep[] {
  const f = fixture();
  f.fs.unlink(PATH);
  const racer = f.acquire(101);
  racer.finish();
  return racer.trace;
}
test.each(publicationSteps().map((_step, index) => index))(
  "atomic publisher crashes before operation %d: full owner or absent, retry is not blocked",
  (index) => {
    const f = fixture();
    f.fs.unlink(PATH);
    const racer = f.acquire(101);
    for (let step = 0; step < index; step++) {
      racer.advance();
      if (f.fs.exists(PATH)) {
        exactHolder(f.fs, 101);
      }
    }
    f.live.delete(101);
    expect(f.acquire(303).finish()).toBe(true);
    exactHolder(f.fs, 303);
  },
);

test("guard chain: same-PID guard stays LIVE even if an injected liveness check says dead", () => {
  const f = fixture();
  const guard = `${prefix(f.fs)}.0`;
  f.fs.seed(guard, "101\nprevious");
  expect(
    new Racer(
      acquireExclusiveLockSteps(PATH, {
        ...f.options(101),
        isProcessRunning: () => false,
      }),
    ).finish(),
  ).toBe(false);
  expect(f.fs.readText(PATH)).toBe(OLD);
  expect(f.fs.paths()).toEqual([PATH, guard].sort());
});
