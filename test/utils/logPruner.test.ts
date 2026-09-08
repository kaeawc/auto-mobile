import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneLogFiles } from "../../src/utils/logPruner";

async function withTempLogDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "logpruner-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("logPruner isOwnedBy (via pruneLogFiles)", () => {
  test("daemon own-file cap does not count daemon-launch-<pid>.log and does not delete them", async () => {
    await withTempLogDir(async (dir) => {
      // 3 rotated daemon backups + active + 9 daemon-launch capture logs, matching
      // the issue's repro shape (issue #6120).
      const rotated = [
        "daemon-2026-01-01T00-00-00.000Z.log",
        "daemon-2026-01-02T00-00-00.000Z.log",
        "daemon-2026-01-03T00-00-00.000Z.log",
      ];
      const launchLogs = Array.from({ length: 9 }, (_, i) => `daemon-launch-${100 + i}.log`);
      const active = "daemon.log";
      for (const file of [...rotated, ...launchLogs, active]) {
        await writeFile(path.join(dir, file), "x");
      }

      await pruneLogFiles({
        dir,
        ownPrefix: "daemon",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: 1000 * 60 * 60,
        // Treat every launch-log PID as alive so sweep (b) never removes them —
        // isolating this assertion to the own-file cap (a) under test.
        isProcessAlive: () => true,
      });

      const after = await readdir(dir);

      // The daemon's own rotated backups must survive the cap — they must not be
      // pushed out by peer daemon-launch-<pid>.log files counting against it.
      for (const file of rotated) {
        expect(after).toContain(file);
      }
      expect(after).toContain(active);
      // Launch logs are a different owner's files, untouched by the daemon's cap.
      for (const file of launchLogs) {
        expect(after).toContain(file);
      }
    });
  });

  test("daemon own-file cap still prunes the daemon's own excess rotated backups", async () => {
    await withTempLogDir(async (dir) => {
      const rotated = Array.from(
        { length: 5 },
        (_, i) => `daemon-2026-01-0${i + 1}T00-00-00.000Z.log`,
      );
      const active = "daemon.log";
      for (const file of [...rotated, active]) {
        await writeFile(path.join(dir, file), "x");
      }

      await pruneLogFiles({
        dir,
        ownPrefix: "daemon",
        maxOwnFiles: 3,
        abandonedMaxAgeMs: 1000 * 60 * 60,
      });

      const after = await readdir(dir);
      // 6 own files total, cap 3 -> oldest 3 (lexically first) pruned.
      expect(after).not.toContain(rotated[0]);
      expect(after).not.toContain(rotated[1]);
      expect(after).not.toContain(rotated[2]);
      expect(after).toContain(rotated[3]);
      expect(after).toContain(rotated[4]);
      expect(after).toContain(active);
    });
  });

  test("daemon-launch-<dead pid>.log older than the stale threshold is swept once its owner has exited", async () => {
    await withTempLogDir(async (dir) => {
      const staleLaunchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, staleLaunchLog), "x");
      await writeFile(path.join(dir, "daemon.log"), "x");

      await pruneLogFiles({
        dir,
        ownPrefix: "daemon",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1, // treat every file as already stale
        isProcessAlive: () => false, // owner pid 4242 has exited
      });

      const after = await readdir(dir);
      expect(after).not.toContain(staleLaunchLog);
    });
  });

  test("a live peer's daemon-launch-<pid>.log is never removed by the daemon's sweep", async () => {
    await withTempLogDir(async (dir) => {
      const liveLaunchLog = "daemon-launch-9999.log";
      await writeFile(path.join(dir, liveLaunchLog), "x");
      await writeFile(path.join(dir, "daemon.log"), "x");

      await pruneLogFiles({
        dir,
        ownPrefix: "daemon",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => true, // owner pid 9999 still running
      });

      const after = await readdir(dir);
      expect(after).toContain(liveLaunchLog);
    });
  });
});

describe("logPruner daemon-launch inherited-fd guard (issue #6194)", () => {
  test("does NOT unlink daemon-launch-<dead manager pid>.log while a daemon is running", async () => {
    await withTempLogDir(async (dir) => {
      // The spawning manager (pid 4242) has exited, and the launch log's mtime is
      // stale, but the detached daemon it spawned is still running and holds the
      // inherited fd on this file — so it must be retained.
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "in-flight daemon output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1, // every file is already stale by mtime
        isProcessAlive: () => false, // spawning manager 4242 has exited
        isDaemonRunning: () => true, // ...but the daemon it spawned is still alive
      });

      const after = await readdir(dir);
      expect(after).toContain(launchLog);
    });
  });

  test("DOES prune daemon-launch-<dead manager pid>.log once no daemon is running", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "old bootstrap output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false, // manager exited
        isDaemonRunning: () => false, // no daemon holds the fd anymore
      });

      const after = await readdir(dir);
      expect(after).not.toContain(launchLog);
    });
  });

  test("still prunes a non-launch dead peer's stale log even while a daemon is running", async () => {
    await withTempLogDir(async (dir) => {
      // A daemon running must not exempt an ordinary exited stdio peer's log:
      // that fd is not inherited by the daemon.
      const stalePeer = "stdio-777.log";
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, stalePeer), "x");
      await writeFile(path.join(dir, launchLog), "x");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false, // both owners exited
        isDaemonRunning: () => true, // guards only daemon-launch logs
      });

      const after = await readdir(dir);
      expect(after).not.toContain(stalePeer); // ordinary peer swept as before
      expect(after).toContain(launchLog); // launch log retained (fd may be held)
    });
  });
});

describe("logPruner cross-namespace launch-log retention (issue #6194)", () => {
  // Two isolated daemon namespaces (A and B) SHARE one log dir. Namespace A's
  // daemon (pid 5000) is live; namespace B's namespace has no daemon. Pruning
  // runs from namespace B. Checking only B's own pid file would miss A's live
  // daemon and unlink A's launch log — the exact data loss #6194 prevents.
  const pidFileA = "/tmp/auto-mobile-daemon-nsA.pid";
  const pidFileB = "/tmp/auto-mobile-daemon-nsB.pid";
  const daemonPidA = 5000;

  test("retains another namespace's launch log while THAT namespace's daemon is alive", async () => {
    await withTempLogDir(async (dir) => {
      // A's launch log (spawning manager pid 4242 has exited); B has none.
      const launchLogA = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLogA), "in-flight daemon output from ns A");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111", // pruning from namespace B, no daemon of its own
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1, // every file already stale by mtime
        // The spawning manager 4242 is dead, but daemon 5000 (namespace A) is alive.
        isProcessAlive: (pid) => pid === daemonPidA,
        daemonPidFiles: () => ({ pidFiles: [pidFileB, pidFileA], uncertain: false }),
        readDaemonOwner: (p) =>
          p === pidFileA
            ? { pid: daemonPidA, launchLogPath: path.join(dir, launchLogA) }
            : undefined,
        // Namespace B's own single-namespace view sees no daemon.
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).toContain(launchLogA);
    });
  });

  test("retains a shared launch log when any exact owner claim is alive", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "shared manager output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: (pid) => pid === 5001,
        daemonPidFiles: () => ({ pidFiles: [pidFileA, pidFileB], uncertain: false }),
        readDaemonOwner: (pidFile) => ({
          pid: pidFile === pidFileA ? 5000 : 5001,
          launchLogPath: path.join(dir, launchLog),
        }),
      });

      expect(await readdir(dir)).toContain(launchLog);
    });
  });

  test("prunes the launch log once NO namespace has a live daemon", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "old bootstrap output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false, // manager AND every namespace's daemon dead
        daemonPidFiles: () => ({ pidFiles: [pidFileB, pidFileA], uncertain: false }),
        readDaemonOwner: (p) =>
          p === pidFileA
            ? { pid: daemonPidA, launchLogPath: path.join(dir, launchLog) }
            : undefined,
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).not.toContain(launchLog);
    });
  });

  test("ordinary peer logs are swept regardless of another namespace's live daemon", async () => {
    await withTempLogDir(async (dir) => {
      const stalePeer = "stdio-777.log"; // a dead stdio peer, fd not daemon-inherited
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, stalePeer), "x");
      await writeFile(path.join(dir, launchLog), "x");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: (pid) => pid === daemonPidA, // only ns A's daemon alive
        daemonPidFiles: () => ({ pidFiles: [pidFileB, pidFileA], uncertain: false }),
        readDaemonOwner: (p) =>
          p === pidFileA
            ? { pid: daemonPidA, launchLogPath: path.join(dir, launchLog) }
            : undefined,
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).not.toContain(stalePeer); // ordinary peer still swept
      expect(after).toContain(launchLog); // launch log retained (ns A daemon live)
    });
  });

  test("retains on ambiguity when a namespace pidfile read throws", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "x");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false,
        daemonPidFiles: () => ({ pidFiles: [pidFileA], uncertain: false }),
        readDaemonOwner: () => {
          throw new Error("pidfile unreadable");
        },
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).toContain(launchLog); // err toward retaining on read failure
    });
  });
});

describe("logPruner enumeration-uncertainty retention (issue #6194)", () => {
  const ownPidFile = "/tmp/auto-mobile-daemon-nsX.pid";

  test("retains a launch log when enumeration reports uncertainty even though every discovered pid is dead", async () => {
    // A custom out-of-sibling-dir namespace (e.g. /state/b/daemon.pid) sharing
    // this log dir is undiscoverable by a single-directory scan, so enumeration
    // marks itself uncertain. A live daemon may own the launch log, so it must be
    // retained even though the only pid we CAN see is dead.
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "in-flight output from an undiscoverable ns");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false, // every pid we can see is dead
        daemonPidFiles: () => ({ pidFiles: [ownPidFile], uncertain: true }),
        readDaemonOwner: () => undefined, // our own namespace records no live daemon
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).toContain(launchLog); // fail closed on incomplete discovery
    });
  });

  test("prunes a launch log with a positively associated dead owner despite unrelated discovery uncertainty", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "abandoned output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        // File timestamp granularity on Windows can place a just-created file
        // slightly after Date.now(); use an explicit future sweep clock so this
        // test exercises its ownership verdict rather than filesystem timing.
        now: Date.now() + 60_000,
        isProcessAlive: () => false,
        // A custom sibling namespace may be undiscoverable, but the recorded
        // owner of THIS exact launch log is present and positively dead.
        daemonPidFiles: () => ({ pidFiles: [ownPidFile], uncertain: true }),
        readDaemonOwner: () => ({ pid: 5000, launchLogPath: path.join(dir, launchLog) }),
      });

      expect(await readdir(dir)).not.toContain(launchLog);
    });
  });

  test("retains a launch log with a durable tombstone when discovery is uncertain", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      const launchLogPath = path.join(dir, launchLog);
      await writeFile(launchLogPath, "abandoned output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        // See the matching dead-owner test above: avoid depending on a fresh
        // Windows file's timestamp being earlier than the test clock.
        now: Date.now() + 60_000,
        isProcessAlive: () => false,
        daemonPidFiles: () => ({ pidFiles: [ownPidFile], uncertain: true }),
        readDaemonOwner: () => undefined,
        readDaemonLaunchLogOwnerTombstone: (candidate) =>
          candidate === launchLogPath ? { pid: 5000, launchLogPath } : undefined,
      });

      // A path-only tombstone can belong to a prior manager generation after
      // PID/path reuse, so it cannot override an incomplete namespace scan.
      expect(await readdir(dir)).toContain(launchLog);
    });
  });

  test("prunes a launch log when discovery is confident (uncertain=false) and no daemon is alive", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "old bootstrap output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false,
        // Complete enumeration and every namespace's daemon confidently dead.
        daemonPidFiles: () => ({ pidFiles: [ownPidFile], uncertain: false }),
        readDaemonOwner: () => undefined,
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).not.toContain(launchLog); // confidently no owner -> pruned
    });
  });

  test("does not let a live daemon protect an unrelated abandoned launch log", async () => {
    await withTempLogDir(async (dir) => {
      const abandoned = "daemon-launch-4242.log";
      const liveOwnerLog = "daemon-launch-4243.log";
      await writeFile(path.join(dir, abandoned), "abandoned output");
      await writeFile(path.join(dir, liveOwnerLog), "live daemon output");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: (pid) => pid === 5000,
        daemonPidFiles: () => ({ pidFiles: [ownPidFile], uncertain: false }),
        readDaemonOwner: () => ({ pid: 5000, launchLogPath: path.join(dir, liveOwnerLog) }),
      });

      const after = await readdir(dir);
      expect(after).not.toContain(abandoned);
      expect(after).toContain(liveOwnerLog);
    });
  });

  test("retains a legacy owner declaration even when its apparent pid is dead", async () => {
    await withTempLogDir(async (dir) => {
      const launchLog = "daemon-launch-4242.log";
      await writeFile(path.join(dir, launchLog), "ownership unavailable");

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false,
        daemonPidFiles: () => ({ pidFiles: [ownPidFile], uncertain: false }),
        readDaemonOwner: () => ({ pid: 5000, launchLogPath: undefined }),
      });

      expect(await readdir(dir)).toContain(launchLog);
    });
  });
});

describe("logPruner daemon-discovery caching per sweep (issue #6194)", () => {
  test("calls daemonPidFiles/readDaemonOwner at most once across many launch logs in one sweep", async () => {
    await withTempLogDir(async (dir) => {
      const launchLogs = Array.from({ length: 20 }, (_, i) => `daemon-launch-${5000 + i}.log`);
      for (const file of launchLogs) {
        await writeFile(path.join(dir, file), "old bootstrap output");
      }

      let enumerateCalls = 0;
      let readCalls = 0;
      const ownPidFile = "/tmp/auto-mobile-daemon-nsX.pid";

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        // Windows file mtimes can be ahead of Date.now(); age is not under test.
        now: Date.now() + 60_000,
        isProcessAlive: () => false, // every spawning manager AND discovered pid is dead
        daemonPidFiles: () => {
          enumerateCalls += 1;
          return { pidFiles: [ownPidFile], uncertain: false };
        },
        readDaemonOwner: () => {
          readCalls += 1;
          return { pid: 5000, launchLogPath: null };
        },
        isDaemonRunning: () => false,
      });

      // One ownership discovery covers the whole sweep — 20 launch logs must not
      // trigger 20 pidfile-directory scans + reads (O(n) event-loop-blocking
      // filesystem work).
      expect(enumerateCalls).toBe(1);
      expect(readCalls).toBe(1);

      const after = await readdir(dir);
      for (const file of launchLogs) {
        expect(after).not.toContain(file); // confidently no owner -> all pruned
      }
    });
  });

  test("never calls daemonPidFiles when the sweep contains no daemon-launch logs", async () => {
    await withTempLogDir(async (dir) => {
      await writeFile(path.join(dir, "stdio-777.log"), "x");

      let enumerateCalls = 0;

      await pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: -1,
        isProcessAlive: () => false,
        daemonPidFiles: () => {
          enumerateCalls += 1;
          return { pidFiles: [], uncertain: false };
        },
        readDaemonOwner: () => undefined,
        isDaemonRunning: () => false,
      });

      // Lazily computed: never needed because no daemon-launch log was swept.
      expect(enumerateCalls).toBe(0);
    });
  });
});
