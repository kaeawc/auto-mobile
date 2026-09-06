import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import { getDaemonHealthReport, runSocketDiagnostics } from "../../src/daemon/debugTools";

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

      expect(isAvailable).toHaveBeenCalledWith(socketPath);
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

  // #6140 P2: on Windows, named pipes have no filesystem entry, so a plain
  // existsSync gate always reports "not found" for a live daemon there — the
  // health report must skip that gate and consult connectivity directly.
  test("simulating win32: reports connectivity via the pipe probe despite no filesystem entry existing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-win32-"));
    tempDirs.push(tempDir);
    // A path that does not exist on disk — modeling a Windows named pipe, which
    // never has a filesystem entry to begin with.
    const socketPath = join(tempDir, "daemon.sock");
    const pidPath = join(tempDir, "daemon.pid");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const report = await getDaemonHealthReport(undefined, {
        socketPath,
        pidFilePath: pidPath,
        platform: "win32",
      });

      expect(isAvailable).toHaveBeenCalledWith(socketPath);
      expect(report.socketExists).toBe(true);
      expect(report.socketConnectable).toBe(true);
      expect(report.daemonRunning).toBe(true);
    } finally {
      isAvailable.mockRestore();
    }
  });

  test("off win32 (default): a nonexistent socket path is reported as not found without probing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-posix-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidPath = join(tempDir, "daemon.pid");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const report = await getDaemonHealthReport(undefined, {
        socketPath,
        pidFilePath: pidPath,
      });

      expect(report.socketExists).toBe(false);
      expect(isAvailable).not.toHaveBeenCalled();
      expect(report.recommendations).toContain("Socket file not found. Daemon may not be running.");
    } finally {
      isAvailable.mockRestore();
    }
  });
});

describe("runSocketDiagnostics", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // #6140 P2: the same Windows named-pipe gap applies to runSocketDiagnostics'
  // existsSync gate AND its subsequent fs.stat read/write-permission check —
  // neither has a filesystem entry to inspect on Windows, so both must be
  // skipped there and connectivity consulted directly.
  test("simulating win32: reports connectivity via the pipe probe despite no filesystem entry existing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-socket-diag-win32-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const diagnostics = await runSocketDiagnostics(undefined, {
        socketPath,
        platform: "win32",
      });

      expect(isAvailable).toHaveBeenCalledWith(socketPath);
      expect(diagnostics.socketExists).toBe(true);
      expect(diagnostics.socketReadable).toBe(true);
      expect(diagnostics.socketWritable).toBe(true);
      expect(diagnostics.socketConnectable).toBe(true);
    } finally {
      isAvailable.mockRestore();
    }
  });

  test("off win32 (default): a nonexistent socket path is reported as missing without probing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-socket-diag-posix-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const diagnostics = await runSocketDiagnostics(undefined, { socketPath });

      expect(diagnostics.socketExists).toBe(false);
      expect(isAvailable).not.toHaveBeenCalled();
      expect(diagnostics.issues).toContain("Socket file does not exist");
    } finally {
      isAvailable.mockRestore();
    }
  });
});
