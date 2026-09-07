import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test for issue #6194 (P1 crash).
//
// With file logging enabled, the logger's startup log-prune sweep enumerates the
// daemon pid files that could own a `daemon-launch-*.log`. That enumeration
// reaches `listDaemonPidFilesSync`, whose error path logs through the
// cyclically-imported `logger`. When the enumeration ran EAGERLY during
// `logger.ts` module initialization — before `export const logger` had been
// evaluated — a custom pid-file path under a non-existent parent directory made
// the scan throw, and touching `logger` in its TDZ aborted the whole import with
// `ReferenceError: Cannot access 'logger' before initialization`.
//
// The fix defers the enumeration to sweep time (a thunk), so simply importing
// the module must never throw, even when the pid-file parent does not exist.
describe("logger init does not crash on a non-existent custom pid-file parent (issue #6194)", () => {
  const tempDirs: string[] = [];
  let freshImportCounter = 0;

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("importing the logger with file logging + a missing pid-file parent resolves without throwing", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "logger-init-crash-logdir-"));
    tempDirs.push(logDir);
    // A pid-file path whose PARENT directory does not exist: the directory scan
    // in `listDaemonPidFilesSync` throws ENOENT, driving its logger-using error
    // path. This is the exact shape that crashed the eager import.
    const missingParent = join(tmpdir(), `logger-init-crash-pid-${Date.now()}-${Math.random()}`);
    const pidFilePath = join(missingParent, "daemon.pid");

    const prev = {
      logSink: process.env.AUTOMOBILE_LOG_SINK,
      logDir: process.env.AUTOMOBILE_LOG_DIR,
      pidPath: process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH,
    };
    process.env.AUTOMOBILE_LOG_SINK = "file";
    process.env.AUTOMOBILE_LOG_DIR = logDir;
    process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH = pidFilePath;

    try {
      const mod = await import(`../../src/utils/logger.ts?pidfile-crash-${freshImportCounter++}`);
      // If we got here, the import did not throw — the crash is gone.
      expect(typeof mod.logger.info).toBe("function");
      // Let any fire-and-forget startup sweep settle, then close the stream.
      await mod.logger.closeAfterFlush();
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      };
      restore("AUTOMOBILE_LOG_SINK", prev.logSink);
      restore("AUTOMOBILE_LOG_DIR", prev.logDir);
      restore("AUTOMOBILE_DAEMON_PID_FILE_PATH", prev.pidPath);
    }
  });
});
