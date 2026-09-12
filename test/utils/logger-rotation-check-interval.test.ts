import { describe, expect, test, spyOn } from "bun:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Seeds a log file at a given size without paying for real data writes. A
 * sparse file (grown via ftruncate rather than write) reports the same
 * `stat().size` the rotation check reads, but the filesystem never allocates
 * the backing pages -- keeping these real-fs rotation tests fast. Mirrors the
 * helper in logger-sink-degradation.test.ts (#6149).
 */
const seedLogFileSize = (targetPath: string, size: number): void => {
  const fd = fs.openSync(targetPath, "w");
  try {
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
};

let importCounter = 0;

/**
 * Loads a fresh instance of the logger module against an isolated log dir.
 * Each test needs its own module instance because rotation state
 * (`bytesSinceLastRotationCheck`, `logStream`, `rotationInFlight`) is
 * process/module-level; a fresh dynamic import resets it, matching the
 * pattern used throughout logger-sink-degradation.test.ts.
 */
async function loggerWithEnv(logDir: string): Promise<typeof import("../../src/utils/logger")> {
  const previousFormat = process.env.AUTOMOBILE_LOG_FORMAT;
  const previousSink = process.env.AUTOMOBILE_LOG_SINK;
  const previousLogDir = process.env.AUTOMOBILE_LOG_DIR;
  process.env.AUTOMOBILE_LOG_FORMAT = "text";
  process.env.AUTOMOBILE_LOG_SINK = "file";
  process.env.AUTOMOBILE_LOG_DIR = logDir;
  try {
    return await import(`../../src/utils/logger.ts?rotation-check-interval-${importCounter++}`);
  } finally {
    if (previousFormat === undefined) {
      delete process.env.AUTOMOBILE_LOG_FORMAT;
    } else {
      process.env.AUTOMOBILE_LOG_FORMAT = previousFormat;
    }
    if (previousSink === undefined) {
      delete process.env.AUTOMOBILE_LOG_SINK;
    } else {
      process.env.AUTOMOBILE_LOG_SINK = previousSink;
    }
    if (previousLogDir === undefined) {
      delete process.env.AUTOMOBILE_LOG_DIR;
    } else {
      process.env.AUTOMOBILE_LOG_DIR = previousLogDir;
    }
  }
}

describe("checkAndRotateLog is gated on an interval, not run on every write (#6651)", () => {
  test("N sequential small writes trigger far fewer size checks than N", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-interval-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    // `fs.existsSync` is called through the `fs` namespace object (unlike
    // io.ts's statAsync, which is destructured at import time and so can't be
    // spied on), making it a reliable probe for how many independent
    // check-and-maybe-rotate cycles actually ran their own stat -- same
    // technique as the #6149 round-3 test in logger-sink-degradation.test.ts.
    const existsSyncSpy = spyOn(fs, "existsSync");

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv(logDir);
      const callsForTarget = (): number =>
        existsSyncSpy.mock.calls.filter((call: unknown[]) => call[0] === targetLogFile).length;

      // Each call is awaited via flush() before the next is issued -- the
      // exact "steady, serialized stream of writes" repro from the issue,
      // where every write's promise settles before the next line is logged.
      const N = 25;
      for (let i = 0; i < N; i++) {
        mod.logger.info(`small line ${i}`);
        await mod.logger.flush();
      }

      // Before the fix, checkAndRotateLog ran unconditionally on every write,
      // so this would be N (one existsSync call per line). Gating on
      // accumulated bytes must keep it far below N: only the mandatory
      // first-write check should have run, since these lines are tiny
      // relative to the check-interval threshold.
      const calls = callsForTarget();
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThan(N / 5);
    } finally {
      existsSyncSpy.mockRestore();
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("rotation still triggers once accumulated writes cross the size threshold", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "am-logger-rotate-interval-trigger-"));
    const targetLogFile = join(logDir, `stdio-${process.pid}.log`);
    // Leave a 20KB margin below the 10MiB rotation threshold -- comfortably
    // less than the (32KB) check-interval worth of writes below, so the
    // first check that fires after the margin is crossed is guaranteed to
    // also see the file at or above MAX_LOG_SIZE.
    const MAX_LOG_SIZE = 10 * 1024 * 1024;
    seedLogFileSize(targetLogFile, MAX_LOG_SIZE - 20_000);

    let mod: typeof import("../../src/utils/logger") | undefined;
    try {
      mod = await loggerWithEnv(logDir);

      // First write forces the mandatory initial check (the file may already
      // be oversized from a previous process run) -- it must NOT rotate yet,
      // since the seeded size is comfortably under the threshold.
      mod.logger.info("kickoff");
      await mod.logger.flush();
      expect(fs.readdirSync(logDir).length).toBe(1);

      // formatLogRecord caps any single message at 1000 characters, so
      // crossing the byte-accumulation threshold (and, past that, the 20KB
      // real-size margin) takes repeated writes rather than one giant one.
      // Each ~1000-char message line is roughly 1032 bytes once the
      // timestamp/level prefix is added, so ~50 lines (~51KB) comfortably
      // crosses both the 32KB check-interval gate and the 20KB on-disk
      // margin, forcing a real stat that observes the file at/above
      // MAX_LOG_SIZE and rotates.
      for (let i = 0; i < 50; i++) {
        mod.logger.info("x".repeat(1000));
        await mod.logger.flush();
      }

      const files = fs.readdirSync(logDir);
      const backups = files.filter((f) => f !== `stdio-${process.pid}.log`);
      expect(backups.length).toBeGreaterThan(0);
    } finally {
      await mod?.logger.closeAfterFlush();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
