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
        daemonPidFiles: [pidFileB, pidFileA],
        readDaemonPid: (p) => (p === pidFileA ? daemonPidA : undefined),
        // Namespace B's own single-namespace view sees no daemon.
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).toContain(launchLogA);
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
        daemonPidFiles: [pidFileB, pidFileA],
        readDaemonPid: (p) => (p === pidFileA ? daemonPidA : undefined),
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
        daemonPidFiles: [pidFileB, pidFileA],
        readDaemonPid: (p) => (p === pidFileA ? daemonPidA : undefined),
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
        daemonPidFiles: [pidFileA],
        readDaemonPid: () => {
          throw new Error("pidfile unreadable");
        },
        isDaemonRunning: () => false,
      });

      const after = await readdir(dir);
      expect(after).toContain(launchLog); // err toward retaining on read failure
    });
  });
});
