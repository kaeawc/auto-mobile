import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
      depsFrom(DEFAULT_DB, [{ pid: 4242, dbPath: DEFAULT_DB }])
    );
    expect(conflicts.map(c => c.pid)).toEqual([4242]);
  });

  test("does not match a daemon owning a different DB file (EC2, escape hatch)", () => {
    const isolated = "/home/tester/bench/isolated.db";
    const conflicts = findConflictingDaemons(
      depsFrom(isolated, [{ pid: 4242, dbPath: DEFAULT_DB }])
    );
    expect(conflicts).toEqual([]);
  });

  test("is file-scoped, not daemon-existence: an owner with unknown dbPath never matches (EC3)", () => {
    // A live daemon we cannot map to a DB file (e.g. another worktree's PID file)
    // must not falsely refuse — file, not daemon presence, is the predicate.
    const conflicts = findConflictingDaemons(
      depsFrom(DEFAULT_DB, [{ pid: 99, dbPath: undefined }])
    );
    expect(conflicts).toEqual([]);
  });

  test("normalizes paths before comparison (trailing segments resolve equal)", () => {
    const messy = "/home/tester/.auto-mobile/../.auto-mobile/auto-mobile.db";
    const conflicts = findConflictingDaemons(
      depsFrom(DEFAULT_DB, [{ pid: 7, dbPath: messy }])
    );
    expect(conflicts.map(c => c.pid)).toEqual([7]);
  });

  test("returns empty when no owners are reported (EC4)", () => {
    expect(findConflictingDaemons(depsFrom(DEFAULT_DB, []))).toEqual([]);
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
    expect(message).toContain(DEFAULT_DB);
    expect(message).toContain("4242");
    expect(message).toContain("--no-proxy");
    expect(message).toContain("AUTOMOBILE_DB_PATH");
  });

  test("does not throw when the daemon owns a different DB path (EC2)", () => {
    expect(() =>
      assertDirectModeDbOwnership(
        depsFrom("/home/tester/bench/isolated.db", [{ pid: 4242, dbPath: DEFAULT_DB }])
      )
    ).not.toThrow();
  });

  test("does not throw when no live daemon owns the file (EC4)", () => {
    expect(() => assertDirectModeDbOwnership(depsFrom(DEFAULT_DB, []))).not.toThrow();
  });

  test("lists every conflicting pid in the error message", () => {
    let thrown: unknown;
    try {
      assertDirectModeDbOwnership(
        depsFrom(DEFAULT_DB, [
          { pid: 10, dbPath: DEFAULT_DB },
          { pid: 20, dbPath: DEFAULT_DB },
        ])
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

  test("reports live daemons with unresolvable DB path as undefined, never a false match (EC3)", () => {
    // PID file describes a daemon (2000) that is NOT among the live pids; the live
    // daemon (3000) has no readable DB path → reported undefined so it can't match.
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [3000] },
      readPidFileData: () => pidData({ pid: 2000, dbPath: DEFAULT_DB }),
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(deps.findLiveDaemonDbOwners()).toEqual([{ pid: 3000, dbPath: undefined }]);
  });

  test("ignores a stale PID file whose pid is not live", () => {
    const deps = createDefaultDirectModeGuardDeps({
      manager: { findLiveDaemonProcesses: () => [] },
      readPidFileData: () => null,
      resolveDbPath: () => DEFAULT_DB,
    });
    expect(deps.findLiveDaemonDbOwners()).toEqual([]);
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
