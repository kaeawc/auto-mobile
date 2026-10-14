import { expect, spyOn, test } from "bun:test";
import {
  RECLAIM_GUARD_ABANDON_AGE_MS,
  takeOverExclusiveLock,
  acquireExclusiveLockSteps,
  releaseExclusiveLockSteps,
  tryAcquireExclusiveLock,
  readExclusiveLockContent,
  formatLockContent,
  type ExclusiveLockOptions,
  type LockStep,
} from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { SeededRandom } from "../fakes/SeededRandom";
import { FakeTimer } from "../fakes/FakeTimer";

import {
  runSchedule,
  Racer,
  fixture,
  prefix,
  exactHolder,
  pauseAfterJudgement,
  PATH,
  NOW,
  OLD,
} from "./fileLockRaceHarness";
type Steps<T> = Generator<LockStep, T, void>;

test("T1: a leftover tmp sharing the lock's inode is never written through", () => {
  const f = fixture("500\nforeign-owner\nmetadata  ");
  const original = f.fs.readText(PATH);
  const stat = spyOn(f.fs, "stat").mockImplementationOnce(() => {
    // An unreadable initial sample must still use the safe publication protocol.
    throw Object.assign(new Error("sample unavailable"), { code: "EACCES" });
  });
  const options = { ...f.options(101), idGenerator: new FakeIdGenerator(["recycled-id"]) };
  const racer = new Racer(acquireExclusiveLockSteps(PATH, options));
  f.live.add(500);
  try {
    racer.until(
      (step) => step.path.endsWith(".tmp") && (step.op === "unlink" || step.op === "writeFile"),
    );
    if (racer.pending.done) {
      throw new Error("Missing tmp publication");
    }
    const tmp = racer.pending.value.path;
    f.fs.link(PATH, tmp);
    expect(racer.finish()).toBe(false);
    expect(f.fs.readText(PATH)).toBe(original);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(tmp).toEndWith(".recycled-id.tmp");
  } finally {
    stat.mockRestore();
  }
});

test.each(["500\nlive-owner", ""])(
  "T2: a contended live acquire performs zero writes (owner %j)",
  (raw) => {
    const f = fixture(raw);
    f.live.add(500);
    f.fs.update(PATH, raw); // Ownerless variant is young.
    f.fs.operations.length = 0;
    expect(f.acquire(101).finish()).toBe(false);
    expect(f.fs.operations).toEqual([
      { op: "stat", path: PATH },
      { op: "readText", path: PATH },
    ]);
  },
);

test("T2: a reclaimable lock goes straight to the guard without a doomed lock publication", () => {
  const f = fixture();
  const racer = f.acquire(101);
  racer.until((step) => step.op === "rename" && step.path === PATH);
  expect(racer.trace.some((step) => step.op === "link" && step.path === PATH)).toBe(false);
  expect(racer.finish()).toBe(true);
  exactHolder(f.fs, 101);
  expect(f.fs.paths()).toEqual([PATH]);
});

function unsupportedRestore() {
  const clock = new FakeTimer();
  const fs = new FakeLockFileSystem(() => clock.now());
  fs.mkdir("/locks");
  const fd = fs.openExclusive(PATH);
  clock.advanceTime(NOW);
  fs.linkError = "ENOTSUP";
  const reclaimer = new Racer(
    acquireExclusiveLockSteps(PATH, {
      pid: 202,
      fileSystem: fs,
      idGenerator: new FakeIdGenerator(),
      now: () => clock.now(),
      isProcessRunning: () => true,
    }),
  );
  reclaimer.until((step) => step.op === "rename" && step.path === PATH);
  const raw = "101\nlate-writer\nmetadata  ";
  fs.write(fd, raw);
  fs.close(fd);
  return { fs, reclaimer, raw, marker: `${PATH}.202.reclaim` };
}

test("T3: R1 late legacy writer is restored by exclusive copy when links are disabled", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const f = unsupportedRestore();
    expect(f.reclaimer.finish()).toBe(false);
    expect(f.fs.readText(PATH)).toBe(f.raw);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(f.fs.operations.some((step) => step.op === "openExclusive" && step.path === PATH)).toBe(
      true,
    );
  } finally {
    warn.mockRestore();
  }
});

test("T3: exclusive restore copy leaves a third acquirer untouched and removes the marker", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const f = unsupportedRestore();
    f.reclaimer.until((step) => step.op === "link" && step.path === PATH);
    expect(
      tryAcquireExclusiveLock(PATH, {
        pid: 303,
        ownerToken: "third-acquirer",
        fileSystem: f.fs,
        idGenerator: new FakeIdGenerator(),
        isProcessRunning: () => true,
      }),
    ).toBe(true);
    expect(f.reclaimer.finish()).toBe(false);
    expect(f.fs.readText(PATH)).toBe("303\nthird-acquirer");
    expect(f.fs.paths()).toEqual([PATH]);
  } finally {
    warn.mockRestore();
  }
});

test.each(["openError", "writeError", "closeError"] as const)(
  "T3: failed exclusive copy (%s) retains the displaced lock without partial litter",
  (operation) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const f = unsupportedRestore();
      f.fs[operation] = "EIO";
      f.fs.writeFileError = "EIO";
      const rename = spyOn(f.fs, "rename");
      try {
        expect(f.reclaimer.finish()).toBe(false);
        expect(rename).not.toHaveBeenCalledWith(expect.anything(), PATH);
      } finally {
        rename.mockRestore();
      }
      expect(f.fs.exists(PATH)).toBe(false);
      expect(f.fs.readText(`${PATH}.displaced`)).toBe(f.raw);
      expect(f.fs.paths()).toEqual([`${PATH}.displaced`]);
      expect(f.fs.operations.some((step) => step.op === "rename" && step.path === f.marker)).toBe(
        true,
      );
      expect(warn).toHaveBeenCalledWith(
        `Displaced lock restore failed at ${PATH}; retained at ${PATH}.displaced; lock state is held-unknown`,
      );
      expect(f.reclaimer.trace.some((step) => step.op === "exists")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  },
);

test("T3: failed retained rename warns and retains the only displaced copy", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const f = unsupportedRestore();
    f.fs.openError = "EACCES";
    const rename = spyOn(f.fs, "rename").mockImplementation((from, to) => {
      if (from === f.marker) {
        throw Object.assign(new Error("rename denied"), { code: "EACCES" });
      }
      FakeLockFileSystem.prototype.rename.call(f.fs, from, to);
    });
    try {
      expect(f.reclaimer.finish()).toBe(false);
      expect(f.fs.paths()).toEqual([f.marker]);
      expect(f.fs.readText(f.marker)).toBe(f.raw);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("retention failed"),
        expect.anything(),
      );
    } finally {
      rename.mockRestore();
    }
  } finally {
    warn.mockRestore();
  }
});

test("T3: release restores a displaced foreign owner by exclusive copy without hard links", () => {
  const f = fixture("101\nowner-101");
  const release = new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs));
  release.until((step) => step.op === "rename" && step.path === PATH);
  const raw = "500\nforeign-owner\nmetadata  ";
  f.fs.update(PATH, raw);
  f.fs.linkError = "ENOTSUP";
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(() => release.finish()).not.toThrow();
    expect(f.fs.readText(PATH)).toBe(raw);
    expect(f.fs.paths()).toEqual([PATH]);
  } finally {
    warn.mockRestore();
  }
});

test("B1: a guard whose content write fails is removed and the acquire returns false", () => {
  const f = fixture("99");
  f.fs.linkError = "ENOTSUP";
  f.fs.writeError = "ENOSPC";
  const original = f.fs.stat(PATH);
  const guard = `${prefix(f.fs)}.0`;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(false);
    expect(f.fs.readText(PATH)).toBe("99");
    expect(f.fs.stat(PATH)).toEqual(original);
    expect(f.fs.operations.some((step) => step.op === "rename")).toBe(false);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${guard}: ENOSPC`),
      expect.anything(),
    );
  } finally {
    warn.mockRestore();
  }
});

test.each([true, false])(
  "B1: seventeen disk-full attempts spaced past the abandon age do not exhaust the chain (atomic write failure: %s)",
  (atomicFailure) => {
    const f = fixture("99");
    f.fs.linkError = "ENOTSUP";
    f.fs.writeError = "ENOSPC";
    f.fs.writeFileError = atomicFailure ? "ENOSPC" : undefined;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 17; attempt++) {
        expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(false);
        expect(f.fs.paths()).toEqual([PATH]);
        expect(f.fs.readText(PATH)).toBe("99");
        f.clock.advanceTime(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
      }
      f.fs.writeError = undefined;
      f.fs.writeFileError = undefined;
      expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(true);
      exactHolder(f.fs, 101);
      expect(f.fs.paths()).toEqual([PATH]);
    } finally {
      warn.mockRestore();
    }
  },
);

test.each([
  ["openError", "EACCES"],
  ["openError", "EROFS"],
  ["writeError", "EIO"],
  ["closeError", "ENOSPC"],
  ["closeError", "EIO"],
  ["closeError", "EEXIST"],
] as const)("guard creation: %s %s backs off without touching the lock", (operation, code) => {
  const f = fixture("99");
  f.fs.linkError = "ENOTSUP";
  f.fs[operation] = code;
  const guard = `${prefix(f.fs)}.0`;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const racer = f.acquire(101);
    if (operation === "writeError" || operation === "closeError") {
      racer.until((step) => step.op === "unlink" && step.path === guard);
      expect(f.fs.exists(guard)).toBe(true); // Cleanup yields before unlinking our guard.
    }
    expect(racer.finish()).toBe(false);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(f.fs.readText(PATH)).toBe("99");
    expect(racer.trace.some((step) => step.op === "rename")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${guard}: ${code}`),
      expect.anything(),
    );
  } finally {
    warn.mockRestore();
  }
});

test("guard creation: atomic writeFile EIO falls back to legacy creation without litter", () => {
  const f = fixture("99");
  f.fs.writeFileError = "EIO";
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(f.acquire(101).finish()).toBe(true);
    exactHolder(f.fs, 101);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Atomic lock publication failed"),
      expect.anything(),
    );
  } finally {
    warn.mockRestore();
  }
});

test.each(["EACCES", "EROFS"])(
  "B2: a directory that refuses guard creation reads as held, not as an error (%s)",
  (code) => {
    const f = fixture("99");
    f.fs.writeFileError = code;
    f.fs.openError = code;
    const original = f.fs.stat(PATH);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(false);
      expect(takeOverExclusiveLock(PATH, { pid: 99, token: undefined }, f.options(101))).toBe(
        false,
      );
      expect(f.fs.readText(PATH)).toBe("99");
      expect(f.fs.stat(PATH)).toEqual(original);
      expect(f.fs.operations.some((step) => step.op === "rename")).toBe(false);
      expect(f.fs.paths()).toEqual([PATH]);
      f.fs.unlink(PATH);
      expect(() => tryAcquireExclusiveLock(PATH, f.options(101))).toThrow(
        "Failed to create exclusive lock file",
      );
      expect(f.fs.paths()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  },
);

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

test("guard chain: 16 dead guards are superseded and cleaned", () => {
  const f = fixture();
  const base = prefix(f.fs);
  for (let k = 0; k < 16; k++) {
    f.fs.seed(`${base}.${k}`, "707");
  }
  expect(f.acquire(101).finish()).toBe(true);
  exactHolder(f.fs, 101);
  expect(f.fs.paths()).toEqual([PATH]);
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

test.each(["ENOTSUP", "EPERM", "ENOSYS", "EIO"])(
  "fallback %s: wx acquire succeeds, genuine create error throws, guard fallback reclaims exclusively",
  (code) => {
    const f = fixture();
    f.fs.unlink(PATH);
    f.fs.linkError = code;
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
      expect(f.acquire(303).finish()).toBe(true);
      exactHolder(f.fs, 303);
      expect(f.fs.paths()).toEqual([PATH]);
      f.fs.seed(PATH, OLD);
      const racer = f.acquire(303);
      const guard = `${prefix(f.fs)}.0`;
      racer.until((step) => step.op === "stat" && step.path === PATH && f.fs.exists(guard));
      expect(f.acquire(202).finish()).toBe(false);
      expect(f.fs.readText(PATH)).toBe(OLD);
      expect(racer.finish()).toBe(true);
      expect(racer.trace.some((step) => step.op === "openExclusive" && step.path === guard)).toBe(
        true,
      );
      expect(racer.trace.some((step) => step.op === "write")).toBe(true);
      expect(racer.trace.some((step) => step.op === "close")).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Atomic lock publication failed"),
        expect.anything(),
      );
      exactHolder(f.fs, 303);
      expect(f.fs.paths()).toEqual([PATH]);
    } finally {
      warn.mockRestore();
    }
  },
);

// Scope for (a) at most one believer, (b) exact holder bytes, and (c) no foreign
// removal: the clock never passes the abandonment bound while a LIVE reclaimer
// holds a guard. Only (d), after every actor has finished/crashed, advances time.
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

test("F1: guard reuses the first publication generation, final publication captures freshly", () => {
  const f = fixture();
  const samples: string[] = [];
  const options = {
    ...f.options(101),
    ownerGeneration: {
      current: () => {
        const token = `generation-${samples.length}`;
        samples.push(token);
        return token;
      },
      compare: () => "different" as const,
    },
  };
  const racer = new Racer(acquireExclusiveLockSteps(PATH, options));
  const guard = `${prefix(f.fs)}.0`;
  racer.until((step) => step.op === "stat" && step.path === PATH && f.fs.exists(guard));
  expect(samples).toEqual(["generation-0"]);
  expect(readExclusiveLockContent(guard, f.fs)?.generation).toBe("generation-0");
  expect(racer.finish()).toBe(true);
  expect(samples).toEqual(["generation-0", "generation-1"]);
  expect(readExclusiveLockContent(PATH, f.fs)?.generation).toBe("generation-1");
});

test("F1: takeover captures once for the guard and freshly for final publication", () => {
  const f = fixture();
  const samples: string[] = [];
  expect(
    takeOverExclusiveLock(
      PATH,
      { pid: 99, token: "stale" },
      {
        ...f.options(101),
        ownerGeneration: {
          current: () => {
            const token = `generation-${samples.length}`;
            samples.push(token);
            return token;
          },
          compare: () => "same",
        },
      },
    ),
  ).toBe(true);
  expect(samples).toEqual(["generation-0", "generation-1"]);
  expect(readExclusiveLockContent(PATH, f.fs)?.generation).toBe("generation-1");
});

test("F2: leftover private tmp is replaced on the first free-lock acquire with no litter", () => {
  const f = fixture();
  f.fs.unlink(PATH);
  const racer = f.acquire(101);
  racer.until((step) => step.op === "unlink" && step.path.endsWith(".tmp"));
  if (racer.pending.done) {
    throw new Error("Missing tmp publication");
  }
  const tmp = racer.pending.value.path;
  f.fs.seed(tmp, "crashed-incarnation-with-longer-content");
  expect(racer.finish()).toBe(true);
  exactHolder(f.fs, 101);
  expect(f.fs.paths()).toEqual([PATH]);
});

function abandonedGuard(legacy = false) {
  const clock = new FakeTimer();
  clock.advanceTime(NOW);
  const fs = new FakeLockFileSystem(() => clock.now());
  fs.seed(PATH, "99", 0);
  const idGenerator = new FakeIdGenerator();
  const options = (pid: number): ExclusiveLockOptions => ({
    pid,
    fileSystem: fs,
    idGenerator,
    now: () => clock.now(),
    isProcessRunning: (owner) => owner !== 99,
    reclaimOwnPid: true,
  });
  const guard = `${prefix(fs)}.0`;
  if (legacy) {
    fs.linkError = "ENOTSUP";
  }
  const crashed = new Racer(acquireExclusiveLockSteps(PATH, options(101)));
  crashed.until((step) =>
    legacy
      ? step.op === "write" && fs.exists(guard)
      : step.op === "stat" && step.path === PATH && fs.exists(guard),
  );
  // Abandon before rename (or legacy write), without unwinding the generator.
  return {
    fs,
    guard,
    options,
    setAge: (age: number) => {
      clock.stepWallClock(NOW + age - clock.now());
    },
  };
}

test.each([101, 202])(
  "F4 schedule G/F: crashed guard reused PID, retry %d ages out strictly",
  (pid) => {
    const f = abandonedGuard();
    const acquire = () => tryAcquireExclusiveLock(PATH, f.options(pid));
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(acquire()).toBe(false);
    }
    for (const age of [-1, 0, RECLAIM_GUARD_ABANDON_AGE_MS]) {
      f.setAge(age);
      expect(acquire()).toBe(false);
      expect(f.fs.readText(PATH)).toBe("99");
    }
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
    expect(acquire()).toBe(true);
    expect(readExclusiveLockContent(PATH, f.fs)?.pid).toBe(pid);
    expect(f.fs.paths()).toEqual([PATH]);
  },
);

test.each(["same", "unknown"] as const)(
  "F4: %s generation evidence at and beyond the age bound",
  (verdict) => {
    const f = abandonedGuard();
    f.fs.update(f.guard, "101\nprevious\n\nrecorded");
    const options = {
      ...f.options(202),
      ownerGeneration: { current: () => "current", compare: () => verdict },
    };
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS);
    expect(tryAcquireExclusiveLock(PATH, options)).toBe(false);
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
    expect(tryAcquireExclusiveLock(PATH, options)).toBe(verdict === "unknown");
    if (verdict === "same") {
      f.setAge(1_000_000_000);
      expect(tryAcquireExclusiveLock(PATH, options)).toBe(false);
      expect(f.fs.paths()).toEqual([PATH, f.guard].sort());
    } else {
      expect(f.fs.paths()).toEqual([PATH]);
    }
  },
);

test("F4: crashed empty legacy guard is superseded only strictly beyond the bound", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const f = abandonedGuard(true);
    expect(f.fs.readText(f.guard)).toBe("");
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS);
    expect(tryAcquireExclusiveLock(PATH, f.options(202))).toBe(false);
    expect(f.fs.readText(PATH)).toBe("99");
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
    expect(tryAcquireExclusiveLock(PATH, f.options(202))).toBe(true);
    expect(readExclusiveLockContent(PATH, f.fs)?.pid).toBe(202);
    expect(f.fs.paths()).toEqual([PATH]);
  } finally {
    warn.mockRestore();
  }
});

test.each(["garbage", "0", "101\nprevious\n\nrecorded-without-probe"])(
  "F4: guard %j without positive generation evidence ages out strictly",
  (raw) => {
    const f = abandonedGuard();
    f.fs.update(f.guard, raw);
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS);
    expect(tryAcquireExclusiveLock(PATH, f.options(202))).toBe(false);
    f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
    expect(tryAcquireExclusiveLock(PATH, f.options(202))).toBe(true);
    expect(f.fs.paths()).toEqual([PATH]);
  },
);

test("F4: guard vanishing before its age stat backs off and the next attempt re-evaluates", () => {
  const f = abandonedGuard();
  f.setAge(RECLAIM_GUARD_ABANDON_AGE_MS + 1);
  const racer = new Racer(acquireExclusiveLockSteps(PATH, f.options(202)));
  racer.until((step) => step.op === "stat" && step.path === f.guard);
  f.fs.unlink(f.guard);
  expect(racer.finish()).toBe(false);
  expect(f.fs.readText(PATH)).toBe("99");
  expect(tryAcquireExclusiveLock(PATH, f.options(202))).toBe(true);
  expect(f.fs.paths()).toEqual([PATH]);
});

test("F2: a private tmp write EEXIST is a warned fallback, only link EEXIST is contention", () => {
  const f = fixture();
  f.fs.unlink(PATH);
  const write = spyOn(f.fs, "writeFile").mockImplementation(() => {
    throw Object.assign(new Error("tmp write failure"), { code: "EEXIST" });
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(f.acquire(101).finish()).toBe(true);
    exactHolder(f.fs, 101);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.fs.paths()).toEqual([PATH]);
  } finally {
    write.mockRestore();
    warn.mockRestore();
  }
});
