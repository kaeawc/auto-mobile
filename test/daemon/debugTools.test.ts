import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import { getDaemonHealthReport } from "../../src/daemon/debugTools";

describe("getDaemonHealthReport", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("treats a responsive socket as running when PID bookkeeping is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidPath = join(tempDir, "daemon.pid");
    mkdirSync(dirname(socketPath), { recursive: true });
    writeFileSync(socketPath, "");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const report = await getDaemonHealthReport(undefined, {
        socketPath,
        pidFilePath: pidPath,
      });

      expect(isAvailable).toHaveBeenCalledWith(
        socketPath,
        expect.objectContaining({ skipStaleCleanup: true }),
      );
      expect(report.socketExists).toBe(true);
      expect(report.pidFileExists).toBe(false);
      expect(report.socketConnectable).toBe(true);
      expect(report.daemonRunning).toBe(true);
      expect(report.recommendations).toContain(
        "Daemon socket is responsive, but PID bookkeeping is stale or missing.",
      );
    } finally {
      isAvailable.mockRestore();
    }
  });
});
