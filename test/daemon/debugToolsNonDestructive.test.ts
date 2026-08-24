import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import { getDaemonHealthReport, runSocketDiagnostics } from "../../src/daemon/debugTools";
import type { PidFileData } from "../../src/daemon/types";

const isWindows = platform() === "win32";

/**
 * Regression coverage for issue #2658: doctor/debug health probes must be
 * observation-only. A loaded daemon whose PID bookkeeping is stale must not
 * have its live socket unlinked just because the probe errors or times out.
 */
describe("daemon health probes are non-destructive", () => {
  const tempDirs: string[] = [];

  function createTempPaths(): { socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-nondestructive-test-"));
    tempDirs.push(dir);
    return {
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  function writeDeadPidFile(pidFilePath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: 12345,
      socketPath,
      port: 3000,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidFilePath, JSON.stringify(pidData));
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("isAvailable skips stale-socket cleanup when skipStaleCleanup is set", async () => {
    if (isWindows) {
      return;
    }
    const { socketPath, pidFilePath } = createTempPaths();
    // A non-socket regular file represents a stale/errored socket probe target.
    writeFileSync(socketPath, "stale socket placeholder");
    writeDeadPidFile(pidFilePath, socketPath);

    const available = await DaemonClient.isAvailable(socketPath, {
      pidFilePath,
      socketPaths: [socketPath],
      isProcessRunning: () => false,
      skipStaleCleanup: true,
    });

    expect(available).toBe(false);
    // Files must survive: cleanup was explicitly disabled.
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("getDaemonHealthReport invokes isAvailable with stale-cleanup disabled", async () => {
    const { socketPath, pidFilePath } = createTempPaths();
    writeFileSync(socketPath, "");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    try {
      await getDaemonHealthReport(undefined, { socketPath, pidFilePath });
      expect(isAvailable).toHaveBeenCalledWith(
        socketPath,
        expect.objectContaining({ skipStaleCleanup: true }),
      );
    } finally {
      isAvailable.mockRestore();
    }
  });

  test("getDaemonHealthReport does not unlink files when the probe errors under a dead PID", async () => {
    if (isWindows) {
      return;
    }
    const { socketPath, pidFilePath } = createTempPaths();
    // Non-socket file makes isAvailable's stat check fail (its error branch).
    writeFileSync(socketPath, "stale socket placeholder");
    writeDeadPidFile(pidFilePath, socketPath);

    const report = await getDaemonHealthReport(undefined, { socketPath, pidFilePath });

    expect(report.socketConnectable).toBe(false);
    // The live socket and PID files must remain untouched by the diagnostic.
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("runSocketDiagnostics invokes isAvailable with stale-cleanup disabled", async () => {
    const { socketPath } = createTempPaths();
    writeFileSync(socketPath, "");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    try {
      await runSocketDiagnostics(undefined, { socketPath });
      expect(isAvailable).toHaveBeenCalledWith(
        socketPath,
        expect.objectContaining({ skipStaleCleanup: true }),
      );
    } finally {
      isAvailable.mockRestore();
    }
  });

  test("runSocketDiagnostics does not unlink files when the probe errors under a dead PID", async () => {
    if (isWindows) {
      return;
    }
    const { socketPath, pidFilePath } = createTempPaths();
    writeFileSync(socketPath, "stale socket placeholder");
    writeDeadPidFile(pidFilePath, socketPath);

    const diag = await runSocketDiagnostics(undefined, { socketPath, pidFilePath });

    expect(diag.socketConnectable).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });
});
