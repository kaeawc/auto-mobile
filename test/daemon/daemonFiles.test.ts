import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  clearDaemonLaunchLogOwnerTombstoneSync,
  daemonLaunchLogOwnerTombstonePath,
  isProcessRunning,
  listDaemonPidFilePathsOrThrow,
  listDaemonPidFilesSync,
  PidFileLiveDaemonSessionIdProvider,
  readDaemonOwnerForRetentionSync,
  readDaemonLaunchLogOwnerTombstoneSync,
  shouldProtectLiveDaemonVersion,
  writePidFileDataAtomic,
  writePidFileDataAtomicSync,
} from "../../src/daemon/daemonFiles";
import { DEFAULT_PID_FILE_PATH } from "../../src/daemon/constants";
import { logger } from "../../src/utils/logger";
import type { PidFileData } from "../../src/daemon/types";

describe("PidFileLiveDaemonSessionIdProvider", () => {
  test("returns session IDs only for discovered PID records with live processes", () => {
    const records = new Map<string, PidFileData>([
      [
        "live.pid",
        {
          pid: 101,
          daemonSessionId: "live-daemon",
          socketPath: "live.sock",
          port: 3000,
          startedAt: 1,
          version: "test",
        },
      ],
      [
        "dead.pid",
        {
          pid: 202,
          daemonSessionId: "dead-daemon",
          socketPath: "dead.sock",
          port: 3001,
          startedAt: 2,
          version: "test",
        },
      ],
      [
        "legacy.pid",
        {
          pid: 303,
          socketPath: "legacy.sock",
          port: 3002,
          startedAt: 3,
          version: "test",
        },
      ],
    ]);
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => [...records.keys()],
      readPidFile: (pidFilePath) => {
        const data = records.get(pidFilePath!);
        return data === undefined ? { status: "absent" } : { status: "present", data };
      },
      isProcessRunning: (pid) => pid === 101,
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set(["live-daemon"]));
  });

  test("protects a live PID when its process generation token matches", () => {
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => ["matching.pid"],
      readPidFile: () => ({
        status: "present",
        data: {
          pid: 404,
          daemonSessionId: "matching-daemon",
          processGenerationToken: "linux:boot-id:100",
        },
      }),
      isProcessRunning: () => true,
      readProcessGenerationToken: (pid) => {
        expect(pid).toBe(404);
        return "linux:boot-id:100";
      },
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set(["matching-daemon"]));
  });

  test("does not protect a recycled PID with a different process generation token", () => {
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => ["recycled.pid"],
      readPidFile: () => ({
        status: "present",
        data: {
          pid: 404,
          daemonSessionId: "recycled-daemon",
          processGenerationToken: "linux:boot-id:100",
        },
      }),
      isProcessRunning: () => true,
      readProcessGenerationToken: () => "linux:boot-id:200",
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set());
  });

  test("fails closed when the process generation token cannot be read", () => {
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => ["uncertain.pid"],
      readPidFile: () => ({
        status: "present",
        data: {
          pid: 404,
          daemonSessionId: "uncertain-daemon",
          processGenerationToken: "linux:boot-id:100",
        },
      }),
      isProcessRunning: () => true,
      readProcessGenerationToken: () => undefined,
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set(["uncertain-daemon"]));
  });

  test("warns and fails closed when the process generation token reader throws", () => {
    const readError = new Error("generation read failed");
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = new PidFileLiveDaemonSessionIdProvider({
        listDaemonPidFiles: () => ["throwing.pid"],
        readPidFile: () => ({
          status: "present",
          data: {
            pid: 404,
            daemonSessionId: "throwing-daemon",
            processGenerationToken: "linux:boot-id:100",
          },
        }),
        isProcessRunning: () => true,
        readProcessGenerationToken: () => {
          throw readError;
        },
      });

      expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set(["throwing-daemon"]));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(
        "Failed to read process generation token for live PID 404",
      );
      expect(warnSpy.mock.calls[0]?.[1]).toBe(readError);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("fails closed for a processStartedAt-only legacy record", () => {
    let tokenReadCount = 0;
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => ["started-at-only.pid"],
      readPidFile: () => ({
        status: "present",
        data: {
          pid: 404,
          daemonSessionId: "started-at-only-daemon",
          processStartedAt: 1_000,
        },
      }),
      isProcessRunning: () => true,
      readProcessGenerationToken: () => {
        tokenReadCount += 1;
        return "linux:boot-id:200";
      },
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set(["started-at-only-daemon"]));
    expect(tokenReadCount).toBe(0);
  });

  test("fails closed for a fully legacy record with no process birth identity", () => {
    let tokenReadCount = 0;
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => ["fully-legacy.pid"],
      readPidFile: () => ({
        status: "present",
        data: { pid: 404, daemonSessionId: "fully-legacy-daemon" },
      }),
      isProcessRunning: () => true,
      readProcessGenerationToken: () => {
        tokenReadCount += 1;
        return "linux:boot-id:200";
      },
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set(["fully-legacy-daemon"]));
    expect(tokenReadCount).toBe(0);
  });

  test("surfaces a directory-enumeration failure", () => {
    const enumerationError = Object.assign(new Error("pid directory unavailable"), {
      code: "EIO",
    });
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => {
        throw enumerationError;
      },
    });

    expect(() => provider.collectLiveDaemonSessionIds()).toThrow(enumerationError);
  });

  test("warns and skips a pre-PA2 legacy live record with no daemon session ID", () => {
    // `daemonSessionId` is documented optional (types.ts) for PID files
    // written before peer-liveness discovery shipped: a legacy record that
    // parses fine and names a live process is an EXPECTED non-error, not
    // ambiguous local damage, so it must not block startup.
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = new PidFileLiveDaemonSessionIdProvider({
        listDaemonPidFiles: () => ["live-partial.pid"],
        readPidFile: () => ({ status: "present", data: { pid: 404 } }),
        isProcessRunning: (pid) => pid === 404,
      });

      expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set());
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(
        "names live process 404 but has no daemon session id",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("still throws startup-fatal on a corrupt/unreadable own PID file", () => {
    // Regression guard: only the legacy-live shape (parseable, running, no
    // daemonSessionId) is demoted to warn+skip. Genuine local damage -- a
    // non-ENOENT read failure on this uid's own record -- must remain fatal.
    const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => ["own-daemon.pid"],
      readPidFile: () => {
        throw readError;
      },
      isProcessRunning: () => {
        throw new Error("liveness must not be checked for an unreadable record");
      },
    });

    expect(() => provider.collectLiveDaemonSessionIds()).toThrow(readError);
  });

  test("fails closed when a present partial record has no recoverable PID", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-live-partial-test-"));
    try {
      const pidFile = join(dir, "daemon.pid");
      writeFileSync(pidFile, '{"pid":');
      const provider = new PidFileLiveDaemonSessionIdProvider({
        listDaemonPidFiles: () => [pidFile],
        isProcessRunning: () => {
          throw new Error("liveness must not be guessed without a recoverable PID");
        },
      });

      expect(() => provider.collectLiveDaemonSessionIds()).toThrow(SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treats ENOENT as a clean non-throwing skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-live-absent-test-"));
    try {
      const provider = new PidFileLiveDaemonSessionIdProvider({
        listDaemonPidFiles: () => [join(dir, "missing.pid")],
        isProcessRunning: () => {
          throw new Error("an absent record has no process to inspect");
        },
      });

      expect(provider.collectLiveDaemonSessionIds()).toEqual(new Set());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("protects every live peer regardless of recorded version", () => {
    const records = new Map<string, PidFileData>([
      [
        "older.pid",
        {
          pid: 101,
          daemonSessionId: "older-daemon",
          socketPath: "older.sock",
          port: 3000,
          startedAt: 1,
          version: "2.3.3+golder",
        },
      ],
      [
        "same.pid",
        {
          pid: 102,
          daemonSessionId: "same-daemon",
          socketPath: "same.sock",
          port: 3001,
          startedAt: 2,
          version: "2.3.4+gpeer",
        },
      ],
      [
        "newer.pid",
        {
          pid: 103,
          daemonSessionId: "newer-daemon",
          socketPath: "newer.sock",
          port: 3002,
          startedAt: 3,
          version: "2.4.0",
        },
      ],
      [
        "unparseable.pid",
        {
          pid: 104,
          daemonSessionId: "unparseable-daemon",
          socketPath: "unparseable.sock",
          port: 3003,
          startedAt: 4,
          version: "development",
        },
      ],
      [
        "missing.pid",
        {
          pid: 105,
          daemonSessionId: "missing-version-daemon",
          socketPath: "missing.sock",
          port: 3004,
          startedAt: 5,
        } as PidFileData,
      ],
    ]);
    const provider = new PidFileLiveDaemonSessionIdProvider({
      listDaemonPidFiles: () => [...records.keys()],
      readPidFile: (pidFilePath) => {
        const data = records.get(pidFilePath!);
        return data === undefined ? { status: "absent" } : { status: "present", data };
      },
      isProcessRunning: () => true,
    });

    expect(provider.collectLiveDaemonSessionIds()).toEqual(
      new Set([
        "older-daemon",
        "same-daemon",
        "newer-daemon",
        "unparseable-daemon",
        "missing-version-daemon",
      ]),
    );
  });

  test("fails closed when either release version cannot be compared", () => {
    expect(shouldProtectLiveDaemonVersion("", "2.3.4")).toBe(true);
    expect(shouldProtectLiveDaemonVersion(undefined, "2.3.4")).toBe(true);
    expect(shouldProtectLiveDaemonVersion("2.3.3", "development")).toBe(true);
  });
});

describe("atomic PID file writes", () => {
  const data: PidFileData = {
    pid: 1234,
    daemonSessionId: "daemon-session",
    socketPath: "/tmp/daemon.sock",
    port: 3000,
    startedAt: 1,
    version: "test",
  };

  test("async publication writes a unique sibling temp file before rename", async () => {
    const target = "/state/daemon.pid";
    const temporary = "/state/daemon.pid.1234.1.tmp";
    const operations: string[] = [];

    await writePidFileDataAtomic(target, data, undefined, {
      createTemporaryPath: () => temporary,
      writeTemporaryFile: async (path, contents) => {
        operations.push(`write:${path}:${JSON.parse(contents).daemonSessionId}`);
      },
      replaceFile: async (from, to) => {
        operations.push(`rename:${from}:${to}`);
      },
      removeTemporaryFile: async (path) => {
        operations.push(`remove:${path}`);
      },
    });

    expect(dirname(temporary)).toBe(dirname(target));
    expect(operations).toEqual([
      `write:${temporary}:daemon-session`,
      `rename:${temporary}:${target}`,
    ]);
  });

  test("synchronous publication writes the temp file before rename", () => {
    const target = "/state/daemon.pid";
    const temporary = "/state/daemon.pid.1234.2.tmp";
    const operations: string[] = [];

    writePidFileDataAtomicSync(target, data, {
      createTemporaryPath: () => temporary,
      writeTemporaryFile: (path) => operations.push(`write:${path}`),
      replaceFile: (from, to) => operations.push(`rename:${from}:${to}`),
      removeTemporaryFile: (path) => operations.push(`remove:${path}`),
    });

    expect(operations).toEqual([`write:${temporary}`, `rename:${temporary}:${target}`]);
  });

  test("removes the temporary file when atomic publication fails", async () => {
    const writeError = new Error("disk full");
    const removed: string[] = [];

    await expect(
      writePidFileDataAtomic("/state/daemon.pid", data, undefined, {
        createTemporaryPath: () => "/state/daemon.pid.tmp",
        writeTemporaryFile: async () => {
          throw writeError;
        },
        replaceFile: async () => {},
        removeTemporaryFile: async (path) => {
          removed.push(path);
        },
      }),
    ).rejects.toBe(writeError);
    expect(removed).toEqual(["/state/daemon.pid.tmp"]);
  });
});

describe("listDaemonPidFilePathsOrThrow", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("treats an absent PID directory as no co-located peers", () => {
    const missing = join(tmpdir(), `no-such-peer-dir-${Date.now()}-${Math.random()}`, "daemon.pid");

    expect(listDaemonPidFilePathsOrThrow(missing, missing)).toEqual([missing]);
  });

  test("throws when the PID directory exists but cannot be enumerated", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-peer-enum-error-test-"));
    tempDirs.push(dir);
    const notDirectory = join(dir, "not-a-directory");
    writeFileSync(notDirectory, "x");

    const pidFile = join(notDirectory, "daemon.pid");
    expect(() => listDaemonPidFilePathsOrThrow(pidFile, pidFile)).toThrow();
  });

  test("discovers this uid's own default-namespace peer from a custom PID namespace", () => {
    const customDir = mkdtempSync(join(tmpdir(), "daemon-custom-pid-dir-test-"));
    const defaultDir = mkdtempSync(join(tmpdir(), "daemon-default-pid-dir-test-"));
    tempDirs.push(customDir, defaultDir);
    const customPidFile = join(customDir, "custom-daemon.pid");
    const defaultPidFile = join(defaultDir, "auto-mobile-daemon-1000.pid");
    writeFileSync(defaultPidFile, "{}");

    // PID and DB overrides are independent. benchmark-startup.sh changes only
    // PID/socket paths, while resolveDatabasePathFromEnvironment owns DB paths;
    // `defaultPidFilePath` is included so the custom namespace cannot lose
    // this uid's own default-namespace peer.
    expect(listDaemonPidFilePathsOrThrow(customPidFile, defaultPidFile)).toContain(defaultPidFile);
  });

  test("never enumerates a foreign-uid sibling in the default PID directory", () => {
    const customDir = mkdtempSync(join(tmpdir(), "daemon-custom-pid-dir-test-"));
    const defaultDir = mkdtempSync(join(tmpdir(), "daemon-default-pid-dir-test-"));
    tempDirs.push(customDir, defaultDir);
    const customPidFile = join(customDir, "custom-daemon.pid");
    // This uid's own default pid file, per constants.ts's exact-filename shape.
    const defaultPidFile = join(defaultDir, "auto-mobile-daemon-1000.pid");
    // Another user's default pid file living in the SAME shared /tmp-style
    // directory. It matches the shared basename prefix but belongs to a
    // different uid (mode 0o600 in the real filesystem) -- a wildcard scan of
    // this directory would enumerate it and a later read would throw EACCES,
    // making every daemon startup on a shared host fatal (review FIX 1).
    const foreignUidPidFile = join(defaultDir, "auto-mobile-daemon-9999.pid");
    writeFileSync(defaultPidFile, "{}");
    writeFileSync(foreignUidPidFile, "{}");

    const discovered = listDaemonPidFilePathsOrThrow(customPidFile, defaultPidFile);

    expect(discovered).toContain(defaultPidFile);
    expect(discovered).not.toContain(foreignUidPidFile);
  });
});

describe("daemon file cleanup", () => {
  const tempDirs: string[] = [];

  function createTempFiles(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-file-cleanup-test-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "daemon.sock");
    const pidFilePath = join(dir, "daemon.pid");
    writeFileSync(socketPath, "");
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid: 12345,
        socketPath,
        port: 3000,
        startedAt: 0,
        version: "test",
      } satisfies PidFileData),
    );
    return { dir, socketPath, pidFilePath };
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("cleanupDaemonFiles removes configured socket and PID paths", async () => {
    const { socketPath, pidFilePath } = createTempFiles();

    await cleanupDaemonFiles({ pidFilePath, socketPaths: [socketPath] });

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("cleanupDaemonFilesSync removes configured socket and PID paths", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath] });

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("persists the launch-log owner before removing a PID record", () => {
    const { dir, socketPath, pidFilePath } = createTempFiles();
    const launchLogPath = join(dir, "daemon-launch-123.log");
    writeFileSync(
      pidFilePath,
      JSON.stringify({ pid: 12345, socketPath, launchLogPath } satisfies Partial<PidFileData>),
    );

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath] });

    expect(readDaemonLaunchLogOwnerTombstoneSync(launchLogPath)).toEqual({
      pid: 12345,
      launchLogPath,
    });
    expect(
      JSON.parse(readFileSync(daemonLaunchLogOwnerTombstonePath(launchLogPath), "utf-8")),
    ).toEqual({
      pid: 12345,
      launchLogPath,
    });
  });

  test("clears stale owner evidence before reusing a launch-log path", () => {
    const { dir } = createTempFiles();
    const launchLogPath = join(dir, "daemon-launch-123.log");
    writeFileSync(
      daemonLaunchLogOwnerTombstonePath(launchLogPath),
      JSON.stringify({ pid: 12345, launchLogPath }),
    );

    clearDaemonLaunchLogOwnerTombstoneSync(launchLogPath);

    expect(existsSync(daemonLaunchLogOwnerTombstonePath(launchLogPath))).toBe(false);
  });

  test("cleanupDaemonFilesSync skips cleanup when PID file belongs to another process", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath], expectedPid: 67890 });

    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  // Issue #6232: a lock-less contender refused over a live sibling has written
  // its OWN early owner record (issue #2871), so `expectedPid` would authorize
  // deletion of the shared socket/PID files even though it never bound the socket.
  // `socketBindCommitted: false` must suppress ALL deletion so the live winner's
  // files survive the loser's exit (the #6140 brick, prevented here).
  test("cleanupDaemonFilesSync removes nothing when the socket bind was never committed, even for our own PID", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const removed = cleanupDaemonFilesSync({
      pidFilePath,
      socketPaths: [socketPath],
      expectedPid: 12345,
      socketBindCommitted: false,
    });

    expect(removed).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("cleanupDaemonFiles removes nothing when the socket bind was never committed, even for our own PID", async () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const removed = await cleanupDaemonFiles({
      pidFilePath,
      socketPaths: [socketPath],
      expectedPid: 12345,
      socketBindCommitted: false,
    });

    expect(removed).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("cleanupDaemonFilesSync still cleans a committed bind's own files", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const removed = cleanupDaemonFilesSync({
      pidFilePath,
      socketPaths: [socketPath],
      expectedPid: 12345,
      socketBindCommitted: true,
    });

    expect(removed).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });
});

describe("isProcessRunning", () => {
  const successfulSignal = (): void => {};
  const procStat = (state: string, processName = "auto mobile worker"): string => {
    const numericFields = Array.from({ length: 49 }, (_, index) => String(index + 1)).join(" ");
    return `7190 (${processName}) ${state} ${numericFields}`;
  };

  // Issue #6260 (PRRT ft82g): `process.kill(pid, 0)` treats non-positive PIDs
  // specially — 0 signals the current process GROUP, -1 signals EVERY process
  // this user can signal — so both "succeed" without naming a real process. A
  // corrupt/stale lock recording one of these must never be reported as a
  // live owner (which would surface a `kill 0` / `kill -1` suggestion).
  test.each([0, -1, -100, 1.5, NaN])(
    "reports a non-positive/non-integer PID (%p) as not running without signaling it",
    (pid) => {
      expect(isProcessRunning(pid)).toBe(false);
    },
  );

  test("reports the current process as running (sanity check for a real positive PID)", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test("reports an unsignalable process as running when the probe returns EPERM", () => {
    expect(
      isProcessRunning(7190, {
        platform: "darwin",
        signalProcess: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      }),
    ).toBe(true);
  });

  test("fails closed when the probe returns an unexpected error", () => {
    expect(
      isProcessRunning(7190, {
        platform: "darwin",
        signalProcess: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      }),
    ).toBe(true);
  });

  test("reports a missing process as not running when the probe returns ESRCH", () => {
    expect(
      isProcessRunning(7190, {
        platform: "darwin",
        signalProcess: () => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      }),
    ).toBe(false);
  });

  test.each(["Z", "X"])("reports a Linux process in state %s as not running", (state) => {
    expect(
      isProcessRunning(7190, {
        platform: "linux",
        signalProcess: successfulSignal,
        readProcStat: () => procStat(state),
      }),
    ).toBe(false);
  });

  test("reports a non-zombie Linux process as running", () => {
    const calls: string[] = [];
    expect(
      isProcessRunning(7190, {
        platform: "linux",
        signalProcess: () => {
          calls.push("signal");
        },
        readProcStat: () => {
          calls.push("procfs");
          return procStat("S");
        },
      }),
    ).toBe(true);
    expect(calls).toEqual(["signal", "procfs"]);
  });

  test.each([
    {
      name: "unavailable",
      readProcStat: (): string => {
        throw new Error("procfs unavailable");
      },
    },
    { name: "malformed", readProcStat: () => "not a proc stat record" },
    { name: "truncated after state", readProcStat: () => "7190 (worker) Z" },
  ])("fails closed when Linux procfs is $name", ({ readProcStat }) => {
    expect(
      isProcessRunning(7190, {
        platform: "linux",
        signalProcess: successfulSignal,
        readProcStat,
      }),
    ).toBe(true);
  });

  test("parses a Linux process name containing a closing parenthesis", () => {
    expect(
      isProcessRunning(7190, {
        platform: "linux",
        signalProcess: successfulSignal,
        readProcStat: () => procStat("Z", "worker) helper"),
      }),
    ).toBe(false);
  });

  test("does not inspect procfs on non-Linux platforms", () => {
    expect(
      isProcessRunning(7190, {
        platform: "darwin",
        signalProcess: successfulSignal,
        readProcStat: () => {
          throw new Error("must not read procfs");
        },
      }),
    ).toBe(true);
  });
});

describe("listDaemonPidFilesSync (cross-namespace enumeration, issue #6194)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-pidfile-enum-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("returns the given pid file plus co-located sibling namespace pid files", () => {
    const dir = makeDir();
    const own = join(dir, "auto-mobile-daemon-1000.pid");
    const bench = join(dir, "auto-mobile-daemon-bench-abc.pid");
    writeFileSync(own, "{}");
    writeFileSync(bench, "{}");
    // Unrelated files in the same dir must be ignored.
    writeFileSync(join(dir, "daemon.log"), "x");
    writeFileSync(join(dir, "auto-mobile-daemon-1000.sock"), "x");

    const { pidFiles } = listDaemonPidFilesSync(own);
    expect(pidFiles).toContain(own);
    expect(pidFiles).toContain(bench);
    expect(pidFiles).not.toContain(join(dir, "daemon.log"));
    expect(pidFiles).not.toContain(join(dir, "auto-mobile-daemon-1000.sock"));
  });

  test("always includes the given pid file even when it does not match the sibling pattern", () => {
    const dir = makeDir();
    const own = join(dir, "daemon.pid"); // arbitrary non-default name
    // No file written on disk; enumeration must still include the requested path.
    const { pidFiles } = listDaemonPidFilesSync(own);
    expect(pidFiles).toContain(own);
  });

  test("degrades to just the given pid file, marked uncertain, when the directory is unreadable", () => {
    const missing = join(tmpdir(), `no-such-dir-${Date.now()}-${Math.random()}`, "daemon.pid");
    const result = listDaemonPidFilesSync(missing);
    expect(result.pidFiles).toEqual([missing]);
    // A failed scan could not enumerate co-located namespaces -> fail closed.
    expect(result.uncertain).toBe(true);
  });

  test("marks a custom (non-default) pid namespace uncertain even when its dir scans fine", () => {
    const dir = makeDir();
    const own = join(dir, "auto-mobile-daemon-1000.pid");
    writeFileSync(own, "{}");
    // The directory is readable, but a custom namespace may be shared through a
    // common AUTOMOBILE_LOG_DIR by peers whose pid files live in OTHER dirs this
    // scan never visits (issue #6194), so discovery is not exhaustive.
    expect(listDaemonPidFilesSync(own).uncertain).toBe(true);
  });

  test("is ALSO uncertain for the default pid namespace, even with a clean sibling scan", () => {
    // A peer can leave AUTOMOBILE_LOG_DIR at its default (sharing this log dir)
    // while relocating ONLY its pid file via AUTOMOBILE_DAEMON_PID_FILE_PATH to a
    // directory this scan never visits — invisible to a directory listing no
    // matter how "default" the scanning caller's own namespace is. A clean
    // default-dir scan can therefore never be treated as exhaustive (issue #6194).
    expect(listDaemonPidFilesSync(DEFAULT_PID_FILE_PATH).uncertain).toBe(true);
  });

  test("still discovers co-located sibling pid files even though the enumeration is uncertain", () => {
    // Uncertainty gates the pruner's fallback decision, not what gets discovered:
    // a sibling that IS visible must still be returned so its liveness can be
    // checked first (a discovered live peer short-circuits to "retain" without
    // needing the uncertain flag at all).
    const dir = makeDir();
    const own = join(dir, "auto-mobile-daemon-1000.pid");
    const bench = join(dir, "auto-mobile-daemon-bench-abc.pid");
    writeFileSync(own, "{}");
    writeFileSync(bench, "{}");

    const result = listDaemonPidFilesSync(own);
    expect(result.uncertain).toBe(true);
    expect(result.pidFiles).toContain(own);
    expect(result.pidFiles).toContain(bench);
  });
});

describe("readDaemonOwnerForRetentionSync (ambiguity vs absence, issue #6194)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-pidfile-read-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("returns undefined for a confidently-absent pid file", () => {
    const missing = join(makeDir(), "daemon.pid");
    expect(readDaemonOwnerForRetentionSync(missing)).toBeUndefined();
  });

  test("preserves a well-formed PID file's explicit launch-log declaration", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: 4321, launchLogPath: null }));
    expect(readDaemonOwnerForRetentionSync(pidFile)).toEqual({
      pid: 4321,
      launchLogPath: null,
    });
  });

  test("THROWS (does not swallow to undefined) on a present-but-malformed pid file", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "{ this is not json");
    // The pruner relies on this throw to fail closed and retain the launch log.
    expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
  });

  test("THROWS on syntactically-valid JSON missing the pid field", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "{}");
    // Present but schema-invalid — ambiguous, not confidently absent.
    expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
  });

  test("THROWS when pid is a non-numeric string", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: "123" }));
    expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
  });

  test("THROWS when pid is zero, negative, or non-integer", () => {
    const dir = makeDir();
    for (const badPid of [0, -1, 1.5]) {
      const pidFile = join(dir, `daemon-${badPid}.pid`);
      writeFileSync(pidFile, JSON.stringify({ pid: badPid }));
      expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
    }
  });
});

describe("WebRTC stream socket path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("uses the explicit WebRTC stream socket override", async () => {
    process.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH = ".auto-mobile/test-webrtc.sock";
    const daemonFiles = await import(
      `../../src/daemon/daemonFiles.ts?webrtc-socket=${Date.now()}-${Math.random()}`
    );

    expect(daemonFiles.WEBRTC_STREAM_SOCKET_CONFIG.defaultPath).toBe(
      resolve(".auto-mobile/test-webrtc.sock"),
    );
  });
});
