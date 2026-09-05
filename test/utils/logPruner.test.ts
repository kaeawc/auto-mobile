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
