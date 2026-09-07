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

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("a clean process imports the canonical logger with file logging and a missing pid-file parent", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "logger-init-crash-logdir-"));
    tempDirs.push(logDir);
    // A pid-file path whose PARENT directory does not exist: the directory scan
    // in `listDaemonPidFilesSync` throws ENOENT, driving its logger-using error
    // path. This is the exact shape that crashed the eager import.
    const missingParent = join(tmpdir(), `logger-init-crash-pid-${Date.now()}-${Math.random()}`);
    const pidFilePath = join(missingParent, "daemon.pid");

    // `bun test` loads bunfig.toml's preloads before this file, which already
    // initializes the canonical logger and cannot reproduce the TDZ cycle.
    // A separate Bun process with an empty config has neither preload nor module
    // cache, so daemonFiles reaches the canonical logger during first import.
    const child = Bun.spawn(
      [
        process.execPath,
        "--config=",
        "--cwd",
        process.cwd(),
        "-e",
        'const { logger } = await import("./src/utils/logger.ts"); await logger.closeAfterFlush();',
      ],
      {
        env: {
          ...process.env,
          AUTOMOBILE_LOG_SINK: "file",
          AUTOMOBILE_LOG_DIR: logDir,
          AUTOMOBILE_DAEMON_PID_FILE_PATH: pidFilePath,
        },
        stderr: "pipe",
      },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Cannot access 'logger' before initialization");
  });
});
