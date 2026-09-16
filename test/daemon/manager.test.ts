import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  createDefaultDaemonProcessFinder,
  daemonBuildIdentityStatusLines,
  DaemonManager,
  parseBusyBoxDaemonProcessTable,
  parseDarwinDaemonProcessTable,
  parseDaemonHeartbeatCommandArgs,
  parseDaemonProcessTable,
  PsDaemonProcessFinder,
  runDaemonCommand,
  WindowsDaemonProcessFinder,
  NetDaemonPortAvailabilityChecker,
} from "../../src/daemon/manager";
import {
  darwinProcessGenerationToken,
  linuxProcessGenerationToken,
} from "../../src/daemon/processGeneration";
import { DaemonLauncher } from "../../src/daemon/DaemonLauncher";
import type { BuildIdentity } from "../../src/daemon/buildIdentity";
import type { DaemonOptions, DaemonStatus } from "../../src/daemon/types";
import type {
  DaemonProcessFinder,
  DaemonProcessLivenessChecker,
  DaemonProcessSignaler,
  DaemonProcessSpawner,
  DaemonProcessRecord,
  DaemonPortAvailabilityChecker,
  ProbeListener,
  ExtractionCleaner,
} from "../../src/daemon/manager";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import type { DaemonClientLike } from "../../src/daemon/client";
import { ActionableError } from "../../src/models";
import {
  DAEMON_APPLY_ACCEPTANCE_DOCTOR_FAULT_METHOD,
  DAEMON_CORRUPT_CONTROL_METADATA_METHOD,
  DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
} from "../../src/daemon/daemonRestartAdmission";
import { createDaemonLiveAcceptanceCapability } from "../../src/daemon/liveAcceptanceCapability";
import { INCOMPLETE_EXTRACTION_CODE } from "../../src/db/migrationDependencyIntegrity";
import { FakeTimer } from "../fakes/FakeTimer";
import { formatLockContent } from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import {
  DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS,
  DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
  DAEMON_STARTUP_TIMEOUT_MS,
  CLI_SESSION_LIVENESS_POLICY,
  getCliSessionIdleTimeoutMs,
} from "../../src/daemon/constants";

describe("daemonBuildIdentityStatusLines", () => {
  const client: BuildIdentity = {
    entryScript: "/wt/dist/src/index.js",
    buildId: "1111111111111111",
  };

  test("always reports the daemon's Build ID and Entry Script", () => {
    const status: DaemonStatus = {
      running: true,
      pid: 99,
      entryScript: "/wt/dist/src/index.js",
      buildId: "1111111111111111",
    };

    const lines = daemonBuildIdentityStatusLines(status, client);

    expect(lines).toContain("  Build ID: 1111111111111111");
    expect(lines).toContain("  Entry Script: /wt/dist/src/index.js");
  });

  test("falls back to 'unknown' for a legacy daemon and does not warn", () => {
    const status: DaemonStatus = { running: true, pid: 99 };

    const lines = daemonBuildIdentityStatusLines(status, client);

    expect(lines).toContain("  Build ID: unknown");
    expect(lines).toContain("  Entry Script: unknown");
    expect(lines.some((line) => line.includes("WARNING"))).toBe(false);
  });

  test("warns and shows both builds when the daemon is a different build", () => {
    const status: DaemonStatus = {
      running: true,
      pid: 99,
      entryScript: "/main/dist/src/index.js",
      buildId: "2222222222222222",
    };

    const lines = daemonBuildIdentityStatusLines(status, client);
    const text = lines.join("\n");

    expect(text).toContain("WARNING");
    expect(text).toContain("2222222222222222");
    expect(text).toContain("/main/dist/src/index.js");
    expect(text).toContain("1111111111111111");
    expect(text).toContain("/wt/dist/src/index.js");
    expect(text).toContain("--daemon restart");
  });
});

describe("DaemonManager restart", () => {
  test("preserves PID-recorded options when no replacement options are requested", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: () => false,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const recordedOptions: DaemonOptions = {
      debug: true,
      toolOutputsDir: "/tmp/automobile-artifacts",
      eventAllMarkers: ["@", "#"],
    };
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid: 999,
      options: recordedOptions,
    });
    const stopSpy = spyOn(manager, "stop").mockResolvedValue(undefined);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    await manager.restart();

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    // strictPort:true is always forced onto a restart (issue #6260 PRRT
    // ft82d) so the child's own listen() call — not a preflight probe that
    // releases its socket before the child binds — is the authoritative
    // bind-or-fail guard against the port-fallback split-brain.
    expect(startSpy).toHaveBeenCalledWith({ ...recordedOptions, strictPort: true });
  });

  test("conditional restart does not terminate a successor generation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const successorPid = 1002;
    const livePids = new Set([successorPid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [
        {
          pid: successorPid,
          ppid: 1,
          command: "bun /new/dist/src/index.js --daemon-mode",
        },
      ],
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler((pid, signal) => {
      if (signal === "SIGTERM") {
        livePids.delete(pid);
      }
    });
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const successorStatus: DaemonStatus = {
      running: true,
      pid: successorPid,
      startedAt: 200,
      buildId: "successor-build",
      entryScript: "/new/dist/src/index.js",
    };
    const statusSpy = spyOn(manager, "status").mockResolvedValue(successorStatus);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      const result = await manager.restart(
        {},
        {
          running: true,
          pid: 1001,
          startedAt: 100,
          buildId: "incumbent-build",
          entryScript: "/old/dist/src/index.js",
        },
      );

      expect(signaler.signals).toEqual([]);
      expect(startSpy).not.toHaveBeenCalled();
      expect(livePids).toEqual(new Set([successorPid]));
      expect(result).toBe("joined");
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("conditional restart joins an already-admitted handoff", async () => {
    const expected: DaemonStatus = {
      running: true,
      pid: 1001,
      startedAt: 100,
      version: "0.0.73",
      buildId: "incumbent-build",
      entryScript: "/old/dist/src/index.js",
    };
    const client = new FakeDaemonClient({});
    const prepareSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({
      accepted: false,
      reason: "restart_pending",
    });
    const manager = new DaemonManager(
      () => client,
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: () => true,
      },
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue(expected);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await expect(manager.restart({}, expected)).resolves.toBe("joined");
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("conditional restart atomically admits only the observed idle generation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const incumbentPid = 1001;
    const unrelatedPid = 1002;
    const livePids = new Set([incumbentPid, unrelatedPid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [...livePids].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /dist/src/index.js --daemon-mode",
        })),
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler();
    const client = new FakeDaemonClient({});
    let clientOptions: { clientIdentity?: unknown } | undefined;
    const prepareSpy = spyOn(client, "callDaemonMethod").mockImplementation(async () => {
      livePids.delete(incumbentPid);
      return { accepted: true };
    });
    const manager = new DaemonManager(
      (options) => {
        clientOptions = options;
        return client;
      },
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const expected: DaemonStatus = {
      running: true,
      pid: incumbentPid,
      startedAt: 100,
      version: "0.0.73",
      buildId: "incumbent-build",
      entryScript: "/old/dist/src/index.js",
    };
    const statusSpy = spyOn(manager, "status").mockResolvedValue(expected);
    const startSpy = spyOn(manager, "start").mockResolvedValue("joined");

    try {
      await expect(manager.restart({}, expected)).resolves.toBe("joined");

      expect(prepareSpy).toHaveBeenCalledWith("ide/prepareRestart", {
        pid: incumbentPid,
        startedAt: 100,
        version: "0.0.73",
        buildId: "incumbent-build",
        entryScript: "/old/dist/src/index.js",
      });
      expect(clientOptions).toEqual({ clientIdentity: null });
      expect(signaler.signals).toEqual([]);
      expect(livePids).toEqual(new Set([unrelatedPid]));
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      prepareSpy.mockRestore();
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("conditional restart leaves a generation with active device work running", async () => {
    const timer = new FakeTimer();
    const incumbentPid = 1001;
    const livePids = new Set([incumbentPid]);
    const signaler = new FakeDaemonProcessSignaler();
    const client = new FakeDaemonClient({});
    const prepareSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({
      accepted: false,
      reason: "active_operations",
    });
    const manager = new DaemonManager(
      () => client,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: (pid) => livePids.has(pid),
      },
      undefined,
      undefined,
      undefined,
      signaler,
    );
    const expected: DaemonStatus = {
      running: true,
      pid: incumbentPid,
      startedAt: 100,
      version: "0.0.73",
      buildId: "incumbent-build",
      entryScript: "/old/dist/src/index.js",
    };
    const statusSpy = spyOn(manager, "status").mockResolvedValue(expected);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await expect(manager.restart({}, expected)).rejects.toMatchObject({
        code: "daemon_restart_deferred",
        retryable: true,
        message: expect.stringContaining("no device operation is active"),
      });
      expect(signaler.signals).toEqual([]);
      expect(startSpy).not.toHaveBeenCalled();
      expect(livePids).toEqual(new Set([incumbentPid]));
    } finally {
      prepareSpy.mockRestore();
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("restart-admitted rejects missing and stale maintenance admission before lifecycle cleanup", async () => {
    const expected: DaemonStatus = {
      running: true,
      pid: 1001,
      startedAt: 100,
      processGenerationToken: "linux:boot:1001",
      version: "0.0.73",
      buildId: "incumbent-build",
      entryScript: "/old/dist/src/index.js",
    };
    let processScans = 0;
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => {
        processScans++;
        return [];
      },
      isProcessRunning: (pid) => pid === expected.pid,
    };
    const signaler = new FakeDaemonProcessSignaler();
    const client = new FakeDaemonClient({});
    const admissionSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({
      accepted: false,
      reason: "generation_changed",
    });
    const manager = new DaemonManager(
      () => client,
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue(expected);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await expect(manager.restartAdmitted({}, "")).rejects.toThrow("maintenance admission token");
      await expect(manager.restartAdmitted({}, "stale-maintenance-token")).rejects.toMatchObject({
        code: "daemon_restart_deferred",
      });

      expect(admissionSpy).toHaveBeenCalledWith(DAEMON_RESTART_ADMITTED_METHOD, {
        pid: expected.pid,
        startedAt: expected.startedAt,
        processGenerationToken: expected.processGenerationToken,
        version: expected.version,
        buildId: expected.buildId,
        entryScript: expected.entryScript,
        maintenanceToken: "stale-maintenance-token",
      });
      expect(signaler.signals).toEqual([]);
      expect(processScans).toBe(0);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      admissionSpy.mockRestore();
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("conditional restart fails closed when a legacy daemon lacks restart admission", async () => {
    const expected: DaemonStatus = {
      running: true,
      pid: 1001,
      startedAt: 100,
      version: "0.0.72",
      buildId: "legacy-build",
      entryScript: "/legacy/dist/src/index.js",
    };
    const client = new FakeDaemonClient();
    const signaler = new FakeDaemonProcessSignaler();
    const manager = new DaemonManager(
      () => client,
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: (pid) => pid === expected.pid,
      },
      undefined,
      undefined,
      undefined,
      signaler,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue(expected);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await expect(manager.restart({}, expected)).rejects.toMatchObject({
        code: "daemon_restart_deferred",
        retryable: true,
      });
      expect(signaler.signals).toEqual([]);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });
});

describe("DaemonManager control metadata repair", () => {
  test("corrupt-control-metadata-admitted fails closed for an ordinary CLI even with a token", async () => {
    const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    const manager = new DaemonManager(() => {
      throw new Error("ordinary CLI must not connect to the destructive RPC");
    });

    try {
      await expect(manager.corruptControlMetadataAdmitted("maintenance-token")).rejects.toThrow(
        "live-acceptance daemon startup capability",
      );
    } finally {
      if (originalSecret === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      } else {
        process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
      }
    }
  });

  test("derives the startup-authorized capability for the admitted daemon generation", async () => {
    const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    const startupSecret = "live-acceptance-startup-secret-123456";
    process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = startupSecret;
    const status: DaemonStatus = {
      running: true,
      pid: 1001,
      startedAt: 100,
      processGenerationToken: "generation-1",
      version: "0.0.73",
      buildId: "acceptance-build",
      entryScript: "/acceptance/dist/src/index.js",
    };
    const client = new FakeDaemonClient({});
    const rpcSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({ corrupted: true });
    const manager = new DaemonManager(() => client);
    const statusSpy = spyOn(manager, "status").mockResolvedValue(status);

    try {
      await expect(manager.corruptControlMetadataAdmitted("maintenance-token")).resolves.toBe(
        undefined,
      );
      expect(rpcSpy).toHaveBeenCalledWith(DAEMON_CORRUPT_CONTROL_METADATA_METHOD, {
        ...status,
        maintenanceToken: "maintenance-token",
        acceptanceCapability: createDaemonLiveAcceptanceCapability(startupSecret, {
          pid: 1001,
          startedAt: 100,
          processGenerationToken: "generation-1",
          version: "0.0.73",
          buildId: "acceptance-build",
          entryScript: "/acceptance/dist/src/index.js",
        }),
      });
    } finally {
      rpcSpy.mockRestore();
      statusSpy.mockRestore();
      if (originalSecret === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      } else {
        process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
      }
    }
  });

  test.each([
    {
      fault: "missing-daemon" as const,
      controlState: "daemon-missing" as const,
      expectedMetadataPresent: false,
    },
    {
      fault: "dead-daemon" as const,
      controlState: "daemon-dead" as const,
      expectedMetadataPresent: true,
    },
  ])(
    "$fault confirms $controlState and leaves the expected pre-recovery control state",
    async ({ fault, controlState, expectedMetadataPresent }) => {
      const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET =
        "live-acceptance-startup-secret-123456";
      const directory = mkdtempSync(join(tmpdir(), `daemon-manager-${fault}-`));
      const pidFilePath = join(directory, "daemon.pid");
      const socketPath = join(directory, "daemon.sock");
      const pid = 1001;
      const livePids = new Set([pid]);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      writeFileSync(
        pidFilePath,
        JSON.stringify({ pid, socketPath, startedAt: 100, version: "test" }),
      );
      writeFileSync(socketPath, "socket");
      const signaler = new FakeDaemonProcessSignaler((signaledPid, signal) => {
        if (signaledPid === pid && signal === "SIGKILL") {
          livePids.delete(pid);
        }
      });
      const client = new FakeDaemonClient({});
      const rpcSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({
        accepted: true,
        controlState,
      });
      const manager = new DaemonManager(
        () => client,
        undefined,
        timer,
        join(directory, "daemon.lock"),
        pidFilePath,
        socketPath,
        {
          findDaemonProcesses: () =>
            livePids.has(pid)
              ? [
                  {
                    pid,
                    ppid: 1,
                    command: "bun /acceptance/dist/src/index.js --daemon-mode",
                    startedAt: 100,
                    processGenerationToken: "generation-1",
                  },
                ]
              : [],
          isProcessRunning: (candidatePid) => livePids.has(candidatePid),
        },
        undefined,
        undefined,
        undefined,
        signaler,
      );
      const statusSpy = spyOn(manager, "status").mockResolvedValue({
        running: true,
        pid,
        startedAt: 100,
        processGenerationToken: "generation-1",
        version: "0.0.73",
        buildId: "acceptance-build",
        entryScript: "/acceptance/dist/src/index.js",
        socketPath,
      });

      try {
        await expect(
          manager.applyAcceptanceDoctorFault(fault, "maintenance-token", 10_000),
        ).resolves.toBeUndefined();

        expect(rpcSpy).toHaveBeenCalledWith(
          DAEMON_APPLY_ACCEPTANCE_DOCTOR_FAULT_METHOD,
          expect.objectContaining({ fault, maintenanceToken: "maintenance-token" }),
        );
        expect(signaler.signals).toEqual([{ pid, signal: "SIGKILL" }]);
        expect(existsSync(pidFilePath)).toBe(expectedMetadataPresent);
        expect(existsSync(socketPath)).toBe(expectedMetadataPresent);
      } finally {
        rpcSpy.mockRestore();
        statusSpy.mockRestore();
        rmSync(directory, { recursive: true, force: true });
        if (originalSecret === undefined) {
          delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
        } else {
          process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
        }
      }
    },
  );

  test("acceptance doctor never SIGKILLs a reused admitted PID", async () => {
    const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET =
      "live-acceptance-startup-secret-123456";
    const pid = 1001;
    const client = new FakeDaemonClient({});
    const rpcSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({
      accepted: true,
      controlState: "daemon-dead",
    });
    const signaler = new FakeDaemonProcessSignaler();
    const manager = new DaemonManager(
      () => client,
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [
          {
            pid,
            ppid: 1,
            command: "bun /unrelated/dist/src/index.js --daemon-mode",
            startedAt: 200,
            processGenerationToken: "generation-2",
          },
        ],
        isProcessRunning: () => true,
      },
      undefined,
      undefined,
      undefined,
      signaler,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid,
      startedAt: 100,
      processGenerationToken: "generation-1",
      version: "0.0.73",
      buildId: "acceptance-build",
      entryScript: "/acceptance/dist/src/index.js",
    });

    try {
      await expect(
        manager.applyAcceptanceDoctorFault("dead-daemon", "maintenance-token", 10_000),
      ).rejects.toThrow("verified daemon PID was reused");
      expect(signaler.signals).toEqual([]);
    } finally {
      rpcSpy.mockRestore();
      statusSpy.mockRestore();
      if (originalSecret === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      } else {
        process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
      }
    }
  });

  test("acceptance doctor treats an exited admitted generation as already stopped", async () => {
    const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET =
      "live-acceptance-startup-secret-123456";
    const client = new FakeDaemonClient({});
    const rpcSpy = spyOn(client, "callDaemonMethod").mockResolvedValue({
      accepted: true,
      controlState: "daemon-dead",
    });
    const signaler = new FakeDaemonProcessSignaler();
    const manager = new DaemonManager(
      () => client,
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: () => false,
      },
      undefined,
      undefined,
      undefined,
      signaler,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid: 1001,
      startedAt: 100,
      processGenerationToken: "generation-1",
      version: "0.0.73",
      buildId: "acceptance-build",
      entryScript: "/acceptance/dist/src/index.js",
    });

    try {
      await expect(
        manager.applyAcceptanceDoctorFault("dead-daemon", "maintenance-token", 10_000),
      ).resolves.toBeUndefined();
      expect(signaler.signals).toEqual([]);
    } finally {
      rpcSpy.mockRestore();
      statusSpy.mockRestore();
      if (originalSecret === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      } else {
        process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
      }
    }
  });

  test("acceptance-session restart preserves PID-reuse failure when rollback also fails", async () => {
    const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET =
      "live-acceptance-startup-secret-123456";
    const pid = 1001;
    const client = new FakeDaemonClient({});
    const rpcSpy = spyOn(client, "callDaemonMethod").mockImplementation(async (method) => {
      if (method === DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD) {
        return { accepted: true, restartToken: "acceptance-restart-1" };
      }
      expect(method).toBe(DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD);
      throw new Error("rollback transport failed");
    });
    const signaler = new FakeDaemonProcessSignaler();
    const manager = new DaemonManager(
      () => client,
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses: () => [
          {
            pid,
            ppid: 1,
            command: "bun /unrelated/dist/src/index.js --daemon-mode",
            startedAt: 200,
            processGenerationToken: "generation-2",
          },
        ],
        isProcessRunning: () => true,
      },
      undefined,
      undefined,
      undefined,
      signaler,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid,
      startedAt: 100,
      processGenerationToken: "generation-1",
      version: "0.0.73",
      buildId: "acceptance-build",
      entryScript: "/acceptance/dist/src/index.js",
    });

    try {
      await expect(
        manager.restartAcceptanceSession({
          sessionUuid: "session-1",
          platform: "ios",
          stableDeviceId: "simulator-1",
          controls: {
            androidSiblingAvdName: "sibling",
            androidDuplicateSerial: "emulator-5556",
            iosSameNameSiblingUdid: "simulator-2",
          },
          expiresAt: 10_000,
        }),
      ).rejects.toThrow("verified daemon PID was reused");
      expect(signaler.signals).toEqual([]);
      expect(rpcSpy).toHaveBeenCalledWith(
        DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
        expect.objectContaining({ restartToken: "acceptance-restart-1" }),
      );
    } finally {
      rpcSpy.mockRestore();
      statusSpy.mockRestore();
      if (originalSecret === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      } else {
        process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
      }
    }
  });

  test("acceptance-session restart keeps admission socket open through verified SIGKILL", async () => {
    const originalSecret = process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
    process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET =
      "live-acceptance-startup-secret-123456";
    const directory = mkdtempSync(join(tmpdir(), "acceptance-session-restart-test-"));
    const pid = 1001;
    const livePids = new Set([pid]);
    const events: string[] = [];
    const client = new FakeDaemonClient({});
    const rpcSpy = spyOn(client, "callDaemonMethod").mockImplementation(async (method) => {
      expect(method).toBe(DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD);
      events.push("admitted");
      return { accepted: true, restartToken: "acceptance-restart-1" };
    });
    const closeSpy = spyOn(client, "close").mockImplementation(async () => {
      events.push("closed");
    });
    const signaler = new FakeDaemonProcessSignaler((signaledPid, signal) => {
      expect(signaledPid).toBe(pid);
      expect(signal).toBe("SIGKILL");
      events.push("signaled");
      livePids.delete(signaledPid);
    });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const socketPath = join(directory, "daemon.sock");
    const manager = new DaemonManager(
      () => client,
      undefined,
      timer,
      join(directory, "daemon.lock"),
      join(directory, "daemon.pid"),
      socketPath,
      {
        findDaemonProcesses: () =>
          livePids.has(pid)
            ? [
                {
                  pid,
                  ppid: 1,
                  command: "bun /acceptance/dist/src/index.js --daemon-mode",
                  startedAt: 100,
                  processGenerationToken: "generation-1",
                },
              ]
            : [],
        isProcessRunning: (candidatePid) => livePids.has(candidatePid),
      },
      undefined,
      undefined,
      undefined,
      signaler,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid,
      startedAt: 100,
      processGenerationToken: "generation-1",
      version: "0.0.73",
      buildId: "acceptance-build",
      entryScript: "/acceptance/dist/src/index.js",
      socketPath,
    });
    const startSpy = spyOn(manager, "start").mockResolvedValue("started");

    try {
      await expect(
        manager.restartAcceptanceSession({
          sessionUuid: "session-1",
          platform: "ios",
          stableDeviceId: "simulator-1",
          controls: {
            androidSiblingAvdName: "sibling",
            androidDuplicateSerial: "emulator-5556",
            iosSameNameSiblingUdid: "simulator-2",
          },
          expiresAt: 10_000,
        }),
      ).resolves.toBe("restarted");
      expect(events).toEqual(["admitted", "signaled", "closed"]);
      expect(signaler.signals).toEqual([{ pid, signal: "SIGKILL" }]);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      rpcSpy.mockRestore();
      closeSpy.mockRestore();
      statusSpy.mockRestore();
      startSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
      if (originalSecret === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET;
      } else {
        process.env.AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET = originalSecret;
      }
    }
  });

  test("passes the shared deadline and abort signal through connect and both control RPCs", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const connectCalls: Array<{ timeoutMs: number | undefined; signal: AbortSignal | undefined }> =
      [];
    const rpcCalls: Array<{
      method: string;
      timeoutMs: number | undefined;
      signal: AbortSignal | undefined;
    }> = [];
    let lateMetadataWrite = false;
    let repairStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      repairStarted = resolve;
    });
    const client: DaemonClientLike = {
      async connect(timeoutMs, signal) {
        connectCalls.push({ timeoutMs, signal });
      },
      async close() {},
      async callTool() {
        return {};
      },
      async readResource() {
        return {};
      },
      async callDaemonMethod(method, _params, options) {
        rpcCalls.push({ method, timeoutMs: options?.timeoutMs, signal: options?.signal });
        if (method === "ide/status") {
          timer.advanceTime(10);
          return {
            pid: 1234,
            startedAt: 0,
            version: "test",
            buildId: "test-build",
            entryScript: "/test/dist/src/index.js",
          };
        }
        repairStarted?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", resolve, { once: true });
        });
        options?.signal?.throwIfAborted();
        lateMetadataWrite = true;
        return { repaired: true };
      },
    };
    const manager = new DaemonManager(() => client, undefined, timer);
    const repair = manager.repairControlMetadata(controller.signal, 50);

    await started;
    controller.abort();

    await expect(repair).rejects.toThrow("aborted");
    expect(connectCalls).toEqual([{ timeoutMs: 50, signal: controller.signal }]);
    expect(rpcCalls).toEqual([
      { method: "ide/status", timeoutMs: 50, signal: controller.signal },
      {
        method: "ide/repairControlMetadata",
        timeoutMs: 40,
        signal: controller.signal,
      },
    ]);
    expect(lateMetadataWrite).toBe(false);
  });
});

describe("DaemonManager stop", () => {
  function createManagerForStop(
    livePids: Set<number>,
    timer: FakeTimer,
    pidFilePath: string,
    socketPath: string,
    onLivenessCheck?: () => void,
    lockFilePath: string = join(tmpdir(), "unused-daemon-lock"),
    processSignaler: DaemonProcessSignaler = new FakeDaemonProcessSignaler(),
  ): DaemonManager {
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [...livePids].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /repo/src/index.ts --daemon-mode",
          startedAt: 1,
          processGenerationToken: `stop-generation-${pid}`,
        })),
      isProcessRunning: (pid) => {
        onLivenessCheck?.();
        return livePids.has(pid);
      },
    };
    return new DaemonManager(
      undefined,
      undefined,
      timer,
      lockFilePath,
      pidFilePath,
      socketPath,
      processFinder,
      undefined,
      undefined,
      undefined,
      processSignaler,
    );
  }

  function writeStopPidFile(pidFilePath: string, pid: number, socketPath: string): void {
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid,
        socketPath,
        port: 3000,
        startedAt: 1,
        processStartedAt: 1,
        processGenerationToken: `stop-generation-${pid}`,
        version: "test",
      }),
    );
  }

  test("fails without cleanup when the daemon remains live after SIGKILL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-stubborn-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4242;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      undefined,
      undefined,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).rejects.toThrow(
        "Daemon process 4242 did not exit after SIGKILL",
      );

      expect(signaler.signals).toEqual([
        { pid, signal: "SIGTERM" },
        { pid, signal: "SIGKILL" },
      ]);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans metadata after post-SIGKILL polling confirms exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-exit-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4243;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    let livenessChecks = 0;
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const signaler = new FakeDaemonProcessSignaler((_targetPid, signal) => {
      if (signal === "SIGKILL") {
        livePids.delete(pid);
      }
    });
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      () => {
        livenessChecks++;
      },
      undefined,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([
        { pid, signal: "SIGTERM" },
        { pid, signal: "SIGKILL" },
      ]);
      expect(livenessChecks).toBeGreaterThan(12);
      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("signals the exact PID-file generation after immediate process-table verification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-generation-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4246;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const signaler = new FakeDaemonProcessSignaler((targetPid, signal) => {
      if (targetPid === pid && signal === "SIGTERM") {
        livePids.delete(pid);
      }
    });
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      undefined,
      undefined,
      signaler,
    );

    try {
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(signaler.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("removes stale PID metadata when the observed daemon exits before pre-signal verification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-pre-signal-exit-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4247;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    let livenessChecks = 0;
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      () => {
        livenessChecks++;
        if (livenessChecks === 2) {
          livePids.delete(pid);
        }
      },
      join(directory, "daemon.lock"),
      signaler,
    );

    try {
      await expect(manager.stop()).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([]);
      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves a concurrent startup winner after the observed daemon exits before signaling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-pre-signal-winner-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const exitedPid = 4248;
    const winnerPid = 4249;
    const livePids = new Set([exitedPid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, exitedPid, socketPath);
    writeFileSync(socketPath, "old socket");
    let livenessChecks = 0;
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      () => {
        livenessChecks++;
        if (livenessChecks === 2) {
          livePids.delete(exitedPid);
        } else if (livenessChecks === 3) {
          livePids.add(winnerPid);
          writeStopPidFile(pidFilePath, winnerPid, socketPath);
          writeFileSync(socketPath, "winner socket");
        }
      },
      join(directory, "daemon.lock"),
      signaler,
    );

    try {
      await expect(manager.stop()).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([]);
      const survivingPidData = JSON.parse(readFileSync(pidFilePath, "utf-8")) as { pid: number };
      expect(survivingPidData.pid).toBe(winnerPid);
      expect(readFileSync(socketPath, "utf-8")).toBe("winner socket");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never signals a replacement that reused the PID-file PID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-pid-reuse-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4247;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [
        {
          pid,
          ppid: 1,
          command: "bun /replacement/src/index.ts --daemon-mode",
          startedAt: 2,
          processGenerationToken: "replacement-generation",
        },
      ],
      isProcessRunning: (targetPid) => targetPid === pid,
    };
    const signaler = new FakeDaemonProcessSignaler();
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      join(directory, "daemon.lock"),
      pidFilePath,
      socketPath,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
    );

    try {
      await expect(manager.stop()).rejects.toThrow("verified daemon PID was reused");
      expect(signaler.signals).toEqual([]);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans metadata when the daemon exits at the post-SIGKILL deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-deadline-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4244;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const signaler = new FakeDaemonProcessSignaler((_targetPid, signal) => {
      if (signal === "SIGKILL") {
        timer.setTimeout(() => {
          livePids.delete(pid);
        }, 1_000);
      }
    });
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      undefined,
      undefined,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([
        { pid, signal: "SIGTERM" },
        { pid, signal: "SIGKILL" },
      ]);
      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // #6140 P2 reconciliation: status() becoming observation-only must not lose
  // the LEGITIMATE cleanup for a well-formed PID file naming an already-exited
  // daemon. stop() is a deliberate, explicit user action (`--daemon stop`),
  // not a passive probe a live startup winner could race, so it is safe (and
  // expected) to reclaim a CONFIRMED-DEAD recorded daemon's files here even
  // though status() itself no longer does.
  // #6140 P1 reconciliation: a daemon publishes its control socket BEFORE
  // writing its final PID record (daemon.ts), so a live startup winner can
  // already own the socket while the PID file still names a just-exited
  // loser. stop()'s confirmed-dead cleanup must remove ONLY the stale PID
  // file — never the socket by pathname, which it cannot prove is still the
  // loser's (no lock held, no cheap ownership-proof mechanism, by design). A
  // leftover socket file is harmless: a later bind can reclaim it only after
  // proving its recorded owner dead.
  test("removes only the stale PID file for a well-formed PID file naming an already-exited daemon; a later guarded bind may reclaim the socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-already-exited-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const lockFilePath = join(directory, "daemon.lock");
    const pid = 4247;
    // The recorded PID is already dead when stop() is invoked — no live process
    // to signal at all (unlike the SIGTERM/SIGKILL cases above).
    const livePids = new Set<number>();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      undefined,
      lockFilePath,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      // No SIGTERM/SIGKILL was ever needed — status() already reported the
      // daemon as not running, so stop() never entered the kill path.
      expect(signaler.signals).toEqual([]);
      expect(existsSync(pidFilePath)).toBe(false);
      // The socket is NOT unlinked by stop() — only the O_EXCL-locked bind may
      // do that, at the next daemon start.
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Regression for the exact race the reviewer described: the PID file names a
  // dead startup loser, but a LIVE winner has already bound the same socket
  // path (a daemon publishes its socket before its final PID record). stop()
  // must still remove the stale PID file (safe: that PID is confirmed dead,
  // and the winner will write its own fresh PID record before it is done
  // starting) but must NEVER unlink the socket the winner currently owns.
  test("removes the stale PID file but never unlinks the socket when a live winner already holds it (dead-loser-PID race)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-live-winner-race-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const lockFilePath = join(directory, "daemon.lock");
    const deadLoserPid = 4248;
    // The recorded (loser) PID is confirmed dead, but a DIFFERENT, live winner
    // process now holds the socket path — stop() has no way to know this from
    // the PID file alone, which is exactly why it must never touch the socket.
    const livePids = new Set<number>();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, deadLoserPid, socketPath);
    // The winner's live socket — indistinguishable, by pathname alone, from an
    // ordinary stale socket inode.
    writeFileSync(socketPath, "live winner socket");
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      undefined,
      lockFilePath,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([]);
      expect(existsSync(pidFilePath)).toBe(false);
      // The live winner's socket must survive — this is the brick #6140 exists
      // to prevent.
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // #6140 P2 reconciliation: restricting removeConfirmedDeadPidFile to the PID
  // file protected the socket, but left the SAME check/use race on the PID
  // FILE itself — a concurrent daemon start could rewrite it with its own LIVE
  // record between this method's liveness check and cleanupDaemonFiles's
  // unlink. Fixed by acquiring the same O_EXCL namespace startup lock a
  // concurrent start holds while binding, then RE-READING under the lock
  // before deleting.
  test("does not delete the PID file when a concurrent start rewrites it with a live record before the under-lock recheck", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-concurrent-start-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const lockFilePath = join(directory, "daemon.lock");
    const deadLoserPid = 4249;
    const winnerPid = 4250;
    const livePids = new Set<number>([winnerPid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, deadLoserPid, socketPath);
    writeFileSync(socketPath, "socket");

    let livenessChecks = 0;
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      () => {
        livenessChecks++;
        // The 2nd liveness check is removeConfirmedDeadPidFile's PRE-LOCK
        // pre-check (the 1st is status()'s own check). Simulate a concurrent
        // daemon start winning the race right after that pre-check: it
        // rewrites the PID file with its own live record before this
        // method's UNDER-LOCK re-read (the 3rd liveness check) runs.
        if (livenessChecks === 2) {
          writeStopPidFile(pidFilePath, winnerPid, socketPath);
        }
      },
      lockFilePath,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([]);
      // The winner's live PID record must survive intact.
      expect(existsSync(pidFilePath)).toBe(true);
      const survivingPidData = JSON.parse(readFileSync(pidFilePath, "utf-8")) as { pid: number };
      expect(survivingPidData.pid).toBe(winnerPid);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("skips PID-file deletion without hanging when the startup lock cannot be acquired within the bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-lock-unavailable-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const lockFilePath = join(directory, "daemon.lock");
    const deadLoserPid = 4251;
    const lockHolderPid = 4252;
    // The lock holder is alive for the whole test — every acquire attempt
    // inside the bounded retry loop must see it as genuinely held.
    const livePids = new Set<number>([lockHolderPid]);
    writeStopPidFile(pidFilePath, deadLoserPid, socketPath);
    writeFileSync(socketPath, "socket");
    // A live process already holds the namespace startup lock (e.g. a
    // concurrent daemon start in progress).
    writeFileSync(lockFilePath, String(lockHolderPid));

    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      undefined,
      lockFilePath,
      signaler,
    );

    try {
      const start = timer.getCurrentTime();
      await expect(manager.stop(1_000)).resolves.toBeUndefined();
      // Bounded: stop() must give up within its own acquire bound rather than
      // hang waiting for the lock.
      expect(timer.getCurrentTime() - start).toBeLessThan(5_000);

      expect(signaler.signals).toEqual([]);
      // Deletion was skipped — the stale PID file survives for the next
      // locked bind to reclaim, exactly like the socket already does.
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("leaves files intact when stop() finds no PID file at all", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-no-pidfile-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const signaler = new FakeDaemonProcessSignaler();
    const manager = createManagerForStop(
      new Set<number>(),
      timer,
      pidFilePath,
      socketPath,
      undefined,
      undefined,
      signaler,
    );

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(signaler.signals).toEqual([]);
      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// #6140 P1 completion: status() must be purely observation-only. A transient
// DaemonClient.isAvailable() probe failure routes into
// DaemonMcpProxy.startDaemon() -> DaemonManager.status(), OUTSIDE the O_EXCL
// startup lock — if status() unlinked the socket/PID file whenever the
// recorded PID looked dead, it would delete a LIVE winner's socket during a
// startup race, recreating the exact #6140 brick through a different actor.
describe("DaemonManager status", () => {
  function writeStatusPidFile(pidFilePath: string, pid: number, socketPath: string): void {
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid,
        socketPath,
        port: 3000,
        startedAt: 1,
        version: "test",
      }),
    );
  }

  test("never unlinks the socket or PID file when the recorded PID is dead", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-status-dead-pid-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4245;
    try {
      writeStatusPidFile(pidFilePath, pid, socketPath);
      // A stale socket inode is present but the recorded PID is confirmed dead —
      // exactly the shape a concurrent startup winner's live socket + a stale
      // loser PID file would present.
      writeFileSync(socketPath, "socket");
      const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
        findDaemonProcesses: () => [],
        isProcessRunning: () => false,
      };
      const manager = new DaemonManager(
        undefined,
        undefined,
        undefined,
        join(tmpdir(), "unused-daemon-lock"),
        pidFilePath,
        socketPath,
        processFinder,
      );

      const status = await manager.status();

      expect(status).toEqual({ running: false });
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports running without touching any files when the recorded PID is alive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-status-live-pid-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4246;
    try {
      writeStatusPidFile(pidFilePath, pid, socketPath);
      writeFileSync(socketPath, "socket");
      const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
        findDaemonProcesses: () => [],
        isProcessRunning: () => true,
      };
      const manager = new DaemonManager(
        undefined,
        undefined,
        undefined,
        join(tmpdir(), "unused-daemon-lock"),
        pidFilePath,
        socketPath,
        processFinder,
      );

      const status = await manager.status();

      expect(status.running).toBe(true);
      expect(status.pid).toBe(pid);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class FakeDaemonClient implements DaemonClientLike {
  readonly readResourceCalls: string[] = [];
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  private readonly result: any;

  constructor(result: any) {
    this.result = result;
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    this.callToolCalls.push({ toolName, params });
    return {};
  }

  async readResource(uri: string): Promise<any> {
    this.readResourceCalls.push(uri);
    return this.result;
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    this.callDaemonMethodCalls.push({ method, params });
    return {};
  }
}

class FakeDaemonProcessFinder implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  constructor(
    private readonly records: DaemonProcessRecord[],
    private readonly livePids: Set<number> = new Set(records.map((record) => record.pid)),
  ) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    return this.records;
  }

  isProcessRunning(pid: number): boolean {
    return this.livePids.has(pid);
  }
}

class TimeoutThenSuccessDaemonProcessFinder extends FakeDaemonProcessFinder {
  public calls = 0;

  constructor(
    private readonly timeoutFailures: number,
    records: DaemonProcessRecord[] = [],
    livePids?: Set<number>,
  ) {
    super(records, livePids);
  }

  override findDaemonProcesses(): DaemonProcessRecord[] {
    this.calls++;
    if (this.calls <= this.timeoutFailures) {
      throw new Error("spawnSync /bin/sh ETIMEDOUT");
    }
    return super.findDaemonProcesses();
  }
}

class DeadlineBoundTimeoutDaemonProcessFinder extends FakeDaemonProcessFinder {
  public readonly scanTimeouts: number[] = [];

  constructor(private readonly timer: FakeTimer) {
    super([]);
  }

  override findDaemonProcesses(timeoutMs?: number): DaemonProcessRecord[] {
    const timeout = timeoutMs ?? DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS;
    this.scanTimeouts.push(timeout);
    this.timer.advanceTime(timeout);
    throw new Error("spawnSync /bin/sh ETIMEDOUT");
  }
}

class FakeDaemonProcessSignaler implements DaemonProcessSignaler {
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  constructor(private readonly onSignal?: (pid: number, signal: NodeJS.Signals) => void) {}

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
    this.onSignal?.(pid, signal);
  }
}

/**
 * Deterministic stand-in for the real net-based port probe (issue #6260) so
 * restart tests never touch a real socket. Defaults to reporting every port
 * free, matching a healthy stop; pass `free: false` to simulate a canonical
 * port that stayed bound after cleanup.
 */
class FakeDaemonPortAvailabilityChecker implements DaemonPortAvailabilityChecker {
  public readonly checkedPorts: number[] = [];
  public readonly checkedProbes: Array<{ host: string; port: number }> = [];
  public readonly probeBudgets: Array<number | undefined> = [];

  constructor(private readonly free: boolean | ((port: number, host: string) => boolean) = true) {}

  isPortFree(port: number, host: string, timeoutMs?: number): Promise<boolean> {
    this.checkedPorts.push(port);
    this.checkedProbes.push({ host, port });
    this.probeBudgets.push(timeoutMs);
    return Promise.resolve(typeof this.free === "function" ? this.free(port, host) : this.free);
  }
}

/**
 * Port probe that takes fake time to settle (issue #7001) so degraded-scan tests
 * can prove the probe set runs concurrently and never outlives the start deadline.
 */
class SlowFakeDaemonPortAvailabilityChecker extends FakeDaemonPortAvailabilityChecker {
  public inFlight = 0;
  public maxInFlight = 0;

  constructor(
    private readonly timer: FakeTimer,
    private readonly probeDurationMs: number,
    free: boolean | ((port: number, host: string) => boolean) = true,
  ) {
    super(free);
  }

  override async isPortFree(port: number, host: string, timeoutMs?: number): Promise<boolean> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.timer.sleep(Math.min(this.probeDurationMs, timeoutMs ?? this.probeDurationMs));
      return await super.isPortFree(port, host, timeoutMs);
    } finally {
      this.inFlight--;
    }
  }
}

class FakeDaemonChildProcess extends EventEmitter {
  unref(): void {}

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function neverReadyAfterExit(child: FakeDaemonChildProcess, code: number): Promise<boolean> {
  child.exit(code);
  return new Promise(() => {});
}

class FakeExtractionCleaner implements ExtractionCleaner {
  readonly entryScripts: string[] = [];

  async removeExtractionForEntryScript(entryScript: string): Promise<boolean> {
    this.entryScripts.push(entryScript);
    return true;
  }
}

class FakeProbeListener extends EventEmitter implements ProbeListener {
  public closed = false;

  constructor(private readonly bindError?: NodeJS.ErrnoException) {
    super();
  }

  listen(_port: number, _host: string, listeningListener: () => void): this {
    if (this.bindError) {
      queueMicrotask(() => this.emit("error", this.bindError));
    } else {
      queueMicrotask(listeningListener);
    }
    return this;
  }

  close(callback: () => void): this {
    this.closed = true;
    callback();
    return this;
  }
}

function bindError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen ${code}`), { code });
}

describe("NetDaemonPortAvailabilityChecker", () => {
  test("reports a successful bind as free and closes the probe socket", async () => {
    const listener = new FakeProbeListener();
    const checker = new NetDaemonPortAvailabilityChecker(() => listener);
    await expect(checker.isPortFree(3000, "127.0.0.1", 30_000)).resolves.toBe(true);
    expect(listener.closed).toBe(true);
  });

  test("reports EADDRINUSE as occupied", async () => {
    const checker = new NetDaemonPortAvailabilityChecker(
      () => new FakeProbeListener(bindError("EADDRINUSE")),
    );
    await expect(checker.isPortFree(3000, "127.0.0.1", 30_000)).resolves.toBe(false);
  });

  test("treats an unbindable loopback address as hosting no incumbent (#7001)", async () => {
    // A container without IPv6 loopback cannot have a daemon bound on ::1, so the
    // degraded start scan must not mistake EADDRNOTAVAIL there for an incumbent.
    for (const code of ["EADDRNOTAVAIL", "EAFNOSUPPORT"]) {
      const checker = new NetDaemonPortAvailabilityChecker(
        () => new FakeProbeListener(bindError(code)),
      );
      await expect(checker.isPortFree(3000, "::1", 30_000)).resolves.toBe(true);
    }
  });

  test("fails closed without opening a socket when the budget is exhausted", async () => {
    let created = 0;
    const checker = new NetDaemonPortAvailabilityChecker(() => {
      created++;
      return new FakeProbeListener();
    });
    await expect(checker.isPortFree(3000, "127.0.0.1", 0)).resolves.toBe(false);
    expect(created).toBe(0);
  });
});

describe("DaemonLauncher command resolution", () => {
  test("uses the current entry script when one is available", () => {
    const launch = new DaemonLauncher({
      entryScript: "/tmp/auto-mobile/dist/src/index.js",
      version: "1.2.3",
      processExecPath: process.execPath,
    }).resolveCommand();

    expect(launch).toEqual({
      command: process.execPath,
      args: ["/tmp/auto-mobile/dist/src/index.js", "--daemon-mode"],
    });
  });

  test("pins bunx fallback to the initiating package version", () => {
    const launch = new DaemonLauncher({
      entryScript: null,
      version: "1.2.3",
      environment: { PATH: "/tools" },
      platform: "linux",
      executableExists: (path) => path === "/tools/bunx",
    }).resolveCommand();

    expect(launch).toEqual({
      command: "/tools/bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
    });
  });

  test("rejects unknown versions instead of falling back to latest", () => {
    expect(() =>
      new DaemonLauncher({
        entryScript: null,
        version: "unknown",
        environment: { PATH: "/tools" },
        executableExists: () => true,
      }).resolveCommand(),
    ).toThrow("current package version is unknown");
  });

  test("strips a dev git-SHA stamp so the bunx specifier is an installable release", () => {
    // A dev build reports e.g. "0.0.39+g1a2b3c4.dirty"; that is not an installable
    // npm tag, so the bunx fallback must pin the published release portion.
    const launch = new DaemonLauncher({
      entryScript: null,
      version: "0.0.39+g1a2b3c4d5e6f.dirty.abc123def456",
      environment: { PATH: "/tools" },
      platform: "linux",
      executableExists: () => true,
    }).resolveCommand();

    expect(launch).toEqual({
      command: "/tools/bunx",
      args: ["-y", "@kaeawc/auto-mobile@0.0.39", "--daemon-mode"],
    });
  });
});

describe("Daemon manager process detection", () => {
  // Tests that reach manager.start() open a daemon launch log; keep it inside the
  // per-test temp dir (set via AUTOMOBILE_DATA_DIR) rather than the real
  // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
  afterEach(() => {
    delete process.env.AUTOMOBILE_DATA_DIR;
  });

  test("parses daemon processes from ps pid ppid command output", () => {
    const records = parseDaemonProcessTable(`
      10     1 /usr/bin/unrelated --daemon-mode
      11     1 python worker.py --note auto-mobile --daemon-mode
      12     1 bunx -y other-package @kaeawc/auto-mobile --daemon-mode
      13     1 bun /worktree/unrelated/dist/src/index.js --daemon-mode
      20     1 /bin/sh -c "bun /worktree/auto-mobile/dist/src/index.js --daemon-mode"
      21    20 bun /worktree/auto-mobile/dist/src/index.js --daemon-mode
      22     1 bun /worktree/auto-mobile/dist/src/index.js
      30     1 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode
      31     1 bun x -y @kaeawc/auto-mobile@0.0.38 --daemon-mode
    `);

    expect(records).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 21,
        ppid: 20,
        command: "bun /worktree/auto-mobile/dist/src/index.js --daemon-mode",
      },
      {
        pid: 30,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
      {
        pid: 31,
        ppid: 1,
        command: "bun x -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
  });

  test("parses Linux elapsed process creation times for PID-reuse protection", () => {
    expect(
      parseDaemonProcessTable(
        "20 1 12 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
        1_000_000,
      ),
    ).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
        startedAt: 988_000,
      },
    ]);
  });

  test("keeps Linux's OS generation token stable when the wall clock jumps", () => {
    const stat = `123 (auto mobile) ${["S", ...Array(18).fill("0"), "424242"].join(" ")}`;
    const token = linuxProcessGenerationToken(stat, "boot-id");
    const timer = new FakeTimer();
    const finder = new PsDaemonProcessFinder(
      () => "20 1 12 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      "linux",
      timer,
      () => token,
    );

    const beforeClockJump = finder.findDaemonProcesses()[0]!;
    timer.advanceTime(3_600_000);
    const afterClockJump = finder.findDaemonProcesses()[0]!;

    expect(beforeClockJump.startedAt).not.toBe(afterClockJump.startedAt);
    expect(beforeClockJump.processGenerationToken).toBe("linux:boot-id:424242");
    expect(afterClockJump.processGenerationToken).toBe(beforeClockJump.processGenerationToken);
  });

  test("parses BusyBox elapsed process creation times for PID-reuse protection", () => {
    expect(
      parseBusyBoxDaemonProcessTable(
        "20 1 2-03:04:05 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
        1_000_000_000,
      ),
    ).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
        startedAt: 1_000_000_000 - (2 * 24 * 60 * 60 + 3 * 60 * 60 + 4 * 60 + 5) * 1000,
      },
    ]);
  });

  test("parses supported Darwin daemon launch forms without matching unrelated bun processes", () => {
    const lstart = "Sun Sep 13 10:57:04 2026";
    expect(
      parseDarwinDaemonProcessTable(
        [
          `20 1 ${lstart} bun /repo/src/index.ts --daemon-mode`,
          `21 1 ${lstart} bun /tmp/node_modules/@kaeawc/auto-mobile/dist/src/index.js --daemon-mode`,
          `22 1 ${lstart} /opt/homebrew/opt/bun/bin/bun /opt/homebrew/Cellar/auto-mobile/0.0.73/libexec/dist/src/index.js --daemon-mode`,
          `23 1 ${lstart} bun /repo/src/worker.ts --daemon-mode`,
          "malformed process table row",
          `not-a-pid 1 ${lstart} bun /repo/src/index.ts --daemon-mode`,
        ].join("\n"),
      ),
    ).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bun /repo/src/index.ts --daemon-mode",
        startedAt: new Date(2026, 8, 13, 10, 57, 4).getTime(),
        processGenerationToken: `darwin:${lstart}`,
      },
      {
        pid: 21,
        ppid: 1,
        command: "bun /tmp/node_modules/@kaeawc/auto-mobile/dist/src/index.js --daemon-mode",
        startedAt: new Date(2026, 8, 13, 10, 57, 4).getTime(),
        processGenerationToken: `darwin:${lstart}`,
      },
      {
        pid: 22,
        ppid: 1,
        command:
          "/opt/homebrew/opt/bun/bin/bun /opt/homebrew/Cellar/auto-mobile/0.0.73/libexec/dist/src/index.js --daemon-mode",
        startedAt: new Date(2026, 8, 13, 10, 57, 4).getTime(),
        processGenerationToken: `darwin:${lstart}`,
      },
    ]);
  });

  test("retains Darwin's raw lstart token through the repeated DST fall-back hour", () => {
    const lstart = "Sun Nov 1 01:30:00 2026";
    const record = parseDarwinDaemonProcessTable(
      `20 1 ${lstart} bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode`,
    )[0]!;

    expect(record.processGenerationToken).toBe(darwinProcessGenerationToken(lstart));
    expect(record.processGenerationToken).toBe(`darwin:${lstart}`);
  });

  test.each([
    ["linux", "ps -eo pid=,ppid=,etimes=,command="],
    ["darwin", "LC_ALL=C ps -axo pid=,ppid=,lstart=,command="],
  ] as const)(
    "uses the %s process table command with an expanded buffer and bounded timeout",
    (platform, command) => {
      const linuxProcessGenerationToken = "linux:boot-id:424242";
      const calls: Array<{
        command: string;
        options: { encoding: "utf-8"; maxBuffer: number; timeout: number };
      }> = [];
      const finder = new PsDaemonProcessFinder(
        (command, options) => {
          calls.push({ command, options });
          return platform === "darwin"
            ? "20 1 Sun Sep 13 10:57:04 2026 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode"
            : "20 1 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode";
        },
        platform,
        new FakeTimer(),
        () => linuxProcessGenerationToken,
      );

      expect(finder.findDaemonProcesses()).toEqual([
        {
          pid: 20,
          ppid: 1,
          command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
          ...(platform === "darwin"
            ? { startedAt: new Date(2026, 8, 13, 10, 57, 4).getTime() }
            : {}),
          ...(platform === "darwin"
            ? { processGenerationToken: "darwin:Sun Sep 13 10:57:04 2026" }
            : {}),
          ...(platform === "linux" ? { processGenerationToken: linuxProcessGenerationToken } : {}),
        },
      ]);
      expect(calls).toEqual([
        {
          command,
          options: {
            encoding: "utf-8",
            maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
            timeout: DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
          },
        },
      ]);
      expect(DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES).toBeGreaterThan(1024 * 1024);
    },
  );

  test("anchors Linux process ages before a delayed process-table scan", () => {
    const timer = new FakeTimer();
    timer.advanceTime(100_000);
    const finder = new PsDaemonProcessFinder(
      () => {
        timer.advanceTime(4_000);
        return "20 1 40 auto-mobile --daemon-mode";
      },
      "linux",
      timer,
    );
    expect(finder.findDaemonProcesses()[0]?.startedAt).toBe(60_000);
  });

  test("falls back to BusyBox etime under one scan deadline", () => {
    const linuxProcessGenerationToken = "linux:boot-id:424242";
    const calls: Array<{
      command: string;
      options: { encoding: "utf-8"; maxBuffer: number; timeout: number };
    }> = [];
    const timer = new FakeTimer();
    timer.advanceTime(1_000_000);
    const finder = new PsDaemonProcessFinder(
      (command, options) => {
        calls.push({ command, options });
        if (calls.length === 1) {
          timer.advanceTime(2_000);
          throw new Error("ps: invalid option -- 'e'");
        }
        return "20 1 00:00:12 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode";
      },
      "linux",
      timer,
      () => linuxProcessGenerationToken,
    );

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
        startedAt: 990_000,
        processGenerationToken: linuxProcessGenerationToken,
      },
    ]);
    expect(calls).toEqual([
      {
        command: "ps -eo pid=,ppid=,etimes=,command=",
        options: {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
          timeout: DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
        },
      },
      {
        command: "ps -o pid,ppid,etime,args",
        options: {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
          timeout: DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS - 2_000,
        },
      },
    ]);
  });

  test("reads absolute UTC Windows process birth independently of the host clock", () => {
    const startedAt = Date.parse("2026-09-14T12:00:00-05:00");
    const finder = new WindowsDaemonProcessFinder(() =>
      JSON.stringify({
        ProcessId: 30,
        ParentProcessId: 1,
        CommandLine: "auto-mobile --daemon-mode",
        StartedAt: startedAt,
      }),
    );
    expect(finder.findDaemonProcesses()[0]?.startedAt).toBe(Date.parse("2026-09-14T17:00:00Z"));
  });

  // #6140 review: execSync's `timeout: 0` means NO timeout (unbounded), not
  // "expire immediately" — a computed remaining budget can legitimately be
  // exactly 0, so it must never be forwarded to execSync as-is or the intended
  // bound is silently lost.
  test("clamps a zero requested timeout to a positive floor instead of forwarding execSync's unbounded 0", () => {
    const calls: Array<{ options: { timeout: number } }> = [];
    const finder = new PsDaemonProcessFinder((_command, options) => {
      calls.push({ options: options as { timeout: number } });
      return "";
    });

    finder.findDaemonProcesses(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeout).toBeGreaterThan(0);
  });

  test("clamps a negative requested timeout to a positive floor", () => {
    const calls: Array<{ options: { timeout: number } }> = [];
    const finder = new PsDaemonProcessFinder((_command, options) => {
      calls.push({ options: options as { timeout: number } });
      return "";
    });

    finder.findDaemonProcesses(-50);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeout).toBeGreaterThan(0);
  });

  test("still caps a requested timeout at the scan ceiling", () => {
    const calls: Array<{ options: { timeout: number } }> = [];
    const finder = new PsDaemonProcessFinder((_command, options) => {
      calls.push({ options: options as { timeout: number } });
      return "";
    });

    finder.findDaemonProcesses(DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS * 10);

    expect(calls[0].options.timeout).toBe(DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS);
  });

  test("parses daemon processes from Windows PowerShell JSON output", () => {
    const finder = new WindowsDaemonProcessFinder(() =>
      JSON.stringify([
        {
          ProcessId: 10,
          ParentProcessId: 1,
          CommandLine: "C:\\\\Windows\\\\System32\\\\cmd.exe /c unrelated --daemon-mode",
        },
        {
          ProcessId: 20,
          ParentProcessId: 1,
          CommandLine: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
        },
        {
          ProcessId: 21,
          ParentProcessId: 20,
          CommandLine:
            "C:\\\\Program Files\\\\nodejs\\\\node.exe C:\\\\repo\\\\auto-mobile\\\\dist\\\\src\\\\index.js --daemon-mode",
        },
        {
          ProcessId: 22,
          ParentProcessId: 1,
          CommandLine: null,
        },
      ]),
    );

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
      {
        pid: 21,
        ppid: 20,
        command:
          "C:\\\\Program Files\\\\nodejs\\\\node.exe C:\\\\repo\\\\auto-mobile\\\\dist\\\\src\\\\index.js --daemon-mode",
      },
    ]);
  });

  test("uses a Windows-native process table command with the expanded buffer and a bounded timeout", () => {
    const calls: Array<{
      command: string;
      options: { encoding: "utf-8"; maxBuffer: number; timeout: number };
    }> = [];
    const finder = new WindowsDaemonProcessFinder((command, options) => {
      calls.push({ command, options });
      return JSON.stringify({
        ProcessId: 30,
        ParentProcessId: 1,
        CommandLine: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      });
    });

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 30,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
    expect(calls).toEqual([
      {
        command:
          "powershell.exe -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{Name='StartedAt';Expression={([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress\"",
        options: {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
          timeout: DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
        },
      },
    ]);
  });

  test("selects Windows process detection by platform", () => {
    expect(createDefaultDaemonProcessFinder("win32")).toBeInstanceOf(WindowsDaemonProcessFinder);
    expect(createDefaultDaemonProcessFinder("linux")).toBeInstanceOf(PsDaemonProcessFinder);
  });

  function managerWithProcesses(
    records: DaemonProcessRecord[],
    options: { livePids?: Set<number>; pidFilePath?: string } = {},
  ): DaemonManager {
    return new DaemonManager(
      undefined,
      undefined,
      undefined,
      undefined,
      options.pidFilePath,
      undefined,
      new FakeDaemonProcessFinder(records, options.livePids),
      undefined,
    );
  }

  function writeDaemonPidFile(pidFilePath: string, pid: number): void {
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid,
        socketPath: "/tmp/auto-mobile-test.sock",
        port: 3000,
        startedAt: 1,
        version: "test",
      }),
    );
  }

  test("reports a shell-launched daemon once using the long-lived daemon child PID", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `/bin/sh -c "${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 101,
        ppid: 100,
        command: `${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([101]);
  });

  test("reports Windows shell-launched daemons once using the long-lived child PID", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `C:\\\\Windows\\\\System32\\\\cmd.exe /d /s /c "${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode"`,
      },
      {
        pid: 101,
        ppid: 100,
        command: `${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode`,
      },
      {
        pid: 200,
        ppid: 1,
        command: `C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe -NoProfile -Command "${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode"`,
      },
      {
        pid: 201,
        ppid: 200,
        command: `${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([101, 201]);
  });

  test("does not report the current daemon's shell wrapper as another daemon", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `/bin/sh -c "${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: process.pid,
        ppid: 100,
        command: `${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([]);
  });

  test("filters the active daemon PID while preserving distinct live daemons", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-pid-file-test-"));
    const pidFilePath = join(dir, "daemon.pid");
    writeDaemonPidFile(pidFilePath, 201);
    const manager = managerWithProcesses(
      [
        {
          pid: 200,
          ppid: 1,
          command: `/bin/sh -c "bun /worktree-a/dist/src/index.js --daemon-mode"`,
        },
        {
          pid: 201,
          ppid: 200,
          command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
        },
        {
          pid: 300,
          ppid: 1,
          command: `/bin/sh -c "bun /worktree-b/dist/src/index.js --daemon-mode"`,
        },
        {
          pid: 301,
          ppid: 300,
          command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
        },
      ],
      { livePids: new Set([201, 301]), pidFilePath },
    );

    try {
      expect(manager.findOtherDaemonProcesses(201)).toEqual([301]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes transient daemon-mode candidates that are gone by liveness re-check", () => {
    const manager = managerWithProcesses(
      [
        {
          pid: 201,
          ppid: 200,
          command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
        },
        {
          pid: 401,
          ppid: 1,
          command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
        },
      ],
      { livePids: new Set([201]) },
    );

    expect(manager.findOtherDaemonProcesses(201)).toEqual([]);
  });

  test("ignores daemon-mode candidates that are gone by liveness re-check", () => {
    const manager = managerWithProcesses(
      [
        {
          pid: 201,
          ppid: 200,
          command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
        },
        {
          pid: 401,
          ppid: 1,
          command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
        },
      ],
      { livePids: new Set([201]) },
    );

    expect(manager.findOtherDaemonProcesses(201)).toEqual([]);
  });

  test("fails closed when the process table cannot be inspected", () => {
    const manager = new DaemonManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses() {
          throw new Error("spawn ENOBUFS");
        },
      },
    );

    expect(() => manager.findAllDaemonProcesses()).toThrow(
      "Failed to inspect daemon process table: spawn ENOBUFS",
    );
  });

  test("retries a transient process-table timeout before starting the daemon", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-process-table-timeout-test-"));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(1);
    let spawnCalls = 0;
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        spawnCalls++;
        return {
          unref() {},
          once() {
            return this;
          },
          off() {
            return this;
          },
        } as ChildProcess;
      },
    };

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }

      override async waitForReady(): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        timer,
        join(directory, "daemon.lock"),
        join(directory, "daemon.pid"),
        join(directory, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      await expect(manager.start()).resolves.toBe("started");
      expect(processFinder.calls).toBe(2);
      expect(spawnCalls).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("degrades after persistent process-table timeouts during daemon start", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker(true);
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

    try {
      const findForStart = (
        manager as unknown as {
          findLiveDaemonProcessesForStart(
            options: DaemonOptions,
            startDeadline: number,
          ): Promise<number[]>;
        }
      ).findLiveDaemonProcessesForStart.bind(manager);

      await expect(findForStart({}, timer.now() + DAEMON_STARTUP_TIMEOUT_MS)).resolves.toEqual([]);
      expect(processFinder.calls).toBe(3);
      expect(portChecker.checkedProbes).toEqual([
        { host: "127.0.0.1", port: 3000 },
        { host: "::1", port: 3000 },
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("forces strict-port after timeout degradation and preserves its bind failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-timeout-strict-port-test-"));
    const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
    process.env.AUTOMOBILE_DATA_DIR = directory;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker(true);
    const strictPortFailure = new ActionableError(
      "Port 3000 on 127.0.0.1 is required for this daemon start but is already in use by another process.",
    );
    const launcher = new DaemonLauncher({ entryScript: "daemon-entry.ts", timer });
    let capturedArgs: string[] | undefined;
    const launchSpy = spyOn(launcher, "launchAndWait").mockImplementation(async (request) => {
      capturedArgs = [...request.args];
      throw strictPortFailure;
    });

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      timer,
      join(directory, "daemon.lock"),
      join(directory, "daemon.pid"),
      join(directory, "daemon.sock"),
      processFinder,
      undefined,
      undefined,
      launcher,
      undefined,
      undefined,
      { isReachable: async () => false },
      undefined,
      portChecker,
    );

    try {
      await expect(manager.start()).rejects.toBe(strictPortFailure);
      expect(capturedArgs).toContain("--strict-port");
      expect(portChecker.checkedProbes).toEqual([
        { host: "127.0.0.1", port: 3000 },
        { host: "::1", port: 3000 },
      ]);
    } finally {
      launchSpy.mockRestore();
      if (originalDataDir === undefined) {
        delete process.env.AUTOMOBILE_DATA_DIR;
      } else {
        process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed after persistent process-table timeouts when the canonical port is bound", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker(false);
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );

    const findForStart = (
      manager as unknown as {
        findLiveDaemonProcessesForStart(
          options: DaemonOptions,
          startDeadline: number,
        ): Promise<number[]>;
      }
    ).findLiveDaemonProcessesForStart.bind(manager);

    await expect(findForStart({}, timer.now() + DAEMON_STARTUP_TIMEOUT_MS)).resolves.toEqual([-1]);
    expect(processFinder.calls).toBe(3);
    expect(portChecker.checkedProbes).toEqual([
      { host: "127.0.0.1", port: 3000 },
      { host: "::1", port: 3000 },
    ]);
  });

  test("probes the persisted owner port after configured and default ports during timeout degradation", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "daemon-manager-timeout-persisted-owner-port-test-"),
    );
    const pidFilePath = join(directory, "daemon.pid");
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid: 301,
        socketPath: join(directory, "daemon.sock"),
        port: 7654,
        startedAt: 1,
        version: "test",
      }),
    );
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker((port) => port !== 7654);
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      join(directory, "daemon.lock"),
      pidFilePath,
      join(directory, "daemon.sock"),
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );

    const findForStart = (
      manager as unknown as {
        findLiveDaemonProcessesForStart(
          options: DaemonOptions,
          startDeadline: number,
        ): Promise<number[]>;
      }
    ).findLiveDaemonProcessesForStart.bind(manager);

    try {
      await expect(
        findForStart({ port: 4567 }, timer.now() + DAEMON_STARTUP_TIMEOUT_MS),
      ).resolves.toEqual([-1]);
      expect(portChecker.checkedProbes).toEqual([
        { host: "127.0.0.1", port: 4567 },
        { host: "::1", port: 4567 },
        { host: "127.0.0.1", port: 3000 },
        { host: "::1", port: 3000 },
        { host: "127.0.0.1", port: 7654 },
        { host: "::1", port: 7654 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not spawn when timeout degradation finds the default port occupied", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "daemon-manager-timeout-default-port-owner-test-"),
    );
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker((port) => port !== 3000);
    const launcher = new DaemonLauncher({ entryScript: "daemon-entry.ts", timer });
    const launchSpy = spyOn(launcher, "launchAndWait");

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        timer,
        join(directory, "daemon.lock"),
        join(directory, "daemon.pid"),
        join(directory, "daemon.sock"),
        processFinder,
        undefined,
        undefined,
        launcher,
        undefined,
        undefined,
        undefined,
        undefined,
        portChecker,
      );

      await expect(manager.start({ port: 4567 })).rejects.toBeInstanceOf(ActionableError);
      expect(portChecker.checkedProbes).toEqual([
        { host: "127.0.0.1", port: 4567 },
        { host: "::1", port: 4567 },
        { host: "127.0.0.1", port: 3000 },
        { host: "::1", port: 3000 },
      ]);
      expect(launchSpy).not.toHaveBeenCalled();
    } finally {
      launchSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reuses a reachable daemon when timeout degradation finds the default port occupied", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "daemon-manager-timeout-reachable-default-owner-test-"),
    );
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker((port) => port !== 3000);
    const launcher = new DaemonLauncher({ entryScript: "daemon-entry.ts", timer });
    const launchSpy = spyOn(launcher, "launchAndWait");

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => new FakeDaemonClient({}),
        undefined,
        timer,
        join(directory, "daemon.lock"),
        join(directory, "daemon.pid"),
        join(directory, "daemon.sock"),
        processFinder,
        undefined,
        undefined,
        launcher,
        undefined,
        undefined,
        undefined,
        undefined,
        portChecker,
      );

      await expect(manager.start({ port: 4567 })).resolves.toBe("joined");
      expect(portChecker.checkedProbes).toEqual([
        { host: "127.0.0.1", port: 4567 },
        { host: "::1", port: 4567 },
        { host: "127.0.0.1", port: 3000 },
        { host: "::1", port: 3000 },
      ]);
      expect(launchSpy).not.toHaveBeenCalled();
    } finally {
      launchSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("probes loopback alternates so an incumbent on 127.0.0.1:3000 is found from a ::1 start", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker(
      (port, host) => !(port === 3000 && host === "127.0.0.1"),
    );
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const findForStart = (
      manager as unknown as {
        findLiveDaemonProcessesForStart(
          options: DaemonOptions,
          startDeadline: number,
        ): Promise<number[]>;
      }
    ).findLiveDaemonProcessesForStart.bind(manager);

    const options: DaemonOptions = { host: "::1", port: 4567 };
    await expect(findForStart(options, timer.now() + DAEMON_STARTUP_TIMEOUT_MS)).resolves.toEqual([
      -1,
    ]);
    expect(options.strictPort).toBeUndefined();
    expect(portChecker.checkedProbes).toEqual([
      { host: "::1", port: 4567 },
      { host: "127.0.0.1", port: 4567 },
      { host: "::1", port: 3000 },
      { host: "127.0.0.1", port: 3000 },
    ]);
  });

  test("runs degraded port probes concurrently within the remaining start deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new SlowFakeDaemonPortAvailabilityChecker(timer, 5_000);
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const findForStart = (
      manager as unknown as {
        findLiveDaemonProcessesForStart(
          options: DaemonOptions,
          startDeadline: number,
        ): Promise<number[]>;
      }
    ).findLiveDaemonProcessesForStart.bind(manager);

    const startDeadline = timer.now() + DAEMON_STARTUP_TIMEOUT_MS;
    await expect(findForStart({ port: 4567 }, startDeadline)).resolves.toEqual([]);

    // Four probes (two ports x two loopback hosts) all in flight together, each
    // handed the SAME remaining budget rather than an independent timer.
    expect(portChecker.maxInFlight).toBe(4);
    expect(portChecker.checkedProbes).toHaveLength(4);
    const budgets = new Set(portChecker.probeBudgets);
    expect(budgets.size).toBe(1);
    const [budget] = [...budgets];
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(DAEMON_STARTUP_TIMEOUT_MS);
    expect(timer.now()).toBeLessThanOrEqual(startDeadline);
  });

  test("fails closed without probing ports when the start deadline leaves no probe budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new TimeoutThenSuccessDaemonProcessFinder(Number.POSITIVE_INFINITY);
    const portChecker = new FakeDaemonPortAvailabilityChecker(false);
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const findForStart = (
      manager as unknown as {
        findLiveDaemonProcessesForStart(
          options: DaemonOptions,
          startDeadline: number,
        ): Promise<number[]>;
      }
    ).findLiveDaemonProcessesForStart.bind(manager);

    // The scans alone consume the whole budget: the retry backoff (200 + 500 ms)
    // lands exactly on the deadline, leaving nothing for the port probes.
    const options: DaemonOptions = { host: "::1", port: 4567 };
    await expect(findForStart(options, timer.now() + 700)).rejects.toThrow(
      /startup deadline elapsed/,
    );
    expect(portChecker.checkedProbes).toEqual([]);
    expect(options.strictPort).toBeUndefined();
  });

  test("bounds an existing daemon reachability wait by the remaining startup deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-existing-daemon-deadline-test-"));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses() {
        timer.advanceTime(DAEMON_STARTUP_TIMEOUT_MS - 500);
        return [
          {
            pid: 301,
            ppid: 1,
            command: "bun /worktree-b/dist/src/index.js --daemon-mode",
          },
        ];
      },
      isProcessRunning(pid) {
        return pid === 301;
      },
    };

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        timer,
        join(directory, "daemon.lock"),
        join(directory, "daemon.pid"),
        join(directory, "daemon.sock"),
        processFinder,
      );

      const error = await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );

      expect(error).toBeInstanceOf(ActionableError);
      expect(error.message).toContain("within 500ms");
      expect(timer.now()).toBeLessThanOrEqual(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("charges process-table retries and launch wait to one daemon startup deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-start-deadline-test-"));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processFinder = new DeadlineBoundTimeoutDaemonProcessFinder(timer);
    const portChecker = new FakeDaemonPortAvailabilityChecker(true);
    const launcher = new DaemonLauncher({ entryScript: "daemon-entry.ts", timer });
    const launchSpy = spyOn(launcher, "launchAndWait").mockImplementation(async (request) => {
      await timer.sleep(request.timeoutMs);
      throw new ActionableError("Daemon launch timed out within the startup deadline");
    });

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      timer,
      join(directory, "daemon.lock"),
      join(directory, "daemon.pid"),
      join(directory, "daemon.sock"),
      processFinder,
      undefined,
      undefined,
      launcher,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );

    try {
      await expect(manager.start()).rejects.toBeInstanceOf(ActionableError);
      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(processFinder.scanTimeouts).toEqual([
        DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
        DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
        DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
      ]);
      expect(timer.now()).toBeLessThanOrEqual(DAEMON_STARTUP_TIMEOUT_MS);
      expect(launchSpy.mock.calls[0]?.[0].timeoutMs).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      launchSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("start reuses a responsive live daemon when its PID record is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-takeover-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    let spawnCalls = 0;
    const processFinder = new FakeDaemonProcessFinder(
      [
        {
          pid: 301,
          ppid: 1,
          command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
        },
      ],
      new Set([301]),
    );
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], _options: SpawnOptions) =>
        ({
          get unref() {
            spawnCalls++;
            return () => {};
          },
          once() {
            return this;
          },
          off() {
            return this;
          },
        }) as ChildProcess,
    };
    const killSpy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 301) {
        killCalls.push({ pid, signal });
      }
      return true;
    }) as typeof process.kill);

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => new FakeDaemonClient({}),
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      await manager.start();

      expect(killCalls).toEqual([]);
      expect(spawnCalls).toBe(0);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("start refuses to signal a live daemon that never becomes reachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-takeover-revalidate-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses() {
        return [
          {
            pid: 301,
            ppid: 1,
            command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
          },
        ];
      },
      isProcessRunning(pid: number) {
        return pid === 301;
      },
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn while a live daemon exists");
      },
    };
    const killSpy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 301) {
        killCalls.push({ pid, signal });
      }
      return true;
    }) as typeof process.kill);

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      await expect(manager.start()).rejects.toThrow(
        "Refusing to terminate a live daemon during start",
      );

      expect(killCalls.filter(({ signal }) => signal !== 0)).toEqual([]);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bounds the wait for an unreachable live daemon to the reachability budget, not the full startup timeout (#5871)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-reachability-budget-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses() {
        return [
          {
            pid: 86961,
            ppid: 1,
            command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
          },
        ];
      },
      isProcessRunning(pid: number) {
        return pid === 86961;
      },
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn while a live daemon exists");
      },
    };
    const killSpy = spyOn(process, "kill").mockImplementation(
      ((_pid: number) => true) as typeof process.kill,
    );

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => ({
          // A live-but-useless daemon: every reachability probe is refused, so it
          // never becomes reachable and the start must give up at the budget.
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      const error = await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );
      const elapsed = fakeTimer.now() - startedAt;

      // The actionable error must be delivered within the reachability budget so
      // it beats the client's ~30s tools/list timeout (issue #5871).
      expect(error.message).toContain("Refusing to terminate a live daemon during start");
      expect(error.message).toContain(`within ${DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS}ms`);
      expect(error.message).not.toContain(`within ${DAEMON_STARTUP_TIMEOUT_MS}ms`);
      expect(elapsed).toBeLessThanOrEqual(DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS);
      // Guard against a regression that reintroduces the full 30s wait.
      expect(elapsed).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("double lock-contention delivers its failure fast when the startup-lock holder is dead, not at the full startup timeout (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-lock-contention-dead-holder-"));
    const lockPath = join(dir, "daemon.lock");
    const holderPid = 55555;
    // Another process holds the startup lock but its PID is no longer alive — a
    // crashed cold-start holder. The lock file was never released.
    writeFileSync(lockPath, formatLockContent(holderPid));
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid: number) => pid !== holderPid,
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn on the double-contention path");
      },
    };

    // Perpetual lock contention: this process can never acquire the lock, so
    // start() runs both wait-for-holder paths and then throws the lock-holder
    // startup failure. Before #5878 each wait consumed the full 30s budget, so the
    // error arrived at ~60s — long past the client's ~30s tools/list deadline.
    class ContentionDaemonManager extends DaemonManager {
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: false };
      }
    }

    try {
      const manager = new ContentionDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      const error = await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );
      const elapsed = fakeTimer.now() - startedAt;

      expect(error.message).toContain(
        "Another process is starting the daemon but it failed to become ready",
      );
      // A dead holder is detected on the first poll, so both waits bail out well
      // under the reachability budget — and nowhere near the full startup timeout
      // the pre-#5878 code would have burned twice over.
      expect(elapsed).toBeLessThanOrEqual(DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps waiting the full startup budget while the lock holder is still alive (no premature bound) (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-lock-contention-live-holder-"));
    const lockPath = join(dir, "daemon.lock");
    const holderPid = 55556;
    // The holder is alive and legitimately cold-starting the daemon (multi-simulator
    // discovery can take longer than the reachability budget), so this process must
    // NOT abandon the wait early.
    writeFileSync(lockPath, formatLockContent(holderPid));
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid: number) => pid === holderPid,
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn while the holder is alive");
      },
    };

    class ContentionDaemonManager extends DaemonManager {
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: false };
      }
    }

    try {
      const manager = new ContentionDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );
      const elapsed = fakeTimer.now() - startedAt;

      // A live holder keeps the FULL DAEMON_STARTUP_TIMEOUT_MS: had #5878 blindly
      // bounded these waits to the reachability budget instead, elapsed would be a
      // couple of reachability budgets (~20s) and this assertion would fail — the
      // guard that a legitimate slow cold start by another process is not abandoned.
      expect(elapsed).toBeGreaterThanOrEqual(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live holder that publishes its socket between the reachability and startup budgets still succeeds (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-lock-contention-slow-publish-"));
    const lockPath = join(dir, "daemon.lock");
    const socketPath = join(dir, "daemon.sock");
    const holderPid = 55559;
    // The holder is alive and legitimately cold-starting; its socket only becomes
    // connectable at ~15s — past the 10s reachability budget a blind bound would
    // have used, but well within the 30s startup budget. The liveness pivot must
    // keep waiting and reuse the daemon rather than reject the start (#5878).
    const publishAtMs = 15_000;
    writeFileSync(lockPath, formatLockContent(holderPid));
    writeFileSync(socketPath, "socket placeholder");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid: number) => pid === holderPid,
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn while the holder is alive");
      },
    };

    class ContentionDaemonManager extends DaemonManager {
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: false };
      }
    }

    try {
      const manager = new ContentionDaemonManager(
        () => ({
          async connect() {
            // The socket is not connectable until the holder finishes publishing it.
            if (fakeTimer.now() < publishAtMs) {
              throw new Error("socket not published yet");
            }
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        socketPath,
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      // Resolves (reuse) rather than rejecting — the slow-but-alive cold start is
      // not abandoned at the reachability budget.
      await manager.start();
      const elapsed = fakeTimer.now() - startedAt;

      expect(elapsed).toBeGreaterThanOrEqual(DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead holder plus a stalling stale socket still abandons fast — the probe cannot absorb the full budget (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-lock-contention-stalling-socket-"));
    const lockPath = join(dir, "daemon.lock");
    const socketPath = join(dir, "daemon.sock");
    const holderPid = 55557;
    // Dead holder, but a stale socket file is present and every connect probe
    // stalls until aborted — the case Codex flagged, where the per-poll probe was
    // handed the full remaining budget and ran before the liveness check.
    writeFileSync(lockPath, formatLockContent(holderPid));
    writeFileSync(socketPath, "stale socket placeholder");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid: number) => pid !== holderPid,
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn on the stalling-socket contention path");
      },
    };

    class ContentionDaemonManager extends DaemonManager {
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: false };
      }
    }

    try {
      const manager = new ContentionDaemonManager(
        () => ({
          async connect(_timeoutMs?: number, signal?: AbortSignal) {
            // Never resolves; only the probe's own abort ends it — modelling a
            // socket that accepts but never completes the handshake.
            await new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new Error("probe aborted"));
                return;
              }
              signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
                once: true,
              });
            });
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        socketPath,
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      const error = await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );
      const elapsed = fakeTimer.now() - startedAt;

      expect(error.message).toContain(
        "Another process is starting the daemon but it failed to become ready",
      );
      // Each stalling probe is capped to the confirm budget (two contention waits
      // plus the final confirm), so the failure is delivered in a few seconds —
      // far under the full startup timeout the uncapped probe would have burned.
      expect(elapsed).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the contention path reuses a reachable daemon even when the startup-lock holder is dead (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-contention-reuse-"));
    const lockPath = join(dir, "daemon.lock");
    const socketPath = join(dir, "daemon.sock");
    // Dead holder, but the daemon it started has already published a connectable
    // socket. start() must reuse it rather than throw the lock-holder failure.
    writeFileSync(lockPath, formatLockContent(55558));
    writeFileSync(socketPath, "socket placeholder");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: () => false,
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn when the daemon is already reachable");
      },
    };

    class ContentionDaemonManager extends DaemonManager {
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: true, pid: 4242 };
      }
    }

    try {
      const manager = new ContentionDaemonManager(
        () => ({
          async connect() {}, // reachable
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        socketPath,
        processFinder,
        processSpawner,
      );

      // Resolves (reuse) rather than throwing the lock-holder startup failure.
      await manager.start();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a capped confirmation probe does not unlink a live but slow daemon's socket (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-capped-probe-nondestructive-"));
    const socketPath = join(dir, "daemon.sock");
    // The daemon reports running and its socket exists, but the connect probe is
    // slow to be accepted (backlog / first accept after restart). A capped probe
    // that fails must NOT tear down this healthy socket (issue #5878).
    writeFileSync(socketPath, "socket placeholder");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    class RunningDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: true, pid: 9191 };
      }
    }

    try {
      const manager = new RunningDaemonManager(
        () => ({
          async connect() {
            // Never accepts within the probe budget — models a slow first accept.
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        socketPath,
      );

      // A liveness predicate that reports the holder gone forces the capped probe.
      const ready = await manager.waitForReady(5000, undefined, () => false);

      expect(ready).toBe(false);
      // The healthy daemon's socket must survive the capped probe; unlinking it
      // here is the regression this guards (a full-budget probe would still clean
      // a genuinely stale socket).
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a replacement lock holder shares one arbitration deadline, not a fresh budget each (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-replacement-deadline-"));
    const lockPath = join(dir, "daemon.lock");
    const pidA = 60001;
    const pidB = 60002;
    // Holder A initially owns the lock; part-way through A's wait it dies and B
    // reclaims the lock. Both are "alive" by liveness — the handoff is the lock
    // file's PID changing.
    writeFileSync(lockPath, formatLockContent(pidA));
    const fakeTimer = new FakeTimer();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid: number) => pid === pidA || pid === pidB,
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn during the replacement-holder handoff");
      },
    };

    class HandoffDaemonManager extends DaemonManager {
      readonly grantedTimeouts: number[] = [];
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: false };
      }
      override async waitForReady(timeout: number): Promise<boolean> {
        this.grantedTimeouts.push(timeout);
        // First wait: A runs part-way then dies and B reclaims the lock. Later
        // waits consume whatever budget they were granted.
        const consumed = this.grantedTimeouts.length === 1 ? 20_000 : timeout;
        fakeTimer.advanceTime(consumed);
        if (this.grantedTimeouts.length === 1) {
          writeFileSync(lockPath, formatLockContent(pidB));
        }
        return false;
      }
    }

    try {
      const manager = new HandoffDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );
      const elapsed = fakeTimer.now() - startedAt;

      // The replacement (B) is granted only the REMAINING time, not a fresh full
      // budget — so the total stays within one DAEMON_STARTUP_TIMEOUT_MS and the
      // failure is delivered before the client's ~30s deadline (#5878). A per-holder
      // reset would grant [30000, 30000] and take ~60s.
      expect(manager.grantedTimeouts[0]).toBe(DAEMON_STARTUP_TIMEOUT_MS);
      expect(manager.grantedTimeouts[1]).toBeLessThan(DAEMON_STARTUP_TIMEOUT_MS);
      expect(elapsed).toBeLessThanOrEqual(DAEMON_STARTUP_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the contention loop is bounded by the arbitration deadline, not a fixed holder count (#5878)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-replacement-churn-"));
    const lockPath = join(dir, "daemon.lock");
    const livePids = new Set<number>([60001]);
    writeFileSync(lockPath, formatLockContent(60001));
    const fakeTimer = new FakeTimer();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid: number) => livePids.has(pid),
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn during replacement churn");
      },
    };

    // Each wait consumes part of the budget, then the holder is replaced by a new
    // live contender — more than three handoffs, all within one deadline.
    class ChurnDaemonManager extends DaemonManager {
      readonly grantedTimeouts: number[] = [];
      override acquireLock(): boolean {
        return false;
      }
      override async status(): Promise<any> {
        return { running: false };
      }
      override async waitForReady(timeout: number): Promise<boolean> {
        this.grantedTimeouts.push(timeout);
        fakeTimer.advanceTime(Math.min(timeout, 5000));
        const nextPid = 60001 + this.grantedTimeouts.length;
        livePids.add(nextPid);
        writeFileSync(lockPath, formatLockContent(nextPid));
        return false;
      }
    }

    try {
      const manager = new ChurnDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        lockPath,
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner,
      );

      const startedAt = fakeTimer.now();
      await manager.start().then(
        () => {
          throw new Error("expected start to reject");
        },
        (rejection: unknown) => rejection as Error,
      );
      const elapsed = fakeTimer.now() - startedAt;

      // The loop waits on more than three successive live replacement holders — an
      // earlier fixed count cap would have stopped at three and reported failure
      // with time still on the clock (#5878) — while the shared deadline still
      // bounds the total.
      expect(manager.grantedTimeouts.length).toBeGreaterThan(3);
      expect(elapsed).toBeLessThanOrEqual(DAEMON_STARTUP_TIMEOUT_MS);
      // Each successive wait is granted only the shrinking remaining time.
      for (let i = 1; i < manager.grantedTimeouts.length; i++) {
        expect(manager.grantedTimeouts[i]).toBeLessThan(manager.grantedTimeouts[i - 1]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit restart force-stops an unreachable daemon without the default namespace PID record", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const candidatePid = 451;
    const livePids = new Set([candidatePid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [
        {
          pid: candidatePid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: 451_000,
          processGenerationToken: "generation-451",
        },
      ],
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler((pid, signal) => {
      if (pid === candidatePid && signal === "SIGTERM") {
        livePids.delete(pid);
      }
    });
    const manager = new DaemonManager(
      () => {
        throw new Error("unreachable daemon socket must not block explicit restart");
      },
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await manager.restart();

      expect(signaler.signals).toEqual([{ pid: candidatePid, signal: "SIGTERM" }]);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart never SIGKILLs a cross-namespace replacement after signaling the scanned generation", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const candidatePid = 452;
    let replacementInstalled = false;
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [
        {
          pid: candidatePid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: replacementInstalled ? 2_000 : 1_000,
          processGenerationToken: replacementInstalled
            ? "replacement-generation"
            : "original-generation",
        },
      ],
      isProcessRunning: (pid) => pid === candidatePid,
    };
    const signaler = new FakeDaemonProcessSignaler((_pid, signal) => {
      if (signal === "SIGTERM") {
        replacementInstalled = true;
      }
    });
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await expect(manager.restart()).rejects.toThrow("verified daemon PID was reused");
      expect(signaler.signals).toEqual([{ pid: candidatePid, signal: "SIGTERM" }]);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart force-stops every daemon from other PID-file namespaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-custom-restart-test-"));
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const candidatePids = [452, 453];
    const livePids = new Set(candidatePids);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        candidatePids.map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: pid * 1_000,
          processGenerationToken: `generation-${pid}`,
        })),
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler((pid, signal) => {
      if (signal === "SIGTERM") {
        livePids.delete(pid);
      }
    });
    const manager = new DaemonManager(
      () => {
        throw new Error("unreachable daemon socket must not block explicit restart");
      },
      undefined,
      fakeTimer,
      join(dir, "daemon.lock"),
      join(dir, "daemon.pid"),
      join(dir, "daemon.sock"),
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await manager.restart();

      expect(signaler.signals).toEqual([
        { pid: 452, signal: "SIGTERM" },
        { pid: 453, signal: "SIGTERM" },
      ]);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit restart stops the recorded daemon and every cross-namespace daemon", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const recordedPid = 451;
    const crossNamespacePid = 452;
    const livePids = new Set([recordedPid, crossNamespacePid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [recordedPid, crossNamespacePid].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: pid * 1_000,
          processGenerationToken: `generation-${pid}`,
        })),
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler((pid, signal) => {
      if (signal === "SIGTERM") {
        livePids.delete(pid);
      }
    });
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid: recordedPid,
      processStartedAt: recordedPid * 1_000,
      processGenerationToken: `generation-${recordedPid}`,
    });
    const stopSpy = spyOn(manager, "stop").mockImplementation(async () => {
      livePids.delete(recordedPid);
    });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await manager.restart();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(signaler.signals).toEqual([{ pid: crossNamespacePid, signal: "SIGTERM" }]);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart bounds recorded and cross-namespace shutdown in one cleanup window", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const recordedPid = 451;
    const crossNamespacePid = 452;
    const livePids = new Set([recordedPid, crossNamespacePid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [recordedPid, crossNamespacePid].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: pid * 1_000,
          processGenerationToken: `generation-${pid}`,
        })),
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler((pid, signal) => {
      if (pid === recordedPid) {
        // Preserve this test's existing process.kill assertions for the recorded daemon.
        process.kill(pid, signal);
        return;
      }
      if (pid === crossNamespacePid && signal === "SIGKILL") {
        fakeTimer.setTimeout(() => {
          livePids.delete(pid);
        }, 1_000);
      }
    });
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid: recordedPid,
      processStartedAt: recordedPid * 1_000,
      processGenerationToken: `generation-${recordedPid}`,
    });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);
    const killSpy = spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        fakeTimer.setTimeout(() => {
          livePids.delete(recordedPid);
        }, 1_000);
      }
      return true;
    });

    try {
      await manager.restart();

      expect(killSpy.mock.calls.filter(([pid]) => pid === recordedPid)).toEqual([
        [recordedPid, "SIGTERM"],
        [recordedPid, "SIGKILL"],
      ]);
      expect(signaler.signals.filter(({ pid }) => pid === crossNamespacePid)).toEqual([
        { pid: crossNamespacePid, signal: "SIGTERM" },
        { pid: crossNamespacePid, signal: "SIGKILL" },
      ]);
      expect(fakeTimer.now()).toBe(12_000);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      killSpy.mockRestore();
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart awaits the recorded daemon cleanup after a cross-namespace failure", async () => {
    const fakeTimer = new FakeTimer();
    const recordedPid = 451;
    const crossNamespacePid = 452;
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [recordedPid, crossNamespacePid].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: pid * 1_000,
          processGenerationToken: `generation-${pid}`,
        })),
      isProcessRunning: () => true,
    };
    const signaler = new FakeDaemonProcessSignaler(() => {
      throw new Error("EPERM");
    });
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid: recordedPid,
    });
    let recordedCleanupCompleted = false;
    const stopSpy = spyOn(manager, "stop").mockImplementation(async () => {
      await fakeTimer.sleep(1_000);
      recordedCleanupCompleted = true;
    });
    const restart = manager.restart();
    let restartSettled = false;
    void restart.then(
      () => {
        restartSettled = true;
      },
      () => {
        restartSettled = true;
      },
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(restartSettled).toBe(false);
      expect(recordedCleanupCompleted).toBe(false);

      await fakeTimer.advanceTimersByTimeAsync(1_000);

      await expect(restart).rejects.toThrow("Failed to stop verified daemon process 452");
      expect(recordedCleanupCompleted).toBe(true);
    } finally {
      stopSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart awaits every cross-namespace cleanup after one candidate fails", async () => {
    const fakeTimer = new FakeTimer();
    const failingPid = 452;
    const slowPid = 453;
    const livePids = new Set([failingPid, slowPid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [failingPid, slowPid].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: pid * 1_000,
          processGenerationToken: `generation-${pid}`,
        })),
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const signaler = new FakeDaemonProcessSignaler((pid, signal) => {
      if (pid === failingPid && signal === "SIGTERM") {
        throw new Error("EPERM");
      }
      if (pid === slowPid && signal === "SIGTERM") {
        fakeTimer.setTimeout(() => {
          livePids.delete(pid);
        }, 1_000);
      }
    });
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);
    const restart = manager.restart();
    let restartSettled = false;
    void restart.then(
      () => {
        restartSettled = true;
      },
      () => {
        restartSettled = true;
      },
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(restartSettled).toBe(false);
      expect(signaler.signals).toEqual([
        { pid: failingPid, signal: "SIGTERM" },
        { pid: slowPid, signal: "SIGTERM" },
      ]);

      await fakeTimer.advanceTimersByTimeAsync(1_000);

      await expect(restart).rejects.toThrow("Failed to stop verified daemon process 452");
      expect(livePids.has(slowPid)).toBe(false);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart does not signal a candidate that exits before the forced stop", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const candidatePid = 453;
    let livenessChecks = 0;
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [
        {
          pid: candidatePid,
          ppid: 1,
          command: "bun /other-checkout/dist/src/index.js --daemon-mode",
          startedAt: 453_000,
          processGenerationToken: "generation-453",
        },
      ],
      isProcessRunning: (pid) => {
        if (pid !== candidatePid) {
          return false;
        }
        livenessChecks++;
        return livenessChecks === 1;
      },
    };
    const signaler = new FakeDaemonProcessSignaler();
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      new FakeDaemonPortAvailabilityChecker(),
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await manager.restart();

      expect(signaler.signals).toEqual([]);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart refuses to start a second daemon when a survivor is still on the process table (issue #6260)", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    // Simulates the exact #6260 split-brain: the recorded/status() read finds
    // nothing to stop, and the cross-namespace sweep's own candidate list is
    // ALSO empty at that instant (a process-table scan miss) even though the
    // old daemon (PID 71579-alike) is still alive — cleanup reports success
    // without ever having found it. The post-cleanup survivor re-check must
    // still catch it before start() is ever called.
    const orphanPid = 71579;
    let scanCount = 0;
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => {
        scanCount++;
        // The cleanup-phase scan (call 1) misses the orphan; the post-cleanup
        // confirmation (call 2) finds it, exactly like the real ps scan would
        // once its transient miss condition (whatever caused it) clears.
        return scanCount === 1
          ? []
          : [{ pid: orphanPid, ppid: 1, command: "bun /checkout/dist/src/index.js --daemon-mode" }];
      },
      isProcessRunning: (pid) => pid === orphanPid,
    };
    const signaler = new FakeDaemonProcessSignaler();
    const portChecker = new FakeDaemonPortAvailabilityChecker();
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      let caught: unknown;
      try {
        await manager.restart();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain(`PID(s) ${orphanPid} still running`);
      // PRRT fuUIM (issue #6260): the remediation must not hand out a bare
      // `kill <pid>` from this stale process-table snapshot — that PID can be
      // recycled to an unrelated process by the time anyone acts on it. It
      // must instead point at an identity re-check using the same
      // `--daemon-mode` command-line pattern findLiveDaemonProcesses() itself
      // matches on, so only a still-matching PID gets killed.
      expect(message).toContain("--daemon-mode");
      expect(message).not.toContain(`kill ${orphanPid}\``);
      expect(startSpy).not.toHaveBeenCalled();
      // The port must never even be consulted once a live survivor is found —
      // failing on the named PID is strictly more actionable.
      expect(portChecker.checkedPorts).toEqual([]);
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart refuses to start a second daemon on a fallback port when the canonical port stays bound (issue #6260)", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: () => false,
    };
    // Cleanup found nothing to stop, and no live daemon process remains on the
    // table — but the canonical port is still held by something (a process
    // this scan could not identify as an AutoMobile daemon, or one it missed
    // entirely). Restart must fail rather than let start() silently take the
    // next port in range.
    const portChecker = new FakeDaemonPortAvailabilityChecker(false);
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({ running: false });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await expect(manager.restart()).rejects.toThrow("port 3000");
      expect(startSpy).not.toHaveBeenCalled();
      expect(portChecker.checkedPorts).toEqual([3000]);
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("explicit restart starts a single daemon on the canonical port once the previous daemon is confirmed stopped (issue #6260)", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const recordedPid = 71579;
    const livePids = new Set([recordedPid]);
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () =>
        [...livePids].map((pid) => ({
          pid,
          ppid: 1,
          command: "bun /checkout/dist/src/index.js --daemon-mode",
        })),
      isProcessRunning: (pid) => livePids.has(pid),
    };
    const portChecker = new FakeDaemonPortAvailabilityChecker();
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      processFinder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      portChecker,
    );
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      pid: recordedPid,
    });
    const stopSpy = spyOn(manager, "stop").mockImplementation(async () => {
      livePids.delete(recordedPid);
    });
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    try {
      await manager.restart();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(portChecker.checkedPorts).toEqual([3000]);
      expect(startSpy).toHaveBeenCalledWith({ strictPort: true });
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("start takeover neither signals transient candidates nor unlinks the socket before the shared bind guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-transient-takeover-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    const socketPath = join(dir, "daemon.sock");
    writeDaemonPidFile(pidFilePath, 201);
    // This may be a direct daemon's live socket. Manager startup must leave
    // reclamation to the child bind guard, which has the ownership evidence.
    writeFileSync(socketPath, "socket owned by another launcher");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const processFinder = new FakeDaemonProcessFinder(
      [
        {
          pid: 401,
          ppid: 1,
          command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
        },
      ],
      new Set(),
    );
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], _options: SpawnOptions) =>
        ({
          unref() {},
          once() {
            return this;
          },
          off() {
            return this;
          },
        }) as ChildProcess,
    };
    const killSpy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 401) {
        killCalls.push({ pid, signal });
      }
      return true;
    }) as typeof process.kill);

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        socketPath,
        processFinder,
        processSpawner,
      );

      await manager.start();

      expect(killCalls).toEqual([]);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces incomplete-extraction remediation when daemon exits with exit code 75", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-incomplete-extraction-message-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js",
    );
    const child = new FakeDaemonChildProcess();
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => child as ChildProcess,
    };
    const cleaner = new FakeExtractionCleaner();

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        await Promise.resolve();
        if (!signal?.aborted) {
          return neverReadyAfterExit(child, 75);
        }
        return false;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] }),
      );

      await expect(manager.start()).rejects.toThrow(
        "remove the incomplete extraction directory and re-run",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes an incomplete extraction and retries once after exit code 75", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-incomplete-extraction-retry-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js",
    );
    const children: FakeDaemonChildProcess[] = [];
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const processSpawner: DaemonProcessSpawner = {
      spawn: (command: string, args: string[]) => {
        const child = new FakeDaemonChildProcess();
        children.push(child);
        spawnCalls.push({ command, args: [...args] });
        return child as ChildProcess;
      },
    };
    const cleaner = new FakeExtractionCleaner();
    let waitCalls = 0;

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        waitCalls++;
        await Promise.resolve();
        if (waitCalls === 1 && !signal?.aborted) {
          return neverReadyAfterExit(children[0], 75);
        }
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] }),
      );

      await manager.start({ port: 1234 });

      expect(children).toHaveLength(2);
      expect(spawnCalls[0].args).toContain(entryScript);
      expect(spawnCalls[0].args).toContain("--port");
      expect(spawnCalls[1].args).not.toContain(entryScript);
      expect(spawnCalls[1].args).toContain("--port");
      expect(cleaner.entryScripts).toEqual([entryScript]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recomputes the launch budget before retrying an incomplete extraction", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "daemon-manager-incomplete-extraction-retry-budget-test-"),
    );
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js",
    );
    const cleaner = new FakeExtractionCleaner();
    const launcher = new DaemonLauncher({ entryScript, timer: fakeTimer });
    const launchSpy = spyOn(launcher, "launchAndWait").mockImplementation(async () => {
      if (launchSpy.mock.calls.length === 1) {
        fakeTimer.advanceTime(12_345);
        throw Object.assign(new Error("incomplete extraction"), {
          code: INCOMPLETE_EXTRACTION_CODE,
        });
      }
    });

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<DaemonStatus> {
        return { running: false };
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        undefined,
        cleaner,
        launcher,
      );

      await expect(manager.start()).resolves.toBe("started");

      expect(launchSpy).toHaveBeenCalledTimes(2);
      expect(launchSpy.mock.calls[0]?.[0].timeoutMs).toBe(DAEMON_STARTUP_TIMEOUT_MS);
      expect(launchSpy.mock.calls[1]?.[0].timeoutMs).toBe(DAEMON_STARTUP_TIMEOUT_MS - 12_345);
      expect(cleaner.entryScripts).toEqual([entryScript]);
    } finally {
      launchSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default extraction cleaner removes only the temporary extraction root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-default-extraction-cleaner-test-"));
    const dataDir = join(dir, "data");
    process.env.AUTOMOBILE_DATA_DIR = dataDir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const extractionRoot = join(dir, "bunx-extract");
    const packageDir = join(
      extractionRoot,
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
    );
    mkdirSync(packageDir, { recursive: true });
    const entryScript = join(packageDir, "index.js");
    writeFileSync(entryScript, "");
    const children: FakeDaemonChildProcess[] = [];
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const processSpawner: DaemonProcessSpawner = {
      spawn: (command: string, args: string[]) => {
        const child = new FakeDaemonChildProcess();
        children.push(child);
        spawnCalls.push({ command, args: [...args] });
        return child as ChildProcess;
      },
    };
    let waitCalls = 0;

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        waitCalls++;
        await Promise.resolve();
        if (waitCalls === 1 && !signal?.aborted) {
          return neverReadyAfterExit(children[0], 75);
        }
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dataDir, "daemon.lock"),
        join(dataDir, "daemon.pid"),
        join(dataDir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        undefined,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] }),
      );

      await manager.start();

      expect(children).toHaveLength(2);
      expect(spawnCalls[0].args).toContain(entryScript);
      expect(spawnCalls[1].args).not.toContain(entryScript);
      expect(existsSync(extractionRoot)).toBe(false);
      expect(existsSync(dataDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gives up with remediation when the retry exits with exit code 75 again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-incomplete-extraction-give-up-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js",
    );
    const children: FakeDaemonChildProcess[] = [];
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        const child = new FakeDaemonChildProcess();
        children.push(child);
        return child as ChildProcess;
      },
    };
    const cleaner = new FakeExtractionCleaner();

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        await Promise.resolve();
        if (!signal?.aborted) {
          return neverReadyAfterExit(children[children.length - 1], 75);
        }
        return false;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] }),
      );

      await expect(manager.start()).rejects.toThrow(
        "remove the incomplete extraction directory and re-run",
      );
      expect(children).toHaveLength(2);
      expect(cleaner.entryScripts).toEqual([entryScript]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not remove or retry for non-incomplete-extraction daemon exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-generic-exit-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const child = new FakeDaemonChildProcess();
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => child as ChildProcess,
    };
    const cleaner = new FakeExtractionCleaner();

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        await Promise.resolve();
        if (!signal?.aborted) {
          return neverReadyAfterExit(child, 1);
        }
        return false;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [join(dir, "entry.js"), "--daemon-mode"] }),
      );

      await expect(manager.start()).rejects.toThrow(
        "Daemon subprocess exited before becoming ready (exit code 1)",
      );
      expect(cleaner.entryScripts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Daemon manager available-devices", () => {
  test("queries the booted devices resource when daemon is not initialized", async () => {
    const result = {
      contents: [
        {
          text: JSON.stringify({
            poolStatus: {
              idle: 2,
              assigned: 1,
              error: 0,
              total: 3,
              recoveryPolicy: { onLoss: true, maxAttempts: 2 },
            },
            devices: [
              {
                deviceId: "emulator-5554",
                platform: "android",
                recoveryEligibility: { eligible: true, action: "restart" },
              },
            ],
          }),
        },
      ],
    };
    const fakeClient = new FakeDaemonClient(result);
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    try {
      await runDaemonCommand("available-devices", [], {
        clientFactory: () => fakeClient,
        stateProvider: () =>
          ({
            isInitialized: () => false,
            getDevicePool: () => {
              throw new Error("Device pool unavailable");
            },
            getSessionManager: () => {
              throw new Error("Session manager unavailable");
            },
            getDeviceSessionRegistry: () => {
              throw new Error("Device session registry unavailable");
            },
          }) satisfies DaemonStateLike,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
    expect(fakeClient.callToolCalls).toHaveLength(0);
    expect(output).toContain(
      JSON.stringify({
        availableDevices: 2,
        totalDevices: 3,
        assignedDevices: 1,
        errorDevices: 0,
        recoveryPolicy: { onLoss: true, maxAttempts: 2 },
        devices: [
          {
            deviceId: "emulator-5554",
            platform: "android",
            recoveryEligibility: { eligible: true, action: "restart" },
          },
        ],
      }),
    );
  });

  test("uses daemon state pool stats when initialized", async () => {
    const fakeClient = new FakeDaemonClient({});
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    const fakeState: DaemonStateLike = {
      isInitialized: () => true,
      getDevicePool: () =>
        ({
          getStats: () => ({
            idle: 1,
            assigned: 2,
            error: 1,
            total: 4,
          }),
          getRecoveryPolicy: () => ({ onLoss: false, maxAttempts: 2 }),
          getAllDevices: () => [
            {
              id: "physical-ios-device",
              platform: "ios",
            },
          ],
          getRecoveryEligibility: () => ({ eligible: false, reason: "unsupported-platform" }),
        }) as any,
      getSessionManager: () =>
        ({
          getSession: () => null,
          releaseSession: async () => null,
        }) as any,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };

    try {
      await runDaemonCommand("available-devices", [], {
        clientFactory: () => fakeClient,
        stateProvider: () => fakeState,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.readResourceCalls).toHaveLength(0);
    expect(output).toContain(
      JSON.stringify({
        availableDevices: 1,
        totalDevices: 4,
        assignedDevices: 2,
        errorDevices: 1,
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
        devices: [
          {
            deviceId: "physical-ios-device",
            platform: "ios",
            recoveryEligibility: { eligible: false, reason: "unsupported-platform" },
          },
        ],
      }),
    );
  });
});

describe("Daemon manager heartbeat", () => {
  test("parses an owned recurring heartbeat command", () => {
    expect(
      parseDaemonHeartbeatCommandArgs([
        "session-1",
        "--liveness-owner-token",
        "ios-video-keeper",
        "--claim-liveness-ownership",
      ]),
    ).toEqual({
      sessionId: "session-1",
      livenessOwnerToken: "ios-video-keeper",
      claimLivenessOwnership: true,
    });
  });

  test("records a session heartbeat through the daemon socket", async () => {
    const fakeClient = new FakeDaemonClient({});
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    try {
      await runDaemonCommand("heartbeat", ["session-1"], {
        clientFactory: () => fakeClient,
        stateProvider: () =>
          ({
            isInitialized: () => false,
            getDevicePool: () => {
              throw new Error("Device pool unavailable");
            },
            getSessionManager: () => {
              throw new Error("Session manager unavailable");
            },
            getDeviceSessionRegistry: () => {
              throw new Error("Device session registry unavailable");
            },
          }) satisfies DaemonStateLike,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.callDaemonMethodCalls).toEqual([
      {
        method: "daemon/heartbeat",
        params: {
          sessionId: "session-1",
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
        },
      },
    ]);
    expect(output).toContain("Session session-1 heartbeat recorded");
  });

  test("forwards the stable owner token for a recurring heartbeat keeper", async () => {
    const fakeClient = new FakeDaemonClient({});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runDaemonCommand(
        "heartbeat",
        ["session-1", "--liveness-owner-token", "ios-video-keeper", "--claim-liveness-ownership"],
        {
          clientFactory: () => fakeClient,
          stateProvider: () =>
            ({
              isInitialized: () => false,
              getDevicePool: () => {
                throw new Error("Device pool unavailable");
              },
              getSessionManager: () => {
                throw new Error("Session manager unavailable");
              },
              getDeviceSessionRegistry: () => {
                throw new Error("Device session registry unavailable");
              },
            }) satisfies DaemonStateLike,
        },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.callDaemonMethodCalls).toEqual([
      {
        method: "daemon/heartbeat",
        params: {
          sessionId: "session-1",
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
          livenessOwnerToken: "ios-video-keeper",
          claimLivenessOwnership: true,
        },
      },
    ]);
  });
});
