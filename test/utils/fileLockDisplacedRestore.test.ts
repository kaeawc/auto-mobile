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

test.each(Array.from({ length: 32 }, (_, i) => 6001 + i))("retained property seed %d", (seed) => {
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
