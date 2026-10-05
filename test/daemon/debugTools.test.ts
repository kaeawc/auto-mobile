import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import { getDaemonHealthReport, runSocketDiagnostics } from "../../src/daemon/debugTools";
import { logger } from "../../src/utils/logger";

describe("getDaemonHealthReport", () => {
  const tempDirs: string[] = [];
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">> | undefined;
  let isAvailable: ReturnType<typeof spyOn<typeof DaemonClient, "isAvailable">> | undefined;

  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
    isAvailable?.mockRestore();
    isAvailable = undefined;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("warns once with static context for invalid PID JSON and preserves the recommendation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-invalid-json-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidFilePath = join(tempDir, "daemon.pid");
    const content = "not-json-SECRET-MARKER";
    writeFileSync(pidFilePath, content);
    let expectedRecommendation = "";
    try {
      JSON.parse(content);
    } catch (error) {
      expectedRecommendation = `PID file exists but is invalid or unreadable: ${error}`;
    }
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

    const report = await getDaemonHealthReport(undefined, {
      socketPath,
      pidFilePath,
      platform: "win32",
    });

    expect(isAvailable).toHaveBeenCalledWith(socketPath, expect.anything());
    const warnings = warn.mock.calls.filter(([message]) =>
      message.startsWith("Daemon PID file check failed"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toBe("Daemon PID file check failed: invalid JSON");
    expect(warnings[0][0]).not.toContain("SECRET-MARKER");
    expect(warnings[0][0]).not.toContain(content);
    expect(report.pidFileValid).toBe(false);
    const recommendations = report.recommendations.filter((recommendation) =>
      recommendation.startsWith("PID file exists but is invalid or unreadable: "),
    );
    expect(recommendations).toEqual([expectedRecommendation]);
  });

  test("warns once with EISDIR context when the PID file path is a directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-read-failure-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidFilePath = join(tempDir, "daemon.pid");
    mkdirSync(pidFilePath);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

    const report = await getDaemonHealthReport(undefined, {
      socketPath,
      pidFilePath,
      platform: "win32",
    });

    expect(isAvailable).toHaveBeenCalledWith(socketPath, expect.anything());
    const warnings = warn.mock.calls.filter(([message]) =>
      message.startsWith("Daemon PID file check failed"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toContain("EISDIR");
    expect(warnings[0][0]).not.toBe("Daemon PID file check failed: invalid JSON");
    expect(report.pidFileValid).toBe(false);
    expect(
      report.recommendations.some((recommendation) =>
        recommendation.startsWith("PID file exists but is invalid or unreadable: "),
      ),
    ).toBe(true);
  });

  test("treats a responsive socket as running when PID bookkeeping is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidPath = join(tempDir, "daemon.pid");
    mkdirSync(dirname(socketPath), { recursive: true });
    writeFileSync(socketPath, "");
    const abortController = new AbortController();
    const timeoutMs = 123;

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const report = await getDaemonHealthReport(undefined, {
        socketPath,
        pidFilePath: pidPath,
        signal: abortController.signal,
        timeoutMs,
      });

      expect(isAvailable).toHaveBeenCalledWith(socketPath, {
        signal: abortController.signal,
        timeoutMs,
        timer: expect.anything(),
      });
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

      expect(isAvailable).toHaveBeenCalledWith(
        socketPath,
        expect.objectContaining({
          signal: undefined,
          timeoutMs: undefined,
          timer: expect.anything(),
        }),
      );
      expect(report.socketExists).toBe(true);
      expect(report.socketConnectable).toBe(true);
      expect(report.daemonRunning).toBe(true);
    } finally {
      isAvailable.mockRestore();
    }
  });

  // #6140 P2 follow-up: the win32 branch must not unconditionally assume the
  // pipe exists — when nothing actually answers, socketExists/socketAccessible
  // must come back false (derived from the probe), so the health report
  // reaches its normal "start the daemon" recommendation instead of a
  // misleading "investigate stale socket state" one.
  test("simulating win32: reports the pipe as absent when the probe finds nothing (no daemon running)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-win32-absent-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidPath = join(tempDir, "daemon.pid");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

    try {
      const report = await getDaemonHealthReport(undefined, {
        socketPath,
        pidFilePath: pidPath,
        platform: "win32",
      });

      expect(isAvailable).toHaveBeenCalledWith(
        socketPath,
        expect.objectContaining({
          signal: undefined,
          timeoutMs: undefined,
          timer: expect.anything(),
        }),
      );
      expect(report.socketExists).toBe(false);
      expect(report.socketAccessible).toBe(false);
      expect(report.socketConnectable).toBe(false);
      expect(report.daemonRunning).toBe(false);
      expect(report.recommendations).toContain(
        "Named pipe not found or not responding. Daemon may not be running.",
      );
    } finally {
      isAvailable.mockRestore();
    }
  });

  // Pinned to a POSIX platform (not skipIf(win32)): this asserts POSIX-specific
  // behavior (the existsSync gate firing), so it must run — and pass — on every
  // CI leg, including the windows-latest one, rather than being skipped there.
  test("off win32 (posix): a nonexistent socket path is reported as not found without probing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-daemon-health-posix-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");
    const pidPath = join(tempDir, "daemon.pid");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const report = await getDaemonHealthReport(undefined, {
        socketPath,
        pidFilePath: pidPath,
        platform: "linux",
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

  // #6140 P2 follow-up: matching note above — the win32 branch must derive
  // socketExists/socketReadable/socketWritable from the probe result, never
  // assume them true when nothing actually answers.
  test("simulating win32: reports the pipe as absent when the probe finds nothing (no daemon running)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-socket-diag-win32-absent-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

    try {
      const diagnostics = await runSocketDiagnostics(undefined, {
        socketPath,
        platform: "win32",
      });

      expect(isAvailable).toHaveBeenCalledWith(socketPath);
      expect(diagnostics.socketExists).toBe(false);
      expect(diagnostics.socketReadable).toBe(false);
      expect(diagnostics.socketWritable).toBe(false);
      expect(diagnostics.socketConnectable).toBe(false);
      expect(diagnostics.issues).toContain("Named pipe not found or not responding");
    } finally {
      isAvailable.mockRestore();
    }
  });

  // Pinned to a POSIX platform (not skipIf(win32)): see the matching note above
  // in the getDaemonHealthReport describe block.
  test("off win32 (posix): a nonexistent socket path is reported as missing without probing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "automobile-socket-diag-posix-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "daemon.sock");

    const isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

    try {
      const diagnostics = await runSocketDiagnostics(undefined, { socketPath, platform: "linux" });

      expect(diagnostics.socketExists).toBe(false);
      expect(isAvailable).not.toHaveBeenCalled();
      expect(diagnostics.issues).toContain("Socket file does not exist");
    } finally {
      isAvailable.mockRestore();
    }
  });
});
