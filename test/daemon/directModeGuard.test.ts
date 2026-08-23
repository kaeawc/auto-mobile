import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertDirectModeDbOwnership,
  createDefaultDirectModeGuardDeps,
  findConflictingDaemons,
  type DaemonDbOwner,
  type DirectModeGuardDeps,
} from "../../src/daemon/directModeGuard";
import { ActionableError } from "../../src/models";
import type { PidFileData } from "../../src/daemon/types";

const DEFAULT_DB = "/home/tester/.auto-mobile/auto-mobile.db";

function depsFrom(dbPath: string, owners: DaemonDbOwner[]): DirectModeGuardDeps {
  return {
    resolveDbPath: () => dbPath,
    findLiveDaemonDbOwners: () => owners,
  };
}

describe("findConflictingDaemons", () => {
  test("matches a live daemon owning the same resolved DB file (EC1)", () => {
    const conflicts = findConflictingDaemons(
      depsFrom(DEFAULT_DB, [{ pid: 4242, dbPath: DEFAULT_DB }]),
    );
    expect(conflicts.map((c) => c.pid)).toEqual([4242]);
  });

  test("does not match a daemon owning a different DB file (EC2, escape hatch)", () => {
    const isolated = "/home/tester/bench/isolated.db";
    const conflicts = findConflictingDaemons(
      depsFrom(isolated, [{ pid: 4242, dbPath: DEFAULT_DB }]),
    );
    expect(conflicts).toEqual([]);
  });

  test("the same-file matcher never matches an unknown dbPath (EC3)", () => {
    // findConflictingDaemons is the pure same-FILE matcher: an unknown path is
    // not a same-file match here. (assertDirectModeDbOwnership separately fails
    // closed on unknown-path live daemons — see its own tests.)
    const conflicts = findConflictingDaemons(
      depsFrom(DEFAULT_DB, [{ pid: 99, dbPath: undefined }]),
    );
    expect(conflicts).toEqual([]);
  });

  test("normalizes paths before comparison (trailing segments resolve equal)", () => {
    const messy = "/home/tester/.auto-mobile/../.auto-mobile/auto-mobile.db";
    const conflicts = findConflictingDaemons(depsFrom(DEFAULT_DB, [{ pid: 7, dbPath: messy }]));
    expect(conflicts.map((c) => c.pid)).toEqual([7]);
  });

  test("returns empty when no owners are reported (EC4)", () => {
    expect(findConflictingDaemons(depsFrom(DEFAULT_DB, []))).toEqual([]);
  });

  test("canonicalizes symlinked paths so real and symlink forms match", () => {
    // A symlinked data dir (e.g. macOS /Users vs /System/Volumes/Data/Users)
    // must not defeat the guard: the daemon's real-path record and this
    // process's symlink-path resolution should compare equal.
    const root = mkdtempSync(join(tmpdir(), "directmode-guard-"));
    try {
      const realDir = join(root, "real-data");
      mkdirSync(realDir);
      const linkDir = join(root, "link-data");
      try {
        symlinkSync(realDir, linkDir);
      } catch {
        // Symlink creation is unprivileged on POSIX but can require elevation on
        // Windows; skip the canonicalization assertion where it isn't permitted.
        return;
      }

      const daemonDbPath = join(realDir, "auto-mobile.db"); // real form
      const ourDbPath = join(linkDir, "auto-mobile.db"); // symlink form (DB file absent)

      const conflicts = findConflictingDaemons(
        depsFrom(ourDbPath, [{ pid: 55, dbPath: daemonDbPath }]),
      );
      expect(conflicts.map((c) => c.pid)).toEqual([55]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertDirectModeDbOwnership", () => {
  test("throws ActionableError naming the DB path, --no-proxy, and AUTOMOBILE_DB_PATH (EC1)", () => {
    let thrown: unknown;
    try {
      assertDirectModeDbOwnership(depsFrom(DEFAULT_DB, [{ pid: 4242, dbPath: DEFAULT_DB }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActionableError);
    const message = (thrown as Error).message;
    // The message embeds the RESOLVED path (platform-specific separators), so
    // assert against the same normalization the guard applies rather than the raw
    // POSIX literal — otherwise this fails on Windows (C:\home\... vs /home/...).
    expect(message).toContain(resolve(DEFAULT_DB));
    expect(message).toContain("4242");
    expect(message).toContain("--no-proxy");
    expect(message).toContain("AUTOMOBILE_DB_PATH");
  });

  test("does not throw when the daemon owns a different DB path (EC2)", () => {
    expect(() =>
      assertDirectModeDbOwnership(
        depsFrom("/home/tester/bench/isolated.db", [{ pid: 4242, dbPath: DEFAULT_DB }]),
      ),
    ).not.toThrow();
  });

  test("does not throw when no live daemon owns the file (EC4)", () => {
    expect(() => assertDirectModeDbOwnership(depsFrom(DEFAULT_DB, []))).not.toThrow();
  });

  test("fails closed when a live daemon's DB path is unknown (starting up / non-default PID)", () => {
    // A daemon opens+migrates the DB seconds before it records its dbPath, so an
    // unknown-path live daemon could be about to write this same file. Refuse.
    let thrown: unknown;
    try {
      assertDirectModeDbOwnership(depsFrom(DEFAULT_DB, [{ pid: 777, dbPath: undefined }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActionableError);
    const message = (thrown as Error).message;
    expect(message).toContain("777");
    expect(message).toContain("could not be determined");
    expect(message).toContain("--no-proxy");
    expect(message).toContain("AUTOMOBILE_DB_PATH");
  });

  test("still allows an isolated path when another daemon owns a KNOWN different file (EC2 preserved)", () => {
    // Fail-closed applies only to UNKNOWN paths; a resolvable, different-path
    // daemon must not break the AUTOMOBILE_DB_PATH escape hatch.
    expect(() =>
      assertDirectModeDbOwnership(
        depsFrom("/home/tester/bench/isolated.db", [{ pid: 4242, dbPath: DEFAULT_DB }]),
      ),
    ).not.toThrow();
  });

  test("lists every conflicting pid in the error message", () => {
    let thrown: unknown;
    try {
      assertDirectModeDbOwnership(
        depsFrom(DEFAULT_DB, [
          { pid: 10, dbPath: DEFAULT_DB },
          { pid: 20, dbPath: DEFAULT_DB },
        ]),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain("10");
    expect((thrown as Error).message).toContain("20");
  });
});

describe("createDefaultDirectModeGuardDeps", () => {
  function pidData(overrides: Partial<PidFileData>): PidFileData {
    return {
      pid: 1000,
      socketPath: "/tmp/socket",
      port: 9000,
      startedAt: 0,
      version: "0.0.0",
      ...overrides,
    };
  }

  test("reuses DaemonManager.findLiveDaemonProcesses (EC5, no hand-rolled scan)", () => {
    let scanned = false;
    const deps = createDefaultDirectModeGuardDeps({
      manager: {
        findLiveDaemonProcesses: () => {
          scanned = true;
          return [1000];
        },
      },
      readPidFileData: () => pidData({ pid: 1000, dbPath: DEFAULT_DB }),
      resolveDbPath: () => DEFAULT_DB,
    });
    const owners = deps.findLiveDaemonDbOwners();
    expect(scanned).toBe(true);
    expect(owners).toEqual([{ pid: 1000, dbPath: DEFAULT_DB }]);
  });

  test("returns no owners when no daemons are live (EC4)", () => {
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [] },
      readPidFileData: () => pidData({ pid: 1000, dbPath: DEFAULT_DB }),
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(deps.findLiveDaemonDbOwners()).toEqual([]);
  });

  test("surfaces a live daemon with no resolvable DB path as unknown (fails closed downstream)", () => {
    // PID file describes a daemon (2000) that is NOT among the live pids; the live
    // daemon (3000) has no readable DB path → reported undefined, and the guard
    // then fails closed on it (it may be mid-startup on the same file).
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [3000] },
      readPidFileData: () => pidData({ pid: 2000, dbPath: DEFAULT_DB }),
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(deps.findLiveDaemonDbOwners()).toEqual([{ pid: 3000, dbPath: undefined }]);
    expect(() => assertDirectModeDbOwnership(deps)).toThrow(ActionableError);
  });

  test("an indeterminate process scan fails CLOSED (refuses)", () => {
    const deps = createDefaultDirectModeGuardDeps({
      manager: {
        findLiveDaemonProcesses: () => {
          throw new Error("powershell.exe: command failed");
        },
      },
      readPidFileData: () => null,
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(() => deps.findLiveDaemonDbOwners()).toThrow(ActionableError);
    expect(() => assertDirectModeDbOwnership(deps)).toThrow(ActionableError);
  });

  test("on non-Windows, an indeterminate `ps` scan fails CLOSED (refuses)", () => {
    // Where `ps` should work, a scan failure means we can't rule out a live daemon
    // on this DB file — refuse rather than risk a second writer. #2795
    const deps = createDefaultDirectModeGuardDeps({
      platform: "linux",
      manager: {
        findLiveDaemonProcesses: () => {
          throw new Error("ps: command failed");
        },
      },
      readPidFileData: () => null,
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(() => deps.findLiveDaemonDbOwners()).toThrow(ActionableError);
    expect(() => assertDirectModeDbOwnership(deps)).toThrow(ActionableError);
  });

  test("ignores a stale PID file whose pid is not live", () => {
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [] },
      readPidFileData: () => null,
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(deps.findLiveDaemonDbOwners()).toEqual([]);
  });

  test("mid-startup daemon (early owner record) + isolated path → ALLOWED (#2871)", () => {
    // #2871: Daemon.start() now publishes its resolved dbPath in the PID file
    // (writeEarlyOwnerRecord) BEFORE opening the DB. So during the multi-second
    // startup window the live daemon's dbPath is already resolvable, and a
    // concurrent direct-mode launch targeting an ISOLATED path is no longer
    // refused — it correctly resolves to a different-file (escape hatch).
    const daemonDb = join("/home/tester/.auto-mobile", "auto-mobile.db");
    const isolatedDb = "/home/tester/bench/isolated.db";
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [1000] },
      // Early record: live pid 1000 already has its dbPath published pre-DB-open.
      readPidFileData: () => pidData({ pid: 1000, dbPath: daemonDb }),
      resolveDbPath: () => isolatedDb,
    });
    expect(deps.findLiveDaemonDbOwners()).toEqual([{ pid: 1000, dbPath: daemonDb }]);
    expect(() => assertDirectModeDbOwnership(deps)).not.toThrow();
  });

  test("mid-startup daemon (early owner record) + SAME path → REFUSED (#2795 preserved)", () => {
    // The complement: with the early record, a same-file direct-mode launch is
    // still refused throughout startup — no regression to #2795's core guarantee.
    const daemonDb = join("/home/tester/.auto-mobile", "auto-mobile.db");
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [1000] },
      readPidFileData: () => pidData({ pid: 1000, dbPath: daemonDb }),
      resolveDbPath: () => daemonDb,
    });
    expect(() => assertDirectModeDbOwnership(deps)).toThrow(ActionableError);
  });

  test("end-to-end: default deps refuse a live default-path daemon (EC1)", () => {
    const dbPath = join("/home/tester/.auto-mobile", "auto-mobile.db");
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [1000] },
      readPidFileData: () => pidData({ pid: 1000, dbPath }),
      resolveDbPath: () => dbPath,
    });
    expect(() => assertDirectModeDbOwnership(deps)).toThrow(ActionableError);
  });
});
