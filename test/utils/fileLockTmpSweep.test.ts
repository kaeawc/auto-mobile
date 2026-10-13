import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  acquireExclusiveLockSteps,
  formatLockContent,
  OWN_TMP_SWEEP_LIMIT,
  RECLAIM_GUARD_ABANDON_AGE_MS,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../src/utils/fileLock";
import { nodeLockFileSystem } from "../../src/utils/lockFileSystem";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { useScratchRoot } from "../helpers/scratchRoot";
import { Racer } from "./fileLockRaceHarness";

const LOCK = "/locks/resource.lock";
const PID = 101;

function setup() {
  const clock = new FakeTimer();
  clock.advanceTime(60_000);
  const fs = new FakeLockFileSystem(() => clock.now());
  const options = {
    pid: PID,
    ownerToken: "mine",
    fileSystem: fs,
    now: () => clock.now(),
    isProcessRunning: (pid: number) => pid === PID || pid === 202,
    idGenerator: new FakeIdGenerator(),
  };
  return { fs, clock, options };
}

function tmp(counter: number, target = LOCK, pid = PID): string {
  return `${target}.${pid}.${counter}.id.tmp`;
}

function exact(fs: FakeLockFileSystem): void {
  expect(fs.readText(LOCK)).toBe(formatLockContent(PID, "mine"));
}

describe("own publication tmp sweep", () => {
  test.each(["free", "reclaim", "takeover"] as const)(
    "%s removes own stale lock and guard tmps",
    (route) => {
      const f = setup();
      const paths = [tmp(1), tmp(2, `${LOCK}.reclaim.1.12.5.hash.0`)];
      for (const path of paths) {
        f.fs.seed(path, "litter", 0);
      }
      if (route !== "free") {
        f.fs.seed(LOCK, "99\nstale", 0);
      }
      const acquired =
        route === "takeover"
          ? takeOverExclusiveLock(LOCK, { pid: 99, token: "stale" }, f.options)
          : tryAcquireExclusiveLock(LOCK, f.options);
      expect(acquired).toBe(true);
      for (const path of paths) {
        expect(f.fs.exists(path)).toBe(false);
      }
      exact(f.fs);
    },
  );

  test("keeps young, boundary, future, foreign, and non-publication files", () => {
    const f = setup();
    const kept: [string, number][] = [
      [tmp(1), f.clock.now() - RECLAIM_GUARD_ABANDON_AGE_MS + 1],
      [tmp(2), f.clock.now() - RECLAIM_GUARD_ABANDON_AGE_MS],
      [tmp(3), f.clock.now() + 1],
      [tmp(4, LOCK, 202), 0], // Live foreign PID.
      [tmp(5, LOCK, 303), 0], // Dead foreign PID.
      [`${LOCK}.${PID}.reclaim`, 0],
      [`${LOCK}.${PID}.release.3`, 0],
      [`${LOCK}.reclaim.1.2.hash.0`, 0],
      [tmp(6, "/locks/other.lock"), 0],
      [`${LOCK}.303.${PID}.id.tmp`, 0], // Our PID is the counter, not the PID.
      [`${LOCK}.${PID}.7.dotted.id.tmp`, 0],
      [`${LOCK}.0${PID}.8.id.tmp`, 0], // PID spelling must be exact.
    ];
    for (const [path, mtime] of kept) {
      f.fs.seed(path, "keep", mtime);
    }
    expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
    for (const [path] of kept) {
      expect(f.fs.readText(path)).toBe("keep");
    }
    exact(f.fs);
  });

  test("each acquire attempts at most eight unlinks in sorted name order", () => {
    const f = setup();
    const paths = Array.from({ length: 20 }, (_, i) => tmp(i)).sort();
    for (const path of [...paths].reverse()) {
      f.fs.seed(path, "litter", 0);
    }
    expect(OWN_TMP_SWEEP_LIMIT).toBe(8);
    for (const remaining of [12, 4, 0]) {
      f.fs.operations.length = 0;
      expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
      const removed = f.fs.operations.filter((op) => op.op === "unlink" && paths.includes(op.path));
      expect(removed.map((op) => op.path)).toEqual(paths.splice(0, OWN_TMP_SWEEP_LIMIT));
      expect(paths).toHaveLength(remaining);
      expect(f.fs.paths().filter((path) => path !== LOCK)).toEqual(paths);
      releaseExclusiveLock(LOCK, PID, "mine", f.fs);
    }
  });

  test.each(["202\nlive", ""])("contended %j performs no list", (raw) => {
    const f = setup();
    f.fs.seed(LOCK, raw);
    f.fs.seed(tmp(1), "litter", 0);
    f.fs.operations.length = 0;
    expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(false);
    expect(f.fs.operations).toEqual([
      { op: "stat", path: LOCK },
      { op: "readText", path: LOCK },
    ]);
  });

  test("reclaim sweeps exactly once, before claiming a guard", () => {
    const f = setup();
    f.fs.seed(LOCK, "99\nstale", 0);
    f.fs.operations.length = 0;
    expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
    expect(f.fs.operations.filter((op) => op.op === "list")).toEqual([
      { op: "list", path: "/locks" },
    ]);
    expect(f.fs.operations[2]).toEqual({ op: "list", path: "/locks" });
  });

  test.each(["ENOENT", "EACCES"])("list %s is best effort", (code) => {
    const f = setup();
    const list = spyOn(f.fs, "list").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    try {
      expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
      expect(list).toHaveBeenCalledTimes(1);
      exact(f.fs);
    } finally {
      list.mockRestore();
    }
  });

  test.each(["ENOENT", "EACCES"])("sweep stat %s is best effort", (code) => {
    const f = setup();
    const path = tmp(1);
    f.fs.seed(path, "litter", 0);
    const stat = spyOn(f.fs, "stat").mockImplementation((candidate) => {
      if (candidate === path) {
        throw Object.assign(new Error(code), { code });
      }
      return FakeLockFileSystem.prototype.stat.call(f.fs, candidate);
    });
    try {
      expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
      exact(f.fs);
      expect(f.fs.readText(path)).toBe("litter");
    } finally {
      stat.mockRestore();
    }
  });

  test.each(["ENOENT", "EPERM"])("sweep unlink %s is best effort and bounded", (code) => {
    const f = setup();
    const paths = Array.from({ length: 20 }, (_, i) => tmp(i)).sort();
    for (const path of paths) {
      f.fs.seed(path, "litter", 0);
    }
    const attempted: string[] = [];
    const unlink = spyOn(f.fs, "unlink").mockImplementation((path) => {
      if (paths.includes(path)) {
        attempted.push(path);
        throw Object.assign(new Error(code), { code });
      }
      FakeLockFileSystem.prototype.unlink.call(f.fs, path);
    });
    try {
      expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
      expect(attempted).toEqual(paths.slice(0, OWN_TMP_SWEEP_LIMIT));
      exact(f.fs);
    } finally {
      unlink.mockRestore();
    }
  });

  test("free publication losing to a dead owner does not sweep twice", () => {
    const f = setup();
    const racer = new Racer(acquireExclusiveLockSteps(LOCK, f.options));
    racer.until((step) => step.op === "link" && step.path === LOCK);
    f.fs.seed(LOCK, "99\nstale", 0);
    expect(racer.finish()).toBe(true);
    expect(f.fs.operations.filter((op) => op.op === "list")).toHaveLength(1);
    exact(f.fs);
  });

  test("same-PID in-flight publication survives an interleaved sweep", () => {
    const f = setup();
    const stalled = new Racer(acquireExclusiveLockSteps(LOCK, f.options));
    stalled.until((step) => step.op === "link" && step.path === LOCK);
    const young = f.fs.paths()[0];
    expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
    expect(f.fs.exists(young)).toBe(true);
    expect(stalled.finish()).toBe(false);
    exact(f.fs);
  });

  test("a failed parent mkdir does not spend the later reclaim's sweep budget", () => {
    const f = setup();
    let first = true;
    const mkdir = spyOn(f.fs, "mkdir").mockImplementation((path) => {
      FakeLockFileSystem.prototype.mkdir.call(f.fs, path);
      if (first) {
        first = false;
        f.fs.seed(LOCK, "99\nstale", 0);
        f.fs.seed(tmp(1), "litter", 0);
        throw Object.assign(new Error("parent briefly occupied"), { code: "EEXIST" });
      }
    });
    try {
      expect(tryAcquireExclusiveLock(LOCK, f.options)).toBe(true);
      expect(f.fs.operations.filter((op) => op.op === "list")).toHaveLength(1);
      expect(f.fs.exists(tmp(1))).toBe(false);
      exact(f.fs);
    } finally {
      mkdir.mockRestore();
    }
  });
});

describe("real filesystem modes and own tmp cleanup", () => {
  const scratch = useScratchRoot("file-lock-tmp-sweep-");

  test.skipIf(process.platform === "win32").each(["free", "reclaim", "supersession"] as const)(
    "%s creates lock, publication tmps, guards and install tmps with 0600",
    (route) => {
      const lock = join(scratch.next(), "resource.lock");
      if (route !== "free") {
        writeFileSync(lock, "99\nstale");
      }
      if (route === "supersession") {
        const { ino, mtimeMs } = nodeLockFileSystem.stat(lock);
        const hash = createHash("sha256").update("99\nstale").digest("hex").slice(0, 32);
        writeFileSync(`${lock}.reclaim.${ino}.${mtimeMs}.${hash}.0`, "98\ndead");
      }
      const racer = new Racer(
        acquireExclusiveLockSteps(lock, {
          pid: PID,
          ownerToken: "mine",
          isProcessRunning: () => false,
          idGenerator: new FakeIdGenerator(),
          now: () => 60_000,
        }),
      );
      const created: string[] = [];
      while (!racer.pending.done) {
        const step = racer.pending.value;
        // Seed every exact recycled private name wider, including the guard-install tmp.
        if (step.op === "unlink" && step.path.endsWith(".tmp") && !existsSync(step.path)) {
          writeFileSync(step.path, "leftover");
          chmodSync(step.path, 0o644);
        }
        racer.advance();
        if (
          step.op === "writeFile" ||
          (step.op === "link" && readFileSync(step.path, "utf8") === formatLockContent(PID, "mine"))
        ) {
          created.push(step.path);
          expect(statSync(step.path).mode & 0o777).toBe(0o600);
        }
      }
      expect(racer.pending.value).toBe(true);
      expect(statSync(lock).mode & 0o777).toBe(0o600);
      expect(readFileSync(lock, "utf8")).toBe(formatLockContent(PID, "mine"));
      expect(created.filter((path) => path.endsWith(".tmp"))).toHaveLength(
        route === "free" ? 1 : route === "reclaim" ? 2 : 4,
      );
    },
  );

  test.skipIf(process.platform === "win32").each([false, true])(
    "legacy wx fallback creates a 0600 lock and guard (reclaim=%j)",
    (reclaim) => {
      const lock = join(scratch.next(), "resource.lock");
      if (reclaim) {
        writeFileSync(lock, "99\nstale");
      }
      const link = spyOn(nodeLockFileSystem, "link").mockImplementation(() => {
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      });
      try {
        const racer = new Racer(
          acquireExclusiveLockSteps(lock, {
            pid: PID,
            idGenerator: new FakeIdGenerator(),
            isProcessRunning: () => false,
          }),
        );
        const created: string[] = [];
        while (!racer.pending.done) {
          const step = racer.pending.value;
          racer.advance();
          if (step.op === "openExclusive") {
            created.push(step.path);
            expect(statSync(step.path).mode & 0o777).toBe(0o600);
          }
        }
        expect(racer.pending.value).toBe(true);
        expect(created).toHaveLength(reclaim ? 2 : 1);
        expect(statSync(lock).mode & 0o777).toBe(0o600);
      } finally {
        link.mockRestore();
      }
    },
  );

  test("removes a real own stale tmp and keeps a young one", () => {
    const lock = join(scratch.next(), "resource.lock");
    const old = tmp(1, lock, process.pid);
    const young = tmp(2, lock, process.pid);
    writeFileSync(old, "old");
    writeFileSync(young, "young");
    const now = statSync(young).mtimeMs;
    utimesSync(old, new Date(now - 60_000), new Date(now - 60_000));
    expect(
      tryAcquireExclusiveLock(lock, { now: () => now, idGenerator: new FakeIdGenerator() }),
    ).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(young, "utf8")).toBe("young");
    expect(nodeLockFileSystem.list(join(lock, ".."))).toEqual(
      [basename(lock), basename(young)].sort(),
    );
  });
});
