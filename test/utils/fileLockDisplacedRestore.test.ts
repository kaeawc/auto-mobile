import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  hasPendingBackOut,
  tryAcquireExclusiveLock,
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
      // An identity entry is located by stat first (fix pass 5, C1).
      expect(f.fs.operations[0]).toEqual({ op: "stat", path: PATH });
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
    // After F is claimed, P is sampled by identity only (S1): a foreign inode is never read or moved.
    expect(f.fs.operations.filter((s) => s.path === PATH)).toEqual([
      { op: "readText", path: PATH },
      { op: "stat", path: PATH },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("R2: drained back-out with another instance now at P leaves it alone and keeps the entry", () => {
  const f = retained();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    strandBackOut("rename", f);
    f.fs.seed(PATH, raw(404));
    for (let call = 0; call < 2; call++) {
      // The doomed publication was not verifiably removed (a displacer may link it back), so
      // the identity entry stays: one stat(P) per call, and a foreign inode is never touched.
      f.fs.operations.length = 0;
      expect(f.acquire(303).finish()).toBe(false);
      expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
      expect(f.fs.operations).toEqual([
        { op: "stat", path: PATH },
        { op: "stat", path: PATH },
        { op: "readText", path: PATH },
      ]);
    }
    expect(hasPendingBackOut(f.fs, PATH)).toBe(true);
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
      // A remembered identity entry is located by stat(P); the evicted path starts at release's F read.
      expect(f.fs.operations[0]).toEqual(
        i === 0 ? { op: "readText", path: `${path}.displaced` } : { op: "stat", path },
      );
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

test("V1: a successful foreign marker verification restores the foreign lock and remembers the unfound publication", () => {
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
  // S2: the back-out never claimed its own publication, so it is not complete; the identity
  // entry costs one stat(P) and never touches the restored foreign lock.
  expect(hasPendingBackOut(f.fs, PATH)).toBe(true);
  f.fs.operations.length = 0;
  expect(f.acquire(202).finish()).toBe(false);
  expect(f.fs.peek(PATH)?.raw).toBe(raw(303));
  expect(f.fs.operations).toEqual([
    { op: "stat", path: PATH },
    { op: "stat", path: PATH },
    { op: "readText", path: PATH },
  ]);
});

// ---- Fix pass 5: S1 (blocked branch), S2 (unfound back-out), S3 (tokenless reclaimOwnPid) ----

const failRestore = (op: string, path: string) =>
  path === PATH
    ? op === "link"
      ? "ENOTSUP"
      : op === "openExclusive"
        ? "ENOSPC"
        : undefined
    : undefined;
const linksToPath = (racer: Racer<boolean>) =>
  racer.trace.filter((s) => s.op === "link" && s.path === PATH).length;

/** P held by `taker`, plus a stale releaser of `pid` paused before rename(P): its read predates every later publication. */
function staleReleaser(f: ReturnType<typeof fixture>, pid: number, taker: number) {
  f.live.add(pid);
  f.live.add(taker);
  const stale = new Racer(releaseExclusiveLockSteps(PATH, pid, `owner-${pid}`, f.fs));
  stale.until((s) => s.op === "rename" && s.path === PATH);
  expect(takeOverExclusiveLock(PATH, { pid, token: `owner-${pid}` }, f.options(taker))).toBe(true);
  return stale;
}

function quiet<T>(body: () => T): T {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    return body();
  } finally {
    warn.mockRestore();
  }
}

test("S1: a blocked own publication completed onto P by a peer is removed from P as well", () =>
  quiet(() => {
    const f = fixture(raw(808));
    const stale = staleReleaser(f, 808, 707);
    releaseExclusiveLock(PATH, 707, "owner-707", f.fs);
    const c = f.acquire(303);
    c.until((s) => s.op === "stat" && s.path === F);
    f.fs.failure = failRestore;
    stale.finish(); // 303's publication displaced; link and copy restore fail: retained at F.
    f.fs.failure = undefined;
    expect(f.fs.peek(F)?.raw).toBe(raw(303));
    const e = f.acquire(404);
    e.until((s) => s.op === "stat" && s.path === F); // 404 published at P.
    c.until((s) => s.op === "rename" && s.path === F); // 303: F is my inode, P foreign: blocked.
    e.until((s) => s.op === "unlink" && s.path.endsWith(".tmp") && linksToPath(e) === 2);
    expect(f.fs.peek(PATH)).toEqual(f.fs.peek(F)!); // 404 backed out and COMPLETEd link(F, P).
    expect(c.finish()).toBe(false);
    expect(e.finish()).toBe(false);
    expect(f.fs.paths()).toEqual([]); // Neither P nor F names 303, which was told false.
    f.live.add(505);
    expect(f.acquire(505).finish()).toBe(true);
  }));

test("S1: a blocked own publication leaves a foreign P alone", () =>
  quiet(() => {
    const { f, a } = ownRetainedWithPeer();
    const held = { ...f.fs.peek(PATH)! };
    f.fs.operations.length = 0;
    expect(a.finish()).toBe(false);
    expect(f.fs.peek(F)).toBeUndefined();
    expect(f.fs.peek(PATH)).toEqual(held);
    expect(f.fs.operations.some((s) => s.op === "rename" && s.path === PATH)).toBe(false);
    // P was not this instance, so a displacer may still hold it privately: remembered by identity.
    expect(hasPendingBackOut(f.fs, PATH)).toBe(true);
  }));

test("C7: a pending identity entry costs one stat(P) per lock call until it leaves", () =>
  quiet(() => {
    const { f, a } = ownRetainedWithPeer();
    expect(a.finish()).toBe(false);
    const drain = { op: "stat", path: PATH } as const;
    const sample = [drain, { op: "readText", path: PATH }] as const;
    f.fs.operations.length = 0;
    expect(f.acquire(303).finish()).toBe(false);
    expect(f.fs.operations).toEqual([drain, ...sample]);
    f.fs.operations.length = 0;
    expect(takeOverExclusiveLock(PATH, { pid: 909, token: "gone" }, f.options(303))).toBe(false);
    expect(f.fs.operations).toEqual([drain, ...sample]);
    f.fs.operations.length = 0;
    releaseExclusiveLock(PATH, 303, "owner-303", f.fs);
    expect(f.fs.operations).toEqual([
      drain,
      { op: "readText", path: F },
      { op: "readText", path: PATH },
    ]);
    expect(hasPendingBackOut(f.fs, PATH)).toBe(true);
    expect(f.fs.peek(PATH)?.raw).toBe(raw(404));
  }));

/**
 * F holds live 101; 303 (its own process view) published at P and is about to back out when a
 * stale releaser renames that doomed publication to its private marker (review-3 P1).
 */
function displacedDuringBackOut(publication: "atomic" | "legacy-wx" = "atomic") {
  const f = fixture(raw(808));
  const stale808 = staleReleaser(f, 808, 707);
  const stale707 = staleReleaser(f, 707, 606);
  releaseExclusiveLock(PATH, 606, "owner-606", f.fs);
  expect(f.acquire(101).finish()).toBe(true);
  f.fs.failure = failRestore;
  stale707.finish(); // Displaces live 101; link and copy restore fail: retained at F.
  f.fs.failure = undefined;
  expect(f.fs.paths()).toEqual([F]);
  const own = f.process(303);
  const view = own.fileSystem!;
  const c = new Racer(acquireExclusiveLockSteps(PATH, own));
  f.fs.linkError = publication === "legacy-wx" ? "ENOTSUP" : undefined;
  c.until(
    (s) =>
      s.op === "readText" &&
      s.path === PATH &&
      c.trace.some((t) => (t.op === "link" || t.op === "openExclusive") && t.path === PATH),
  );
  f.fs.linkError = undefined;
  const doomed = { ...f.fs.peek(PATH)! };
  expect(doomed.raw).toBe(raw(303));
  stale808.advance(); // rename(P -> 808's marker) takes 303's doomed publication.
  expect(f.fs.peek(PATH)).toBeUndefined();
  return { f, c, stale808, own, view, doomed };
}

function acquiresFresh(
  f: ReturnType<typeof fixture>,
  own: ReturnType<ReturnType<typeof fixture>["process"]>,
  doomed: { ino: number },
): void {
  expect(tryAcquireExclusiveLock(PATH, own)).toBe(true);
  expect(f.fs.peek(PATH)?.raw).toBe(raw(303));
  expect(f.fs.peek(PATH)?.ino).not.toBe(doomed.ino);
  expect(f.fs.peek(F)).toBeUndefined();
  releaseExclusiveLock(PATH, 303, "owner-303", own.fileSystem);
  expect(f.fs.paths()).toEqual([]);
  expect(f.acquire(404).finish()).toBe(true);
}

test("S2: a back-out that finds P missing is remembered and drained on the next call", () =>
  quiet(() => {
    const { f, c, stale808, own, view, doomed } = displacedDuringBackOut();
    c.advance(); // The back-out's read of P: ENOENT.
    stale808.finish(); // Foreign marker: link(marker, P) restores the doomed publication.
    expect(c.finish()).toBe(false);
    expect(f.fs.peek(PATH)).toEqual(doomed);
    expect(hasPendingBackOut(view, PATH)).toBe(true);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.paths()).toEqual([PATH]); // Names live 303, which was told false.
    expect(f.acquire(404).finish()).toBe(false);
    f.fs.operations.length = 0;
    acquiresFresh(f, own, doomed); // 303's next call drains its doomed bytes, then acquires.
    expect(f.fs.operations[0]).toEqual({ op: "stat", path: PATH });
    expect(hasPendingBackOut(view, PATH)).toBe(false);
  }));

test("S2: a back-out that finds other bytes at P is remembered; the doomed publication restored later is drained", () =>
  quiet(() => {
    const { f, c, stale808, own, view, doomed } = displacedDuringBackOut();
    const e = f.acquire(404);
    e.until((s) => s.op === "stat" && s.path === F); // 404 published at the freed P.
    expect(c.finish()).toBe(false); // 303's back-out reads 404's bytes.
    expect(hasPendingBackOut(view, PATH)).toBe(true);
    e.until((s) => s.op === "link" && s.path === PATH && linksToPath(e) === 1);
    expect(f.fs.peek(PATH)).toBeUndefined(); // 404 backed out, COMPLETE not yet run.
    stale808.finish(); // The displacer links 303's doomed publication back.
    expect(e.finish()).toBe(false);
    expect(f.fs.peek(PATH)).toEqual(doomed);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(f.fs.paths()).toEqual([PATH]);
    acquiresFresh(f, own, doomed);
    expect(hasPendingBackOut(view, PATH)).toBe(false);
  }));

test.each(["atomic", "legacy-wx"] as const)(
  "S2: a successful acquire clears the pending back-out, so a later same-process acquire never removes the genuine hold (%s)",
  (publication) =>
    quiet(() => {
      const { f, c, own, view } = displacedDuringBackOut(publication);
      expect(c.finish()).toBe(false);
      expect(hasPendingBackOut(view, PATH)).toBe(true);
      releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
      expect(tryAcquireExclusiveLock(PATH, own)).toBe(true);
      const genuine = { ...f.fs.peek(PATH)! };
      // A raw-only (legacy wx) entry is cleared by the acquire: P now legitimately carries those
      // bytes. An identity entry stays, and can never match the genuine inode.
      expect(hasPendingBackOut(view, PATH)).toBe(publication === "atomic");
      f.fs.operations.length = 0;
      expect(tryAcquireExclusiveLock(PATH, own)).toBe(false);
      expect(f.fs.peek(PATH)).toEqual(genuine);
      expect(f.fs.operations.some((s) => s.op === "rename")).toBe(false);
    }),
);

test("S2: a pending doomed publication survives the process's own later acquire and release and is drained when the displacer links it back", () =>
  quiet(() => {
    const { f, c, stale808, own, view, doomed } = displacedDuringBackOut();
    expect(c.finish()).toBe(false); // P missing: remembered; COMPLETE links F to P.
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    expect(tryAcquireExclusiveLock(PATH, own)).toBe(true); // G: identical bytes, another inode.
    expect(f.fs.peek(PATH)?.raw).toBe(doomed.raw);
    expect(f.fs.peek(PATH)?.ino).not.toBe(doomed.ino);
    releaseExclusiveLock(PATH, 303, "owner-303", view);
    expect(f.fs.peek(PATH)).toBeUndefined();
    expect(hasPendingBackOut(view, PATH)).toBe(true);
    stale808.finish(); // link(marker, P): the doomed publication names live 303 again.
    expect(f.fs.peek(PATH)).toEqual(doomed);
    expect(f.acquire(404).finish()).toBe(false);
    acquiresFresh(f, own, doomed);
    expect(hasPendingBackOut(view, PATH)).toBe(false);
  }));

test("S2: the next acquire removes a pending doomed publication a displacer retained at F", () =>
  quiet(() => {
    const { f, c, stale808, own, doomed } = displacedDuringBackOut();
    expect(c.finish()).toBe(false);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    f.fs.failure = failRestore;
    stale808.finish(); // Link and copy restore fail: 303's doomed publication is retained at F.
    f.fs.failure = undefined;
    expect(f.fs.paths()).toEqual([F]);
    expect(f.fs.peek(F)).toEqual(doomed);
    acquiresFresh(f, own, doomed);
  }));

test("S2: a release that removes the pending doomed publication from F drops the entry", () =>
  quiet(() => {
    const { f, c, stale808, view, doomed } = displacedDuringBackOut();
    expect(c.finish()).toBe(false);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    f.fs.failure = failRestore;
    stale808.finish();
    f.fs.failure = undefined;
    expect(f.fs.peek(F)).toEqual(doomed);
    expect(hasPendingBackOut(view, PATH)).toBe(true);
    releaseExclusiveLock(PATH, 303, "owner-303", view);
    expect(f.fs.paths()).toEqual([]);
    expect(hasPendingBackOut(view, PATH)).toBe(false);
  }));

test("S2: an acquire whose publication reuses a pending identity drops that entry", () =>
  quiet(() => {
    const { f, c, own, view, doomed } = displacedDuringBackOut();
    expect(c.finish()).toBe(false);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    // The filesystem reuses the doomed inode number within the same mtime for the new publication.
    const stat = spyOn(f.fs, "stat").mockImplementation((path) =>
      path.endsWith(".tmp")
        ? { ino: doomed.ino, mtimeMs: doomed.mtimeMs }
        : FakeLockFileSystem.prototype.stat.call(f.fs, path),
    );
    try {
      expect(hasPendingBackOut(view, PATH)).toBe(true);
      expect(tryAcquireExclusiveLock(PATH, own)).toBe(true);
      expect(hasPendingBackOut(view, PATH)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  }));

test("C2: at most 8 doomed publications are remembered per path; the oldest is evicted", () =>
  quiet(() => {
    const f = retained();
    const doomed: number[] = [];
    for (let i = 0; i < 9; i++) {
      f.fs.failure = (op, path) => (op === "rename" && path === PATH ? "EBUSY" : undefined);
      expect(f.acquire(303).finish()).toBe(false);
      f.fs.failure = undefined;
      doomed.push(f.fs.peek(PATH)!.ino);
      f.fs.rename(PATH, `${PATH}.away-${i}`); // As if a displacer held it in a private marker...
    }
    for (const [i, ino] of doomed.entries()) {
      f.fs.rename(`${PATH}.away-${i}`, PATH); // ...and linked it back later.
      releaseExclusiveLock(PATH, 404, "owner-404", f.fs); // Any lock call of the process drains.
      expect(f.fs.peek(PATH)?.ino).toBe(i === 0 ? ino : undefined);
      if (i === 0) {
        f.fs.unlink(PATH);
      }
    }
    expect(hasPendingBackOut(f.fs, PATH)).toBe(false);
  }));

const TOKENLESS = formatLockContent(303, undefined, undefined, "current-generation");

/** Review-3 P2: a tokenless reclaimOwnPid publication displaced and retained at F before its check. */
function tokenlessRetained(publication: "atomic" | "legacy-wx") {
  const f = fixture(raw(808));
  const stale = staleReleaser(f, 808, 707);
  releaseExclusiveLock(PATH, 707, "owner-707", f.fs);
  const options = { ...f.process(303), ownerToken: undefined, reclaimOwnPid: true };
  f.fs.linkError = publication === "legacy-wx" ? "ENOTSUP" : undefined;
  const c = new Racer(acquireExclusiveLockSteps(PATH, options));
  c.until((s) => s.op === "stat" && s.path === F);
  f.fs.linkError = undefined;
  f.fs.failure = failRestore;
  stale.finish();
  f.fs.failure = undefined;
  expect(f.fs.peek(F)?.raw).toBe(TOKENLESS);
  expect(f.fs.peek(PATH)).toBeUndefined();
  return { f, c, options, view: options.fileSystem! };
}

test("S3: a tokenless reclaimOwnPid acquirer does not delete its own retained publication", () =>
  quiet(() => {
    const { f, c, view } = tokenlessRetained("atomic");
    expect(c.finish()).toBe(true);
    expect(f.fs.peek(PATH)?.raw).toBe(TOKENLESS); // Never "acquired" with no lock file.
    expect(f.fs.peek(PATH)).toEqual(f.fs.peek(F)!);
    expect(f.acquire(404).finish()).toBe(false);
    releaseExclusiveLock(PATH, 303, undefined, view);
    expect(f.fs.paths()).toEqual([]);
    expect(f.acquire(404).finish()).toBe(true);
  }));

test("S3: legacy own-bytes F removed as reclaimable with P gone returns false", () =>
  quiet(() => {
    const { f, c, view } = tokenlessRetained("legacy-wx");
    expect(c.finish()).toBe(false);
    expect(f.fs.paths()).toEqual([]);
    expect(hasPendingBackOut(view, PATH)).toBe(false);
    expect(f.acquire(404).finish()).toBe(true);
  }));

test.each(["guard-contended", "claim-failed"] as const)(
  "S3: %s own-bytes F with P gone returns false and F is removed on the next call",
  (kind) =>
    quiet(() => {
      const { f, c, options, view } = tokenlessRetained("legacy-wx");
      const { ino, mtimeMs } = f.fs.peek(F)!;
      const hash = createHash("sha256").update(TOKENLESS).digest("hex").slice(0, 32);
      const guard = `${PATH}.reclaim.${ino}.${mtimeMs}.${hash}.0`;
      if (kind === "guard-contended") {
        f.fs.seed(guard, raw(202)); // A live reclaimer holds this instance's guard.
      } else {
        f.fs.failure = (op, path) => (op === "rename" && path === F ? "EBUSY" : undefined);
      }
      expect(c.finish()).toBe(false);
      f.fs.failure = undefined;
      expect(f.fs.peek(PATH)).toBeUndefined();
      expect(f.fs.peek(F)?.raw).toBe(kind === "claim-failed" ? TOKENLESS : undefined);
      expect(hasPendingBackOut(view, PATH)).toBe(kind === "claim-failed");
      expect(tryAcquireExclusiveLock(PATH, options)).toBe(true);
      expect(f.fs.peek(F)).toBeUndefined();
      expect(f.fs.peek(PATH)?.raw).toBe(TOKENLESS);
      expect(hasPendingBackOut(view, PATH)).toBe(false);
    }),
);
