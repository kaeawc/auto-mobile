import { expect, spyOn, test } from "bun:test";
import {
  acquireExclusiveLockSteps,
  RECLAIM_GUARD_SLOT_LIMIT,
  RECLAIM_GUARD_ABANDON_AGE_MS,
  type LockStep,
} from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { SeededRandom } from "../fakes/SeededRandom";
import {
  Racer,
  fixture,
  prefix,
  exactHolder,
  PATH,
  OLD,
  assertBelievers,
  checkMutation,
  type Actor,
} from "./fileLockRaceHarness";

type Fixture = ReturnType<typeof fixture>;
function seedGuards(f: Fixture, count = 1): string {
  const base = prefix(f.fs);
  for (let k = 0; k < count; k++) {
    f.fs.seed(`${base}.${k}`, "707\ndead");
  }
  return base;
}
function guards(f: Fixture, base: string): string[] {
  return f.fs
    .paths()
    .filter((path) => path.startsWith(`${base}.`) && /^\d+$/.test(path.slice(base.length + 1)));
}
function deadLitter(f: Fixture): void {
  for (const path of f.fs.paths().filter((path) => path !== PATH)) {
    const pid = Number(f.fs.readText(path).split("\n")[0]);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(f.live.has(pid)).toBe(false);
  }
}
function crash(f: Fixture, pid: number): void {
  f.live.delete(pid);
}
function fresh(f: Fixture, pid = 909, attempts = 4): void {
  f.live.add(pid);
  let acquired = false;
  for (let attempt = 0; attempt < attempts && !acquired; attempt++) {
    acquired = f.acquire(pid).finish();
  }
  expect(acquired).toBe(true);
  exactHolder(f.fs, pid);
  deadLitter(f);
}
function underGuard(f: Fixture, racer: Racer<boolean>, base: string): void {
  racer.until(
    (step) =>
      step.op === "stat" &&
      step.path === PATH &&
      racer.trace.length > 1 &&
      f.fs.exists(`${base}.0`),
  );
}
function trace(count: number): LockStep[] {
  const f = fixture();
  if (count) {
    seedGuards(f, count);
  }
  const racer = f.acquire(101);
  expect(racer.finish()).toBe(true);
  return racer.trace;
}
const loneTrace = trace(0);
const topTrace = trace(1);
function publishedIndex(steps: LockStep[], k: number): number {
  return steps.findIndex((s) => s.op === "link" && s.path.endsWith(`.${k}`)) + 1;
}
const criticalStart = loneTrace.findIndex(
  (s) => s.op === "stat" && s.path === PATH && loneTrace.indexOf(s) > 1,
);
const renameIndex = loneTrace.findIndex((s) => s.op === "rename" && s.path === PATH);
const windowStart = publishedIndex(topTrace, 1);
const windowEnd = topTrace.findIndex(
  (s, i) => i > windowStart && s.op === "stat" && s.path === PATH,
);
const windowRows = Array.from({ length: windowEnd - windowStart }, (_, i) => i);

test("stuck-lock repro: 16 critical-section crashes, 17th claimant acquires first attempt", () => {
  const f = fixture();
  const base = prefix(f.fs);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    for (let i = 0; i < 16; i++) {
      const pid = 1000 + i;
      f.live.add(pid);
      underGuard(f, f.acquire(pid), base);
      crash(f, pid);
    }
    f.live.add(909);
    expect(f.acquire(909).finish()).toBe(true);
    exactHolder(f.fs, 909);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test.each(loneTrace.map((_, i) => i).filter((i) => i >= criticalStart))(
  "critical-section crash bound: recorded operation %d",
  (index) => {
    const f = fixture();
    const base = prefix(f.fs);
    // Once a rename has happened, stop this row: later retries take a free path
    // or a new fingerprint, outside the original instance's guard bound.
    const rounds = 40;
    for (let i = 0; i < rounds; i++) {
      const pid = 1000 + i;
      f.live.add(pid);
      const racer = f.acquire(pid);
      underGuard(f, racer, base);
      for (let n = criticalStart; n < index && !racer.pending.done; n++) {
        racer.advance();
      }
      crash(f, pid);
      if (index <= renameIndex) {
        expect(guards(f, base)).toHaveLength(1);
      } else {
        expect(guards(f, base).length).toBeLessThanOrEqual(1);
      }
      if (index > renameIndex && !f.fs.exists(PATH)) {
        break;
      }
    }
    if (index > renameIndex && !f.fs.exists(PATH)) {
      // A free-path acquirer is a holder crash, then this row stops as allowed.
      f.live.add(808);
      expect(f.acquire(808).finish()).toBe(true);
      exactHolder(f.fs, 808);
      crash(f, 808);
    }
    fresh(f, 909, index <= renameIndex ? 1 : 4);
    if (index <= renameIndex) {
      expect(f.fs.paths()).toEqual([PATH]);
    }
  },
);

test.each(windowRows)("supersession-window crash bound: operation %d", (offset) => {
  const f = fixture();
  const base = seedGuards(f);
  for (let i = 0; i < 40; i++) {
    const pid = 1000 + i;
    f.live.add(pid);
    const racer = f.acquire(pid);
    racer.until((s) => s.op === "link" && s.path.startsWith(`${base}.`) && !f.fs.exists(s.path));
    racer.advance(); // Exclusive publication completed; abandon without finally.
    for (let n = 0; n < offset && !racer.pending.done; n++) {
      racer.advance();
    }
    crash(f, pid);
    const slots = guards(f, base);
    expect(slots.length).toBeLessThanOrEqual(2 + i);
    expect(slots).toEqual(Array.from({ length: slots.length }, (_, k) => `${base}.${k}`).sort());
  }
  f.live.add(909);
  expect(f.acquire(909).finish()).toBe(true);
  exactHolder(f.fs, 909);
  expect(guards(f, base)).toEqual([]);
  // Crashed private tmp files are dead litter, deliberately outside guard cleanup.
  deadLitter(f);
  if (!f.fs.paths().some((path) => path.endsWith(".tmp"))) {
    expect(f.fs.paths()).toEqual([PATH]);
  }
});

function verifyWinner(f: Fixture, racers: { pid: number; racer: Racer<boolean> }[]): void {
  const winners = racers.filter(({ racer }) => racer.pending.done && racer.pending.value);
  expect(winners.length).toBeLessThanOrEqual(1);
  if (winners.length) {
    exactHolder(f.fs, winners[0].pid);
  }
}
function finishChecked(
  f: Fixture,
  actor: { pid: number; racer: Racer<boolean> },
  actors: { pid: number; racer: Racer<boolean> }[],
): boolean {
  return actor.racer.finish(() => verifyWinner(f, actors));
}
function staleAscender(f: Fixture, base: string, pid: number): Racer<boolean> {
  const b = f.acquire(pid);
  b.until((s) => s.op === "writeFile" && s.path.startsWith(`${base}.1.`));
  return b;
}

test("stale ascender revalidates old slot 0 and removes only its own candidate", () => {
  const f = fixture();
  const base = seedGuards(f);
  const b = staleAscender(f, base, 202);
  const a = f.acquire(101);
  underGuard(f, a, base);
  const before = f.fs.readText(`${base}.0`);
  expect(b.finish()).toBe(false);
  expect(f.fs.readText(`${base}.0`)).toBe(before);
  expect(a.finish()).toBe(true);
  exactHolder(f.fs, 101);
  expect(f.fs.paths()).toEqual([PATH]);
});

test.each(
  windowRows.flatMap(
    (index) =>
      [
        [index, false],
        [index, true],
      ] as const,
  ),
)("supersession interleaving at operation %d, mirror %s", (offset, mirror) => {
  const f = fixture();
  const base = seedGuards(f);
  const stale = { pid: 202, racer: staleAscender(f, base, 202) };
  const superseder = { pid: 101, racer: f.acquire(101) };
  const paused = mirror ? stale : superseder;
  const other = mirror ? superseder : stale;
  paused.racer.until((s) => s.op === "link" && s.path === `${base}.1`);
  paused.racer.advance();
  for (let i = 0; i < offset && !paused.racer.pending.done; i++) {
    paused.racer.advance();
  }
  const actors = [stale, superseder];
  finishChecked(f, other, actors);
  finishChecked(f, paused, actors);
  verifyWinner(f, actors);
  expect(f.fs.operations.filter((s) => s.op === "rename" && s.path === PATH)).toHaveLength(1);
  expect(f.acquire(303).finish()).toBe(false);
  verifyWinner(f, actors);
  expect(f.fs.paths()).toEqual([PATH]);
});

test("installed slot 0 crash before top unlink is superseded and cleaned", () => {
  const f = fixture();
  const base = seedGuards(f);
  const a = f.acquire(101);
  a.until((s) => s.op === "unlink" && s.path === `${base}.1`);
  expect(guards(f, base)).toHaveLength(2);
  crash(f, 101);
  expect(f.acquire(303).finish()).toBe(true);
  exactHolder(f.fs, 303);
  expect(f.fs.paths()).toEqual([PATH]);
});

test("install rename failure keeps top-slot authority and cleans after removal", () => {
  const f = fixture();
  const base = seedGuards(f);
  const rename = spyOn(f.fs, "rename").mockImplementation((from, to) => {
    if (to === `${base}.0`) {
      throw Object.assign(new Error("install failure"), { code: "EIO" });
    }
    return FakeLockFileSystem.prototype.rename.call(f.fs, from, to);
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(f.acquire(101).finish()).toBe(true);
    exactHolder(f.fs, 101);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("install failed"), expect.anything());
  } finally {
    rename.mockRestore();
    warn.mockRestore();
  }
});

test("release by content leaves aged-out live claimant's successor guard", () => {
  const f = fixture();
  const base = prefix(f.fs);
  const q = new Racer(
    acquireExclusiveLockSteps(PATH, { ...f.options(101), ownerGeneration: undefined }),
  );
  underGuard(f, q, base);
  f.clock.advanceTime(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
  const h = f.acquire(202);
  underGuard(f, h, base);
  const raw = f.fs.readText(`${base}.0`);
  // Skip Q's critical section by changing its sampled instance. Q must unwind
  // while H is still inside its guarded critical section.
  f.fs.update(PATH, `${OLD}\nchanged`);
  expect(q.finish()).toBe(false);
  expect(f.fs.readText(`${base}.0`)).toBe(raw);
  f.fs.update(PATH, OLD, 0);
  expect(h.finish()).toBe(true);
  exactHolder(f.fs, 202);
  expect(f.fs.paths()).toEqual([PATH]);
});

test("cap: named slot limit warns with lock untouched and no rename", () => {
  const f = fixture();
  const base = seedGuards(f, RECLAIM_GUARD_SLOT_LIMIT);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(f.acquire(101).finish()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chain exhausted"));
    expect(f.fs.readText(PATH)).toBe(OLD);
    expect(guards(f, base)).toHaveLength(RECLAIM_GUARD_SLOT_LIMIT);
    expect(f.fs.operations.some((s) => s.op === "rename")).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

function crashSchedule(seed: number): void {
  const f = fixture();
  seedGuards(f);
  const random = new SeededRandom(seed);
  let nextPid = 1000;
  let crashes = 0;
  function actor(): Actor {
    const pid = nextPid++;
    f.live.add(pid);
    return { pid, options: f.options(pid), racer: f.acquire(pid), phase: "acquiring", attempts: 0 };
  }
  const actors = [actor(), actor(), actor()];
  for (let count = 0; count < 6000; count++) {
    const active = actors.filter((a) => a.phase !== "finished" && a.phase !== "crashed");
    if (!active.length) {
      break;
    }
    const a = random.pick(active);
    if (crashes < 40 && random.next() < 0.16) {
      a.phase = "crashed";
      crash(f, a.pid);
      crashes++;
      actors.push(actor());
    } else {
      checkMutation(a, f, actors);
    }
    assertBelievers(f.fs, actors);
  }
  expect(crashes).toBe(40);
  expect(actors.every((a) => a.phase === "finished" || a.phase === "crashed")).toBe(true);
  fresh(f); // No clock advancement: dead-pid guards supersede immediately.
}
test.each(Array.from({ length: 24 }, (_, i) => 3001 + i))(
  "crash-heavy single-holder property: seed %d",
  crashSchedule,
);

const deepTrace = trace(3);
const deepStart = publishedIndex(deepTrace, 3);
const deepEnd = deepTrace.findIndex((s, i) => i > deepStart && s.op === "stat" && s.path === PATH);
test.each(Array.from({ length: deepEnd - deepStart }, (_, i) => i))(
  "deep supersession crash: each revalidation and descending cleanup operation %d",
  (offset) => {
    const f = fixture();
    const base = seedGuards(f);
    // Two actual window crashes build the three-slot recorded-trace fixture.
    for (const pid of [800, 801]) {
      f.live.add(pid);
      const a = f.acquire(pid);
      a.until(
        (step) => step.op === "link" && step.path.startsWith(`${base}.`) && !f.fs.exists(step.path),
      );
      a.advance();
      a.advance(); // Remove publication tmp before abandoning at revalidation.
      crash(f, pid);
    }
    for (let n = 0; n < 40; n++) {
      const pid = 1000 + n;
      f.live.add(pid);
      const a = f.acquire(pid);
      a.until(
        (step) => step.op === "link" && step.path.startsWith(`${base}.`) && !f.fs.exists(step.path),
      );
      a.advance();
      for (let i = 0; i < offset; i++) {
        // Completed compaction can shorten the next window; never execute the
        // first critical-section operation when this recorded index is later.
        if (!a.pending.done && a.pending.value.op === "stat" && a.pending.value.path === PATH) {
          break;
        }
        a.advance();
      }
      crash(f, pid);
      const slots = guards(f, base);
      expect(slots.length).toBeLessThanOrEqual(4 + n);
      expect(slots).toEqual(Array.from({ length: slots.length }, (_, k) => `${base}.${k}`).sort());
    }
    expect(f.acquire(303).finish()).toBe(true);
    exactHolder(f.fs, 303);
    deadLitter(f);
    expect(guards(f, base)).toEqual([]);
    if (!f.fs.paths().some((p) => p.endsWith(".tmp"))) {
      expect(f.fs.paths()).toEqual([PATH]);
    }
  },
);

test.each(["writeFile", "top-unlink", "lower-unlink"])(
  "compaction failure at %s retains exclusive authority",
  (failure) => {
    const f = fixture();
    const base = seedGuards(f, 3);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const write = spyOn(f.fs, "writeFile").mockImplementation((path, content) => {
      if (failure === "writeFile" && path.startsWith(`${base}.0.`) && path.endsWith(".tmp")) {
        throw Object.assign(new Error("install write failure"), { code: "EIO" });
      }
      FakeLockFileSystem.prototype.writeFile.call(f.fs, path, content);
    });
    let injected = false;
    const unlink = spyOn(f.fs, "unlink").mockImplementation((path) => {
      const target = failure === "top-unlink" ? `${base}.3` : `${base}.2`;
      if (failure !== "writeFile" && !injected && path === target) {
        injected = true;
        throw Object.assign(new Error("cleanup failure"), { code: "EACCES" });
      }
      FakeLockFileSystem.prototype.unlink.call(f.fs, path);
    });
    try {
      expect(f.acquire(101).finish()).toBe(true);
      exactHolder(f.fs, 101);
      expect(f.fs.paths()).toEqual([PATH]);
      expect(warn).toHaveBeenCalled();
    } finally {
      write.mockRestore();
      unlink.mockRestore();
      warn.mockRestore();
    }
  },
);

test.each(["inode", "mtime", "raw", "missing", "unreadable"])(
  "lower-slot revalidation rejects changed %s and only removes its candidate",
  (change) => {
    const f = fixture();
    const base = seedGuards(f);
    const a = f.acquire(101);
    a.until((s) => s.op === "link" && s.path === `${base}.1`);
    a.advance();
    if (change === "inode") {
      f.fs.seed(`${base}.0`, "707\ndead");
    }
    if (change === "mtime") {
      f.fs.update(`${base}.0`, "707\ndead", 1);
    }
    if (change === "raw") {
      f.fs.update(`${base}.0`, "808\ndifferent");
    }
    if (change === "missing") {
      f.fs.unlink(`${base}.0`);
    }
    const read = spyOn(f.fs, "readText").mockImplementation((path) => {
      if (change === "unreadable" && path === `${base}.0`) {
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      }
      return FakeLockFileSystem.prototype.readText.call(f.fs, path);
    });
    try {
      expect(a.finish()).toBe(false);
      expect(f.fs.readText(PATH)).toBe(OLD);
      expect(f.fs.exists(`${base}.1`)).toBe(false);
      expect(f.fs.operations.some((s) => s.op === "rename")).toBe(false);
    } finally {
      read.mockRestore();
    }
  },
);

test("k=0 publication-cleanup crash retains one guard and only dead tmp litter", () => {
  const f = fixture();
  const base = prefix(f.fs);
  const a = f.acquire(101);
  a.until((s) => s.op === "link" && s.path === `${base}.0`);
  a.advance();
  crash(f, 101);
  expect(guards(f, base)).toHaveLength(1);
  expect(f.acquire(303).finish()).toBe(true);
  exactHolder(f.fs, 303);
  deadLitter(f);
  expect(guards(f, base)).toEqual([]);
});

test("stale ascender crash can leave a gap after compaction without displacing the holder", () => {
  const f = fixture();
  const base = seedGuards(f, 2);
  const b = f.acquire(202);
  b.until((s) => s.op === "writeFile" && s.path.startsWith(`${base}.2.`));
  const a = f.acquire(101);
  underGuard(f, a, base);
  b.until((s) => s.op === "link" && s.path === `${base}.2`);
  b.advance();
  crash(f, 202);
  expect(guards(f, base)).toEqual([`${base}.0`, `${base}.2`]);
  expect(a.finish()).toBe(true);
  exactHolder(f.fs, 101);
  expect(f.acquire(303).finish(() => exactHolder(f.fs, 101))).toBe(false);
  deadLitter(f);
});
