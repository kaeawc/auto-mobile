import { expect, spyOn, test } from "bun:test";
import {
  releaseExclusiveLock,
  releaseExclusiveLockSteps,
  readLockOwnerPid,
  formatLockContent,
  acquireExclusiveLockSteps,
  takeOverExclusiveLock,
  readExclusiveLockContent,
} from "../../src/utils/fileLock";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { logger } from "../../src/utils/logger";
import {
  fixture,
  Racer,
  PATH,
  retainedFixture,
  runRetainedSchedule,
  prefix,
} from "./fileLockRaceHarness";

const F = `${PATH}.displaced`;
const raw = (pid: number) =>
  formatLockContent(pid, `owner-${pid}`, undefined, "current-generation");

function retained() {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    return retainedFixture();
  } finally {
    warn.mockRestore();
  }
}

test.each([false, true])(
  "seed 6002: owner release between an acquirer's sample of the retained marker and its restore never resurrects the lock (link first: %s)",
  (linkFirst) => {
    const f = retained();
    const acquirer = f.acquire(303);
    untilComplete(acquirer, f);
    if (linkFirst) {
      acquirer.advance();
    }
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(acquirer.finish()).toBe(false);
    expect(f.fs.paths()).toEqual([]);
    expect(f.acquire(404).finish()).toBe(true);
  },
);

test("two-holder: with no hard links and a failed copy the next acquirer does not get the lock while the displaced holder holds it", () => {
  const f = retained();
  f.fs.linkError = "ENOTSUP";
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(f.acquire(303).finish()).toBe(false);
      expect(f.fs.paths()).toEqual([F]);
      expect(f.fs.readText(F)).toBe(raw(101));
      expect(readLockOwnerPid(PATH, (pid) => f.live.has(pid), undefined, f.fs)).toBe(101);
    }
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.paths()).toEqual([]);
    expect(f.acquire(303).finish()).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("third acquirer publishing during the retain window is not clobbered", () => {
  const f = fixture();
  const reclaimer = f.acquire(202);
  reclaimer.until((step) => step.op === "rename" && step.path === PATH);
  f.fs.update(PATH, raw(101));
  f.fs.failure = (op, path) =>
    path === PATH
      ? op === "link"
        ? "ENOTSUP"
        : op === "openExclusive"
          ? "ENOSPC"
          : undefined
      : undefined;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    // Old code's exists(P) / rename(m,P) boundary; RETAIN instead samples F.
    reclaimer.until(
      (step) =>
        (step.op === "stat" && step.path === F) || (step.op === "exists" && step.path === PATH),
    );
    if (!reclaimer.pending.done && reclaimer.pending.value.op === "exists") {
      reclaimer.advance();
    }
    f.fs.failure = undefined;
    expect(f.acquire(303).finish()).toBe(true);
    expect(reclaimer.finish()).toBe(false);
    expect(f.fs.readText(PATH)).toBe(raw(303));
    expect(f.fs.readText(F)).toBe(raw(101));
  } finally {
    warn.mockRestore();
  }
});

function untilComplete(acquirer: Racer<boolean>, f: ReturnType<typeof fixture>): void {
  acquirer.until(
    (step) =>
      step.op === "link" &&
      step.path === PATH &&
      !f.fs.exists(PATH) &&
      acquirer.trace.some((s) => s.op === "rename" && s.path === PATH),
  );
}

test("retained marker + working links: the next acquirer restores it to the lock path and returns false", () => {
  const f = retained();
  expect(f.acquire(303).finish()).toBe(false);
  expect(f.fs.readText(PATH)).toBe(raw(101));
  expect(f.fs.stat(PATH)).toEqual(f.fs.stat(F));
  expect(f.fs.paths()).toEqual([PATH, F]);
  releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
  expect(f.fs.paths()).toEqual([]);
});

const RELEASE_POINTS = [
  "before read",
  "between read and rename",
  "between rename and unlink",
  "after",
] as const;
test.each(
  RELEASE_POINTS.flatMap((point) => [true, false].map((linkFirst) => ({ point, linkFirst }))),
)("release vs restore, all orders: %j", ({ point, linkFirst }) => {
  const f = retained();
  const acquirer = f.acquire(303);
  untilComplete(acquirer, f);
  const release = new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs));
  if (point === "between read and rename") {
    release.until((s) => s.op === "rename" && s.path === F);
  }
  if (point === "between rename and unlink") {
    release.until((s) => s.op === "unlink" && s.path.includes(".release."));
  }
  if (point === "after") {
    release.finish();
  }
  if (linkFirst) {
    acquirer.advance();
  }
  release.finish();
  expect(acquirer.finish()).toBe(false);
  expect(f.fs.paths()).toEqual([]);
  expect(f.acquire(404).finish()).toBe(true);
});

test("restored lock stays named by both P and F: live contention and repeated RETAIN leave F untouched", () => {
  const f = retained();
  expect(f.acquire(303).finish()).toBe(false);
  for (const pid of [202, 303, 404]) {
    f.fs.operations.length = 0;
    expect(f.acquire(pid).finish()).toBe(false);
    expect(f.fs.operations).toEqual([
      { op: "stat", path: PATH },
      { op: "readText", path: PATH },
    ]);
    expect(f.fs.readText(F)).toBe(raw(101));
  }
  // A stale releaser claims the linked owner's instance; RETAIN detects the same F.
  f.fs.seed(PATH, raw(202));
  const release = new Racer(releaseExclusiveLockSteps(PATH, 202, "owner-202", f.fs));
  release.until((s) => s.op === "rename" && s.path === PATH);
  f.fs.unlink(PATH);
  f.fs.link(F, PATH);
  f.fs.failure = (op, path) =>
    path === PATH
      ? op === "link"
        ? "ENOTSUP"
        : op === "openExclusive"
          ? "ENOSPC"
          : undefined
      : undefined;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    release.finish();
    expect(f.fs.paths()).toEqual([F]);
    expect(f.fs.readText(F)).toBe(raw(101));
    f.fs.failure = undefined;
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.paths()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

test.each([true, false])(
  "restored lock stays named by both P and F: dead owner (same instance: %s)",
  (linked) => {
    const f = fixture(raw(101));
    f.live.delete(101);
    const guard = `${prefix(f.fs)}.0`;
    if (linked) {
      f.fs.link(PATH, F);
    } else {
      f.fs.seed(F, raw(101));
    }
    const acquirer = f.acquire(303);
    acquirer.until((s) => s.op === "rename" && s.path === F);
    expect(f.fs.readText(guard)).toBe(raw(303));
    if (!acquirer.pending.done) {
      acquirer.advance();
    }
    expect(acquirer.finish()).toBe(true);
    expect(f.fs.paths()).toEqual([PATH]);
    expect(f.fs.readText(PATH)).toBe(raw(303));
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.fs.paths()).toEqual([]);
  },
);

test.each([false, true])(
  "retained marker of a dead owner never blocks (live guard: %s)",
  (guardHeld) => {
    const f = fixture("99\nstale");
    const guard = `${prefix(f.fs)}.0`;
    f.fs.rename(PATH, F);
    if (guardHeld) {
      f.fs.seed(guard, raw(202));
    }
    expect(f.acquire(303).finish()).toBe(true);
    expect(f.fs.readText(PATH)).toBe(raw(303));
    expect(f.fs.paths()).toEqual(guardHeld ? [PATH, F, guard].sort() : [PATH]);
    if (guardHeld) {
      expect(f.fs.readText(F)).toBe("99\nstale");
      expect(f.fs.operations.some((s) => s.op === "rename" && s.path === F)).toBe(false);
    }
  },
);

test("the V2 takeover schedule: a restorer never removes a retained marker", () => {
  const f = retained();
  const restorer = f.acquire(303);
  untilComplete(restorer, f);
  restorer.advance(); // COMPLETE is link-only, so there is no later F cleanup.
  const ownerRelease = new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs));
  ownerRelease.until((s) => s.op === "rename" && s.path === PATH);
  expect(takeOverExclusiveLock(PATH, { pid: 101, token: "owner-101" }, f.options(202))).toBe(true);
  f.fs.failure = (op, path) =>
    path === PATH
      ? op === "link"
        ? "ENOTSUP"
        : op === "openExclusive"
          ? "ENOSPC"
          : undefined
      : undefined;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    ownerRelease.finish();
    expect(restorer.finish()).toBe(false);
    expect(f.fs.readText(F)).toBe(raw(202));
    f.fs.failure = undefined;
    expect(f.acquire(404).finish()).toBe(false);
    expect(f.fs.readText(PATH)).toBe(raw(202));
    releaseExclusiveLock(PATH, 202, "owner-202", f.fs);
    expect(f.acquire(404).finish()).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("takeover crash with a live previous owner", () => {
  const f = retained();
  expect(f.acquire(303).finish()).toBe(false);
  // Takeover uses reclaimExclusiveLock; generation evidence exercises that same
  // generator without exposing the private takeover scheduling seam.
  const taker = new Racer(
    acquireExclusiveLockSteps(PATH, {
      ...f.options(202),
      ownerGeneration: {
        current: () => "current-generation",
        compare: (pid) => (pid === 101 ? "different" : "same"),
      },
    }),
  );
  taker.until((s) => s.op === "stat" && s.path === F);
  expect(f.fs.readText(PATH)).toBe(raw(202));
  f.live.delete(202); // Crash before inspecting/removing the previous owner's F.
  expect(f.acquire(303).finish()).toBe(false);
  expect(f.fs.readText(PATH)).toBe(raw(101));
  expect(f.fs.stat(PATH)).toEqual(f.fs.stat(F));
  releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
  expect(f.fs.exists(PATH)).toBe(false);
  expect(f.fs.exists(F)).toBe(false);
  expect(f.acquire(404).finish()).toBe(true);
});

test("back-out versus a fourth acquirer", () => {
  const f = retained();
  const c = f.acquire(303);
  untilComplete(c, f);
  const d = f.acquire(404);
  d.until((s) => s.op === "stat" && s.path === F);
  expect(f.fs.readText(PATH)).toBe(raw(404));
  expect(c.finish()).toBe(false); // COMPLETE encounters D's exclusive publication.
  expect(d.finish()).toBe(false);
  expect(f.fs.readText(PATH)).toBe(raw(101));
  expect(f.fs.stat(PATH)).toEqual(f.fs.stat(F));
});

test("in-flight window residual (documented R2)", () => {
  const f = fixture(raw(202));
  const release = new Racer(releaseExclusiveLockSteps(PATH, 202, "owner-202", f.fs));
  release.until((s) => s.op === "rename" && s.path === PATH);
  f.fs.seed(PATH, raw(101));
  release.until((s) => s.op === "link" && s.path === PATH);
  // Pre-existing R2: only the private marker names 101, so release misses it
  // and a third actor can publish before the displacer's exclusive restore.
  releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
  expect(f.acquire(303).finish()).toBe(true);
  release.finish();
  expect(f.fs.paths()).toEqual([PATH]);
  expect(f.fs.readText(PATH)).toBe(raw(303));
});

test.each([false, true])(
  "stale releaser displaces the lock during its owner's release: documented residual (copy: %s)",
  (copy) => {
    const f = fixture(raw(808));
    for (const pid of [808, 707, 1001]) {
      f.live.add(pid);
    }
    const stale = new Racer(releaseExclusiveLockSteps(PATH, 808, "owner-808", f.fs));
    stale.until((s) => s.op === "rename" && s.path === PATH);
    expect(takeOverExclusiveLock(PATH, { pid: 808, token: "owner-808" }, f.options(707))).toBe(
      true,
    );
    releaseExclusiveLock(PATH, 707, "owner-707", f.fs);
    expect(f.acquire(1001).finish()).toBe(true);
    const publicationIno = f.fs.peek(PATH)?.ino;
    const ownerRelease = new Racer(releaseExclusiveLockSteps(PATH, 1001, "owner-1001", f.fs));
    ownerRelease.advance(); // F is absent; A's release started with its inode still at P.
    expect(ownerRelease.pending.value).toEqual({ op: "readText", path: PATH });
    expect(f.fs.peek(PATH)?.ino).toBe(publicationIno);
    stale.advance(); // X moves A's inode only after A's release has started (seed 1255).
    const marker = f.fs.paths().find((name) => name.includes(".808.release."))!;
    expect(f.fs.peek(marker)?.ino).toBe(publicationIno);
    expect(f.fs.peek(PATH)).toBeUndefined();
    expect(f.fs.peek(F)).toBeUndefined();
    expect(ownerRelease.finish()).toBeUndefined();
    expect(ownerRelease.trace).toEqual([
      { op: "readText", path: F },
      { op: "readText", path: PATH },
    ]);
    f.fs.linkError = copy ? "ENOTSUP" : undefined;
    stale.finish();
    f.fs.linkError = undefined;
    expect(f.fs.peek(PATH)?.raw).toBe(raw(1001));
    expect(f.fs.peek(PATH)?.ino === publicationIno).toBe(!copy);
    expect(f.fs.peek(F)).toBeUndefined();
    // R2: the owner cannot find X's private marker; release the restored lock once on A's behalf.
    releaseExclusiveLock(PATH, 1001, "owner-1001", f.fs);
    expect(f.acquire(404).finish()).toBe(true);
  },
);

test("legacy wx writer displaced before its write is the documented residual", () => {
  const f = fixture(raw(808));
  for (const pid of [808, 707, 1101, 1001]) {
    f.live.add(pid);
  }
  const x = new Racer(releaseExclusiveLockSteps(PATH, 808, "owner-808", f.fs));
  x.until((s) => s.op === "rename" && s.path === PATH);
  expect(takeOverExclusiveLock(PATH, { pid: 808, token: "owner-808" }, f.options(707))).toBe(true);
  releaseExclusiveLock(PATH, 707, "owner-707", f.fs);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    f.fs.linkError = "ENOTSUP";
    const a = f.acquire(1101);
    a.until((s) => s.op === "write" && s.path === PATH);
    const publicationIno = f.fs.peek(PATH)?.ino;
    expect(f.fs.peek(PATH)?.raw).toBe("");
    f.fs.linkError = undefined;
    x.advance();
    const marker = f.fs.paths().find((name) => name.includes(".808.release."))!;
    expect(f.fs.peek(marker)?.ino).toBe(publicationIno);
    const c = f.acquire(1001);
    c.until((s) => s.op === "stat" && s.path === F);
    // At C's publication, A's still-empty inode is private: the legacy form of the residual.
    expect(f.fs.peek(marker)?.raw).toBe("");
    expect(f.fs.peek(PATH)?.raw).toBe(raw(1001));
    expect(f.fs.peek(F)).toBeUndefined();
    expect(a.finish()).toBe(true);
    expect(c.finish()).toBe(true);
    expect(f.fs.peek(marker)?.ino).toBe(publicationIno);
    expect(f.fs.peek(marker)?.raw).toBe(raw(1101));
    releaseExclusiveLock(PATH, 1101, "owner-1101", f.fs);
    x.finish(); // EEXIST drops only the displaced publication; C stays named.
    expect(f.fs.paths()).toEqual([PATH]);
    releaseExclusiveLock(PATH, 1001, "owner-1001", f.fs);
    expect(f.fs.paths()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

test.each(["stat", "readText"] as const)(
  "undecidable retained %s backs out without retrying P",
  (op) => {
    const f = retained();
    const failure = spyOn(f.fs, op).mockImplementation((path) => {
      if (path === F) {
        throw Object.assign(new Error("unreadable retained marker"), { code: "EACCES" });
      }
      return FakeLockFileSystem.prototype[op].call(f.fs, path);
    });
    try {
      const acquirer = f.acquire(303);
      expect(acquirer.finish()).toBe(false);
      expect(acquirer.trace.filter((s) => s.op === "stat" && s.path === PATH)).toHaveLength(1);
      expect(f.fs.readText(PATH)).toBe(raw(101));
    } finally {
      failure.mockRestore();
    }
  },
);

test("retained readers apply generation liveness and preserve readable P precedence", () => {
  const f = retained();
  expect(readExclusiveLockContent(PATH, f.fs)).toEqual({
    pid: 101,
    token: "owner-101",
    generation: "current-generation",
  });
  expect(readLockOwnerPid(PATH, () => false, undefined, f.fs)).toBeUndefined();
  expect(
    readLockOwnerPid(
      PATH,
      () => true,
      { current: () => undefined, compare: () => "different" },
      f.fs,
    ),
  ).toBeUndefined();
  f.fs.seed(PATH, raw(303));
  f.fs.operations.length = 0;
  expect(readExclusiveLockContent(PATH, f.fs)?.pid).toBe(303);
  expect(f.fs.operations).toEqual([{ op: "readText", path: PATH }]);
});

test.each([
  34,
  ...Array.from({ length: 32 }, (_, i) => 6001 + i),
  4939,
  7749,
  8581,
  11767,
  1714,
  5158,
  10138,
  17165,
])("retained property seed %d", (seed) => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    runRetainedSchedule(seed);
  } finally {
    warn.mockRestore();
  }
});

test("takeover removes a still-live same-instance F under its existing guard", () => {
  const f = retained();
  expect(takeOverExclusiveLock(PATH, { pid: 101, token: "owner-101" }, f.options(202))).toBe(false);
  expect(f.acquire(303).finish()).toBe(false);
  f.fs.operations.length = 0;
  expect(takeOverExclusiveLock(PATH, { pid: 101, token: "owner-101" }, f.options(202))).toBe(true);
  expect(
    f.fs.operations.filter(
      (s) => s.op === "link" && s.path.includes(".reclaim.") && !s.path.endsWith(".tmp"),
    ),
  ).toHaveLength(1);
  expect(f.fs.paths()).toEqual([PATH]);
  expect(f.fs.readText(PATH)).toBe(raw(202));
  releaseExclusiveLock(PATH, 202, "owner-202", f.fs);
  expect(f.fs.paths()).toEqual([]);
});

test.each([false, true])(
  "F-first release restores a foreign claimed marker (unreadable: %s)",
  (unreadable) => {
    const f = retained();
    const release = new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs));
    release.until((s) => s.op === "rename" && s.path === F);
    f.fs.seed(F, raw(202));
    release.advance();
    const read = spyOn(f.fs, "readText").mockImplementation((path) => {
      if (unreadable && path.includes(".release.")) {
        throw Object.assign(new Error("read denied"), { code: "EACCES" });
      }
      return FakeLockFileSystem.prototype.readText.call(f.fs, path);
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      release.finish();
      expect(f.fs.paths()).toEqual([F]);
      expect(f.fs.readText(F)).toBe(raw(202));
      expect(f.acquire(404).finish()).toBe(false);
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  },
);

test("a failed F-release rename leaves F and does not unlink it unguarded", () => {
  const f = retained();
  f.fs.failure = (op, path) => (op === "rename" && path === F ? "EACCES" : undefined);
  releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
  expect(f.fs.paths()).toEqual([F]);
  expect(f.fs.operations.some((s) => s.op === "unlink" && s.path === F)).toBe(false);
});

test.each(["different", "mtime changed", "unreadable"] as const)(
  "RETAIN preserves an existing F (%s)",
  (kind) => {
    const f = fixture(raw(202));
    const release = new Racer(releaseExclusiveLockSteps(PATH, 202, "owner-202", f.fs));
    release.until((s) => s.op === "rename" && s.path === PATH);
    f.fs.seed(PATH, raw(101));
    f.fs.failure = (op, path) => {
      if (path !== PATH) {
        return undefined;
      }
      return op === "link" ? "ENOTSUP" : op === "openExclusive" ? "ENOSPC" : undefined;
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      release.until((s) => s.op === "stat" && s.path === F);
      const marker = f.fs.paths().find((path) => path.includes(".release."));
      expect(marker).toBeDefined();
      if (!marker) {
        throw new Error("Missing private marker");
      }
      if (kind === "mtime changed") {
        f.fs.link(marker, F);
      } else {
        f.fs.seed(F, raw(303));
      }
      release.advance(); // Capture F identity before changing the linked instance's mtime.
      if (kind === "mtime changed") {
        f.fs.update(F, raw(101), f.clock.now() + 1);
      }
      const read = spyOn(f.fs, "readText").mockImplementation((path) => {
        if (kind === "unreadable" && path === F) {
          throw Object.assign(new Error("read denied"), { code: "EACCES" });
        }
        return FakeLockFileSystem.prototype.readText.call(f.fs, path);
      });
      try {
        release.finish();
        expect(f.fs.paths()).toEqual([F, marker].sort());
        expect(f.fs.readText(marker)).toBe(raw(101));
        expect(FakeLockFileSystem.prototype.readText.call(f.fs, F)).toBe(
          kind === "mtime changed" ? raw(101) : raw(303),
        );
      } finally {
        read.mockRestore();
      }
    } finally {
      warn.mockRestore();
    }
  },
);

test.each(["before rename", "after rename"] as const)(
  "guarded retained removal verifies the instance %s",
  (point) => {
    const f = fixture("99\nstale");
    f.fs.rename(PATH, F);
    const acquirer = f.acquire(303);
    acquirer.until((s) => s.op === "rename" && s.path === F);
    if (point === "after rename") {
      acquirer.advance();
      f.fs.seed(`${PATH}.303.reclaim`, raw(101));
    } else {
      f.fs.seed(F, raw(101));
    }
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(acquirer.finish()).toBe(true);
      expect(f.fs.readText(F)).toBe(raw(101));
      expect(f.fs.readText(PATH)).toBe(raw(303));
      expect(f.fs.paths()).toEqual([PATH, F]);
    } finally {
      warn.mockRestore();
    }
  },
);

test.each(["link", "openExclusive", "writeFile", "rename", "unlink"] as const)(
  "per-call fake failure records %s and preserves legacy fields",
  (op) => {
    const fs = new FakeLockFileSystem();
    fs.seed(PATH, raw(101));
    fs.failure = (actual, path) => (actual === op && path === PATH ? "ENOSPC" : undefined);
    const action = () => {
      switch (op) {
        case "link":
          return fs.link(F, PATH);
        case "openExclusive":
          return fs.openExclusive(PATH);
        case "writeFile":
          return fs.writeFile(PATH, "changed");
        case "rename":
          return fs.rename(PATH, F);
        case "unlink":
          return fs.unlink(PATH);
      }
    };
    expect(action).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(fs.operations.at(-1)).toEqual({ op, path: PATH });
    expect(fs.readText(PATH)).toBe(raw(101));
    fs.failure = undefined;
    fs.linkError = "ENOTSUP";
    expect(() => fs.link(PATH, F)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
  },
);

test.each(["atomic", "legacy-wx"] as const)(
  "own publication retained before the post-check (atomic holds; legacy-wx waits): %s",
  (publication) => {
    const f = fixture(raw(101));
    f.live.add(707);
    const stale = new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs));
    stale.until((s) => s.op === "rename" && s.path === PATH);
    expect(takeOverExclusiveLock(PATH, { pid: 101, token: "owner-101" }, f.options(707))).toBe(
      true,
    );
    releaseExclusiveLock(PATH, 707, "owner-707", f.fs);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      if (publication === "legacy-wx") {
        f.fs.linkError = "ENOTSUP";
      }
      const acquirer = f.acquire(303);
      acquirer.until((s) => s.op === "stat" && s.path === F);
      f.fs.failure = (op, path) =>
        path === PATH
          ? op === "link"
            ? "ENOTSUP"
            : op === "openExclusive"
              ? "ENOSPC"
              : undefined
          : undefined;
      stale.finish();
      expect(f.fs.readText(F)).toBe(raw(303));
      expect(f.fs.exists(PATH)).toBe(false);
      f.fs.failure = undefined;
      expect(acquirer.finish()).toBe(publication === "atomic");
      expect(f.fs.peek(PATH)?.raw).toBe(publication === "atomic" ? raw(303) : undefined);
      expect(f.fs.peek(F)?.raw).toBe(raw(303));
      expect(f.acquire(404).finish()).toBe(false);
      expect(f.fs.peek(PATH)?.raw).toBe(publication === "atomic" ? raw(303) : undefined);
      releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
      expect(f.fs.paths()).toEqual([]);
      expect(f.acquire(404).finish()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  },
);

test("same-owner older instance at F with the new publication still at P backs out", () => {
  const f = fixture(raw(303));
  f.fs.rename(PATH, F);
  const old = f.fs.stat(F);
  const acquirer = new Racer(
    acquireExclusiveLockSteps(PATH, { ...f.options(303), reclaimOwnPid: true }),
  );
  expect(acquirer.finish()).toBe(false); // #2947: the matching in-process incarnation is held.
  expect(f.fs.stat(PATH)).toEqual(old);
  expect(f.fs.stat(F)).toEqual(old);
});

test("back-out whose marker unlink fails leaves P free and warns", () => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  f.fs.operations.length = 0;
  f.fs.failure = (op, path) => {
    if (op === "unlink" && path.includes(".303.release.")) {
      return "EPERM";
    }
    if (op === "link" && path === PATH && !f.fs.paths().includes(PATH)) {
      // Let publication succeed; deny COMPLETE so the free P can be inspected.
      return f.fs.paths().some((name) => name.includes(".303.release.")) ? "ENOTSUP" : undefined;
    }
    return undefined;
  };
  try {
    expect(f.acquire(303).finish()).toBe(false);
    expect(f.fs.exists(PATH)).toBe(false);
    const marker = f.fs.paths().find((name) => name.includes(".303.release."));
    expect(marker).toBeDefined();
    expect(f.fs.readText(marker!)).toBe(raw(303));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PATH));
    expect(f.fs.operations.filter((op) => op.op === "link" && op.path === PATH)).toHaveLength(2);
  } finally {
    warn.mockRestore();
  }
});

test.each(["rename", "readText"] as const)(
  "R2: transient back-out %s failure is retried immediately",
  (op) => {
    const f = retained();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const acquirer = f.acquire(303);
    acquirer.until((s) => s.op === "stat" && s.path === F);
    let failures = 2;
    f.fs.failure = (actual, path) =>
      actual === op && path === PATH && failures-- > 0 ? "EPERM" : undefined;
    try {
      expect(acquirer.finish()).toBe(false);
      expect(failures).toBeLessThan(0);
      expect(f.fs.peek(PATH)?.raw).toBe(raw(101));
      assertNoPendingOperations(f);
    } finally {
      warn.mockRestore();
    }
  },
);

function assertNoPendingOperations(f: ReturnType<typeof fixture>): void {
  f.fs.failure = undefined;
  f.fs.operations.length = 0;
  expect(f.acquire(303).finish()).toBe(false);
  expect(f.fs.operations).toEqual([
    { op: "stat", path: PATH },
    { op: "readText", path: PATH },
  ]);
}

function strandBackOut(op: "readText" | "rename", f: ReturnType<typeof fixture>) {
  const acquirer = f.acquire(303);
  acquirer.until((s) => s.op === "stat" && s.path === F);
  f.fs.operations.length = 0;
  f.fs.failure = (actual, path) => (actual === op && path === PATH ? "EBUSY" : undefined);
  expect(acquirer.finish()).toBe(false);
  expect(f.fs.peek(PATH)?.raw).toBe(raw(303));
  expect(f.fs.operations.filter((s) => s.op === op && s.path === PATH)).toHaveLength(3);
  f.fs.failure = undefined;
  return f;
}

test.each(["rename", "readText"] as const)(
  "R2: persistent back-out %s failure is remembered and drained by the same process's next acquire",
  (op) => {
    const f = retained();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      strandBackOut(op, f);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(PATH));
      expect(f.acquire(303).finish()).toBe(false);
      expect(f.fs.peek(PATH)?.raw).toBe(raw(101));
      assertNoPendingOperations(f);
      releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
      expect(f.acquire(404).finish()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  },
);

test.each(["release", "takeover"] as const)(
  "R2: pending back-out is drained first by %s",
  (call) => {
    const f = retained();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      strandBackOut("rename", f);
      f.fs.operations.length = 0;
      if (call === "release") {
        releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
      } else {
        expect(takeOverExclusiveLock(PATH, { pid: 303, token: "owner-303" }, f.options(303))).toBe(
          false,
        );
      }
      expect(f.fs.operations[0]).toEqual({ op: "readText", path: PATH });
      expect(f.fs.peek(PATH)).toBeUndefined();
      f.fs.operations.length = 0;
      releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
      expect(f.fs.operations).toEqual([
        { op: "readText", path: F },
        { op: "readText", path: PATH },
      ]);
      releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
      expect(f.acquire(404).finish()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  },
);

test.each(["stat", "rename"] as const)("retained %s failure warns naming F", (op) => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  f.fs.failure = (actual, path) => (actual === op && path === F ? "EACCES" : undefined);
  try {
    if (op === "stat") {
      expect(f.acquire(303).finish()).toBe(false);
    } else {
      releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(F), expect.anything());
    expect(f.fs.readText(F)).toBe(raw(101));
  } finally {
    warn.mockRestore();
  }
});

// X's read predates A; every later link is unsupported, including C's publication.
function ownRetainedWithPeer() {
  const f = fixture(raw(101));
  f.live.add(707);
  const stale = new Racer(releaseExclusiveLockSteps(PATH, 101, "owner-101", f.fs));
  stale.until((s) => s.op === "rename" && s.path === PATH);
  expect(takeOverExclusiveLock(PATH, { pid: 101, token: "owner-101" }, f.options(707))).toBe(true);
  releaseExclusiveLock(PATH, 707, "owner-707", f.fs);
  const a = f.acquire(303);
  a.until((s) => s.op === "stat" && s.path === F);
  f.fs.linkError = "ENOTSUP";
  stale.until((s) => s.op === "link" && s.path === PATH);
  const c = f.acquire(404);
  expect(c.finish()).toBe(true); // F is still absent at C's post-check.
  let failCopyRead = true;
  f.fs.failure = (op, path) => {
    if (failCopyRead && op === "readText" && path.includes(".101.release.")) {
      failCopyRead = false;
      return "EIO";
    }
    return undefined;
  };
  stale.finish();
  f.fs.failure = undefined;
  expect(f.fs.peek(F)?.raw).toBe(raw(303));
  expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
  return { f, a, c };
}

test("R1: an own publication retained at F does not hold when P is another holder's", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const { f, a, c } = ownRetainedWithPeer();
    expect(a.finish()).toBe(false);
    expect(c.pending.value).toBe(true); // C is the only believer.
    expect(f.fs.peek(F)).toBeUndefined();
    expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
    releaseExclusiveLock(PATH, 404, "owner-404", f.fs);
    expect(f.acquire(202).finish()).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("R1: an unreadable P is not read as free", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const { f, a } = ownRetainedWithPeer();
    f.fs.operations.length = 0;
    f.fs.failure = (op, path) => (op === "readText" && path === PATH ? "EIO" : undefined);
    expect(a.finish()).toBe(false);
    expect(f.fs.peek(F)).toBeUndefined();
    expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
    expect(f.fs.operations.filter((s) => s.path === PATH)).toEqual([
      { op: "readText", path: PATH },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("R2: drained back-out with other bytes now at P leaves them alone and drops the entry", () => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    strandBackOut("rename", f);
    f.fs.seed(PATH, raw(404));
    f.fs.operations.length = 0;
    expect(f.acquire(303).finish()).toBe(false);
    expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
    expect(f.fs.operations).toEqual([
      { op: "readText", path: PATH },
      { op: "stat", path: PATH },
      { op: "readText", path: PATH },
    ]);
    assertNoPendingOperations(f);
  } finally {
    warn.mockRestore();
  }
});

test("R2: pending-map capacity is 64 paths and evicts the oldest", () => {
  const f = fixture();
  f.fs.unlink(PATH);
  const paths = Array.from({ length: 65 }, (_, i) => `${PATH}.capacity-${i}`);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    for (const path of paths) {
      f.fs.seed(`${path}.displaced`, raw(101));
      f.fs.failure = (op, name) => (op === "rename" && name === path ? "EBUSY" : undefined);
      expect(new Racer(acquireExclusiveLockSteps(path, f.options(303))).finish()).toBe(false);
      expect(f.fs.peek(path)?.raw).toBe(raw(303));
    }
    f.fs.failure = undefined;
    for (const [i, path] of paths.entries()) {
      f.fs.operations.length = 0;
      releaseExclusiveLock(path, 404, "owner-404", f.fs);
      expect(f.fs.peek(path)?.raw).toBe(i === 0 ? raw(303) : undefined);
      expect(f.fs.operations[0]).toEqual({
        op: "readText",
        path: i === 0 ? `${path}.displaced` : path,
      });
    }
  } finally {
    warn.mockRestore();
  }
});

function pendingMarkerRacers(f: ReturnType<typeof fixture>, count: number) {
  const racers: Racer<boolean>[] = [];
  for (let i = 0; i < count; i++) {
    const racer = f.acquire(303);
    racer.until((s) => s.op === "unlink" && s.path.includes(".303.release."));
    racers.push(racer);
  }
  return racers;
}

function leakMarkers(f: ReturnType<typeof fixture>, racers: Racer<boolean>[]): string[] {
  const markers = racers.map((r) => (r.pending.done ? "" : r.pending.value.path));
  f.fs.failure = (op, path) => {
    if (op === "unlink" && markers.includes(path)) {
      return "EPERM";
    }
    return op === "link" && path === PATH ? "ENOTSUP" : undefined;
  };
  for (const racer of racers) {
    expect(racer.finish()).toBe(false);
  }
  f.fs.failure = undefined;
  return markers;
}

test("R2: pending-map capacity is 8 markers and evicts the oldest", () => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const markers = leakMarkers(f, pendingMarkerRacers(f, 9));
    f.fs.operations.length = 0;
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.fs.operations.slice(0, 8)).toEqual(
      markers.slice(1).map((path) => ({ op: "unlink", path })),
    );
    expect(f.fs.paths()).toEqual([F, markers[0]].sort());
    f.fs.operations.length = 0;
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.fs.operations).toEqual([
      { op: "readText", path: F },
      { op: "readText", path: PATH },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("R2: leaked-marker drain retries a transient unlink and removes the remembered marker", () => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const [marker] = leakMarkers(f, pendingMarkerRacers(f, 1));
    let failures = 2;
    f.fs.failure = (op, path) =>
      op === "unlink" && path === marker && failures-- > 0 ? "EBUSY" : undefined;
    f.fs.operations.length = 0;
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.fs.operations.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => ({ op: "unlink", path: marker })),
    );
    expect(f.fs.paths()).toEqual([F]);
    f.fs.failure = undefined;
    f.fs.operations.length = 0;
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.fs.operations).toEqual([
      { op: "readText", path: F },
      { op: "readText", path: PATH },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("drain adds no fs operation when nothing is pending", () => {
  const f = fixture(raw(101));
  assertNoPendingOperations(f);
  f.fs.operations.length = 0;
  releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
  expect(f.fs.operations).toEqual([
    { op: "readText", path: F },
    { op: "readText", path: PATH },
  ]);
});

test.each(["readText", "rename", "verification", "unlink"] as const)(
  "R2: back-out retries a transient %s marker/removal failure and leaves no pending entry",
  (step) => {
    const f = retained();
    const acquirer = f.acquire(303);
    acquirer.until((s) => s.op === "stat" && s.path === F);
    let failures = 2;
    f.fs.failure = (op, path) => {
      const matches =
        step === "verification"
          ? op === "readText" && path.includes(".303.release.")
          : op === step && (step === "unlink" ? path.includes(".303.release.") : path === PATH);
      return matches && failures-- > 0 ? "EIO" : undefined;
    };
    expect(acquirer.finish()).toBe(false);
    expect(failures).toBe(-1);
    expect(f.fs.paths()).toEqual([PATH, F]);
    assertNoPendingOperations(f);
  },
);

test.each([PATH, F])("release retries a transient claim failure and releases (%s)", (name) => {
  const f = fixture(raw(101));
  if (name === F) {
    f.fs.rename(PATH, F);
  }
  f.fs.operations.length = 0;
  let failures = 2;
  f.fs.failure = (op, path) =>
    op === "rename" && path === name && failures-- > 0 ? "EBUSY" : undefined;
  releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
  expect(f.fs.paths()).toEqual([]);
  expect(f.fs.operations.filter((s) => s.op === "rename" && s.path === name)).toHaveLength(3);
});

test.each([PATH, F])(
  "release retries a transient marker verification read and releases (%s)",
  (name) => {
    const f = fixture(raw(101));
    if (name === F) {
      f.fs.rename(PATH, F);
    }
    f.fs.operations.length = 0;
    let failures = 2;
    f.fs.failure = (op, path) =>
      op === "readText" && path.includes(".101.release.") && failures-- > 0 ? "EIO" : undefined;
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.paths()).toEqual([]);
    expect(
      f.fs.operations.filter((s) => s.op === "readText" && s.path.includes(".101.release.")),
    ).toHaveLength(3);
  },
);

test.each([PATH, F])(
  "release retries a transient marker-unlink failure and releases (%s)",
  (name) => {
    const f = fixture(raw(101));
    if (name === F) {
      f.fs.rename(PATH, F);
    }
    f.fs.operations.length = 0;
    let failures = 2;
    f.fs.failure = (op, path) =>
      op === "unlink" && path.includes(".101.release.") && failures-- > 0 ? "EBUSY" : undefined;
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.paths()).toEqual([]);
    expect(
      f.fs.operations.filter((s) => s.op === "unlink" && s.path.includes(".101.release.")),
    ).toHaveLength(3);
  },
);

test("release whose own lock read keeps failing leaves the lock in place (3 attempts, warned)", () => {
  const f = fixture(raw(101));
  const held = { ...f.fs.peek(PATH)! };
  f.fs.operations.length = 0;
  f.fs.failure = (op, path) => (op === "readText" && path === PATH ? "EIO" : undefined);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(() => releaseExclusiveLock(PATH, 101, "owner-101", f.fs)).not.toThrow();
    expect(f.fs.operations.filter((s) => s.op === "readText" && s.path === PATH)).toHaveLength(3);
    expect(f.fs.peek(PATH)).toEqual(held);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `Lock release read failed at ${PATH}; lock left in place`,
      "failed",
    );
    expect(f.acquire(202).finish()).toBe(false);
    expect(f.fs.peek(PATH)).toEqual(held);
    f.fs.failure = undefined;
    expect(f.acquire(202).finish()).toBe(false);
    expect(f.fs.peek(PATH)).toEqual(held);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.peek(PATH)).toBeUndefined();
    expect(f.acquire(202).finish()).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test.each([PATH, F])("release whose claim keeps failing warns and leaves the lock (%s)", (name) => {
  const f = fixture(raw(101));
  if (name === F) {
    f.fs.rename(PATH, F);
  }
  f.fs.operations.length = 0;
  f.fs.failure = (op, path) => (op === "rename" && path === name ? "EBUSY" : undefined);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.peek(name)?.raw).toBe(raw(101));
    expect(f.fs.operations.filter((s) => s.op === "rename" && s.path === name)).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(name), expect.anything());
  } finally {
    warn.mockRestore();
  }
});

test("PID reuse of the retained owner without a generation token reads as live", () => {
  const f = fixture("99\nold-owner");
  f.fs.rename(PATH, F);
  f.live.add(99); // The old owner exited; an unrelated live process reused its PID.
  expect(
    new Racer(
      acquireExclusiveLockSteps(PATH, { ...f.options(303), ownerGeneration: undefined }),
    ).finish(),
  ).toBe(false);
  expect(f.fs.peek(PATH)?.raw).toBe("99\nold-owner");
  expect(f.fs.peek(F)?.raw).toBe("99\nold-owner");
});

test("PID reuse with a generation token and a different probe removes F and acquires", () => {
  const f = fixture("99\nold-owner\n\nold-generation");
  f.fs.rename(PATH, F);
  f.live.add(99);
  expect(f.acquire(303).finish()).toBe(true);
  expect(f.fs.peek(F)).toBeUndefined();
  expect(f.fs.peek(PATH)?.raw).toBe(raw(303));
});

test("V1: an exhausted marker verification read during back-out is remembered and drained", () => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let failures = 0;
  f.fs.failure = (op, path) =>
    op === "readText" && path.includes(".202.release.") ? (failures++, "EIO") : undefined;
  try {
    expect(f.acquire(202).finish()).toBe(false);
    expect(failures).toBe(3);
    expect(f.fs.peek(PATH)?.raw).toBe(raw(202));
    f.fs.failure = undefined;
    expect(f.acquire(202).finish()).toBe(false);
    expect(f.fs.peek(PATH)?.raw).not.toBe(raw(202));
    expect(f.fs.peek(F)?.raw).toBe(raw(101));
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.acquire(303).finish()).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("V2: re-acquiring while holding through F never deletes the genuine hold", () => {
  const f = retained();
  const held = { ...f.fs.peek(F)! };
  // The stale displacer's read predates both new publications.
  f.fs.seed(PATH, raw(909));
  const stale = new Racer(releaseExclusiveLockSteps(PATH, 909, "owner-909", f.fs));
  stale.until((s) => s.op === "rename" && s.path === PATH);
  f.fs.unlink(PATH);
  const c = f.acquire(202);
  c.until((s) => s.op === "link" && s.path === PATH);
  const again = f.acquire(101);
  again.until((s) => s.op === "stat" && s.path === F);
  stale.until((s) => s.op === "link" && s.path === PATH);
  c.until((s) => s.op === "readText" && s.path === PATH);
  stale.finish(); // Restore encounters 202 at P: EEXIST, then drops its private marker.
  expect(again.finish()).toBe(false);
  expect(f.fs.peek(F)).toEqual(held);
  expect(c.finish()).toBe(false);
  expect(f.acquire(303).finish()).toBe(false);
  releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
  expect(f.acquire(303).finish()).toBe(true);
});

test("V2: own publication provably at F with P foreign removes F", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const { f, a } = ownRetainedWithPeer();
    expect(a.finish()).toBe(false);
    expect(f.fs.peek(F)).toBeUndefined();
    expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
  } finally {
    warn.mockRestore();
  }
});

test("V2: own publication provably at F with P the same instance holds", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const { f, a } = ownRetainedWithPeer();
    releaseExclusiveLock(PATH, 404, "owner-404", f.fs);
    f.fs.linkError = undefined;
    f.fs.link(F, PATH); // Another actor has already completed the retained restore.
    const held = { ...f.fs.peek(F)! };
    f.fs.operations.length = 0;
    expect(a.finish()).toBe(true);
    expect(f.fs.peek(PATH)).toEqual(held);
    expect(f.fs.peek(F)).toEqual(held);
    expect(f.fs.operations.some((s) => ["link", "rename"].includes(s.op))).toBe(false);
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.acquire(202).finish()).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("V1: a successful foreign marker verification restores without remembering a back-out", () => {
  const f = retained();
  const acquirer = f.acquire(202);
  acquirer.until((s) => s.op === "rename" && s.path === PATH);
  f.fs.seed(PATH, raw(303)); // The pending claim gets foreign bytes after its read of P.
  f.fs.operations.length = 0;
  expect(acquirer.finish()).toBe(false);
  expect(f.fs.peek(PATH)?.raw).toBe(raw(303));
  expect(
    f.fs.operations.filter((s) => s.op === "readText" && s.path.includes(".202.release.")),
  ).toHaveLength(1);
  assertNoPendingOperations(f);
});
