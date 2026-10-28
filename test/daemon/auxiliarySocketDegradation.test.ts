import { AuxiliarySocketHeldError } from "../../src/daemon/AuxiliarySocketHeldError";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonIdentity,
  type DaemonIdentityHost,
} from "../../src/daemon/daemonCore/DaemonIdentity";
import {
  AuxiliarySocketBindConflict,
  getUnavailableAuxiliarySockets,
  markAuxiliarySocketAvailable,
} from "../../src/daemon/auxiliarySocketAvailability";
import {
  SocketServerSingleton,
  type SocketServerLifecycle,
} from "../../src/daemon/socketServerSingleton";
import { SOCKET_PATH, DAEMON_LAUNCH_NONCE_ENV } from "../../src/daemon/wire/constants";
import { logger } from "../../src/utils/logger";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { FakeTimer } from "../fakes/FakeTimer";
import { toDaemonStatus } from "../../src/daemon/client/clientResponseDecoding";
import type { AuxiliaryDaemonSocketName, PidFileData } from "../../src/daemon/types";
import {
  createDaemonHealthCheck,
  HEALTH_CHECK_INTERVAL_MS,
} from "../../src/daemon/daemonHealthCheck";
import { DefaultObservationStreamHealth } from "../../src/daemon/ObservationStreamHealth";
import {
  DaemonMaintenance,
  type DaemonMaintenanceHost,
} from "../../src/daemon/daemonCore/DaemonMaintenance";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { daemonSocketServerDouble } from "../../src/daemon/daemonSocketServer";
import { cleanupDaemonFiles, type DaemonCleanupFileSystem } from "../../src/daemon/daemonFiles";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { InProcessMcpDispatcher } from "../../src/daemon/inProcessMcpDispatcher";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import * as database from "../../src/db";

function identityHarness(
  persist: (record: PidFileData) => Promise<void> = async () => {},
  platform: NodeJS.Platform = process.platform,
  stat = () => ({ dev: 1n, ino: 2n }),
  reportStartupFailure: (message: string) => void = () => {},
) {
  const host: DaemonIdentityHost = {
    pidFileWritten: () => true,
    setPidFileWritten: () => {},
    services: { options: () => ({}) },
    identity: {
      port: () => 3000,
      completeIdentityPublished: () => true,
      socketBindCommitted: () => true,
      incumbentOwnerGuard: () => {
        throw new Error("unused");
      },
      daemonSessionId: () => "child",
      generationStartedAt: () => 20,
      processStartedAt: () => 10,
      processGenerationToken: () => "linux:child",
    },
    cleanupDaemonFilesForShutdown: async () => {},
    writeEarlyOwnerRecord: async () => {},
    persistPidFileData: persist,
  };
  return new DaemonIdentity(host, { stat }, platform, () => ":memory:", reportStartupFailure);
}

class RefusedStream implements SocketServerLifecycle {
  isListening() {
    return false;
  }
  async start() {
    throw new AuxiliarySocketBindConflict("/fake/stream.sock", "TestStream");
  }
  async close() {
    throw new Error("pre-bind refusal must not need closing");
  }
}

describe("auxiliary stream degradation", () => {
  afterEach(() => {
    for (const warning of getUnavailableAuxiliarySockets()) {
      markAuxiliarySocketAvailable(warning.name);
    }
  });

  test("continues startup after a stream conflict, warns, and exposes unavailability over status", async () => {
    const identity = identityHarness();
    const singleton = new SocketServerSingleton<RefusedStream>();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await identity.startAuxiliarySocket("observation-stream", () =>
        singleton.start(() => new RefusedStream()),
      );
      let continued = false;
      await identity.startAuxiliarySocket("performance-stream", async () => {
        continued = true;
      });
      expect(continued).toBe(true);
      expect(singleton.instance).toBeNull();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("/fake/stream.sock"),
        expect.any(AuxiliarySocketBindConflict),
      );
      expect(identity.getDaemonFileCleanupOptions().socketPaths).not.toContain("/fake/stream.sock");
      const server = createHarnessServer("/fake/control.sock", undefined, new FakeTimer());
      const raw = await server.dispatchLocalRequest({
        id: "status",
        type: "daemon_request",
        method: "ide/status",
        params: {},
      });
      expect(toDaemonStatus(raw, "/fake/control.sock").reportedSockets).not.toHaveProperty(
        "observation-stream",
      );
      expect(toDaemonStatus(raw, "/fake/control.sock").unavailableSockets).toEqual([
        {
          code: "AUXILIARY_SOCKET_UNAVAILABLE",
          name: "observation-stream",
          socketPath: "/fake/stream.sock",
        },
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  test.each<AuxiliaryDaemonSocketName>([
    "video-recording",
    "device-gesture-recording",
    "device-snapshot",
    "appearance",
  ])("keeps the control/configuration endpoint %s fatal", async (name) => {
    const error = new AuxiliarySocketBindConflict("/fake/config.sock", "Config");
    await expect(
      identityHarness().startAuxiliarySocket(name, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(getUnavailableAuxiliarySockets()).toEqual([]);
  });

  test("held optional stream exposes holder identity through status and clears its singleton", async () => {
    const error = new AuxiliarySocketHeldError("/fake/stream.sock", "Stream", {
      holderPid: 741,
      holderVersion: "0.0.old",
      holderVerified: true,
    });
    const singleton = new SocketServerSingleton<SocketServerLifecycle>();
    await identityHarness().startAuxiliarySocket("observation-stream", () =>
      singleton.start(() => ({
        isListening: () => false,
        start: async () => {
          throw error;
        },
        close: async () => {
          throw new Error("must not close incumbent");
        },
      })),
    );
    expect(singleton.instance).toBeNull();
    const server = createHarnessServer("/fake/control.sock", undefined, new FakeTimer());
    const status = await server.dispatchLocalRequest({
      id: "holder",
      type: "daemon_request",
      method: "ide/status",
      params: {},
    });
    expect(toDaemonStatus(status, "/fake/control.sock").unavailableSockets).toEqual([
      {
        code: "AUXILIARY_SOCKET_UNAVAILABLE",
        name: "observation-stream",
        socketPath: "/fake/stream.sock",
        ...error.holder,
      },
    ]);
  });

  test.each<AuxiliaryDaemonSocketName>([
    "video-recording",
    "device-gesture-recording",
    "device-snapshot",
    "appearance",
  ])("fatal held endpoint %s emits the holder line before refusing startup", async (name) => {
    const error = new AuxiliarySocketHeldError("/fake/config.sock", name, {
      holderPid: 741,
      holderVersion: "0.0.old",
      holderVerified: true,
    });
    const output: string[] = [];
    const identity = identityHarness(undefined, undefined, undefined, (line) => {
      output.push(line);
    });
    await expect(
      identity.startAuxiliarySocket(name, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(output).toEqual([error.message]);
    expect(output[0]).toContain("pid 741 (version 0.0.old; verified)");
    expect(getUnavailableAuxiliarySockets()).toEqual([]);
  });

  test("a broken stderr writer preserves the original held-socket startup error", async () => {
    const error = new AuxiliarySocketHeldError("/fake/config.sock", "appearance", {
      holderVerified: false,
    });
    const pipeError = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const identity = identityHarness(undefined, undefined, undefined, () => {
      throw pipeError;
    });
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await expect(
        identity.startAuxiliarySocket("appearance", async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("broken pipe"), pipeError);
    } finally {
      debug.mockRestore();
    }
  });

  test("other stream startup failures remain fatal", async () => {
    const error = new Error("permission denied");
    await expect(
      identityHarness().startAuxiliarySocket("observation-stream", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  test("successful recovery clears the typed warning", async () => {
    const identity = identityHarness();
    await identity.startAuxiliarySocket("observation-stream", async () => {
      throw new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream");
    });
    await identity.startAuxiliarySocket("observation-stream", async () => {});
    expect(getUnavailableAuxiliarySockets()).toEqual([]);
  });

  test("health ticks retry a held observation bind without full recovery and clear degradation after release", async () => {
    const identity = identityHarness();
    const timer = new FakeTimer();
    let holderAlive = true;
    let listening = false;
    let binds = 0;
    let probes = 0;
    let fullRecoveries = 0;
    let identityRepublishes = 0;
    let callbacks = 0;
    const start = () =>
      identity.startAuxiliarySocket("observation-stream", async () => {
        binds++;
        if (holderAlive) {
          throw new AuxiliarySocketHeldError("/fake/stream.sock", "observation-stream", {
            holderPid: 741,
            holderVerified: true,
          });
        }
        listening = true;
      });
    const health = new DefaultObservationStreamHealth({
      getServer: () =>
        listening ? { isListening: () => true, hasActiveSocketPath: () => true } : null,
      stopServer: async () => {
        listening = false;
      },
      startServer: start,
      configureCallbacks: () => {
        callbacks++;
      },
    });
    // Match production's injected observation recovery, including its auxiliary bind wrapper.
    const retry = { retryDegradedObservationStream: () => health.recover() };
    const check = createDaemonHealthCheck({
      timer,
      httpServer: () => ({ listening: true }),
      socketServerListening: () => true,
      observationStreamHealthy: () => health.isHealthy(),
      onObservationStreamRestored: async () => {
        identityRepublishes++;
        return true;
      },
      databaseHealthProbe: () => ({
        check: async () => {
          probes++;
        },
      }),
      onDatabaseFailureChanged: () => {},
      recover: async () => {
        fullRecoveries++;
      },
      ...retry,
    });
    const tick = async () => {
      timer.setCurrentTime(timer.now() + HEALTH_CHECK_INTERVAL_MS);
      await timer.advanceTimeAsync(0, async () => {
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }
      });
    };
    await start();
    check.start();
    try {
      for (let i = 0; i < 4; i++) {
        await tick();
        expect(getUnavailableAuxiliarySockets()).toHaveLength(1);
      }
      expect(probes).toBe(4);
      expect(binds).toBe(5);
      expect(fullRecoveries).toBe(0);
      expect(identityRepublishes).toBe(0);
      holderAlive = false;
      await tick();
      expect(health.isHealthy()).toBe(true);
      expect(getUnavailableAuxiliarySockets()).toEqual([]);
      expect(callbacks).toBe(5);
      expect(identityRepublishes).toBe(1);
      await tick();
      expect(binds).toBe(6);
      expect(probes).toBe(6);
      expect(fullRecoveries).toBe(0);
      expect(identityRepublishes).toBe(1);
    } finally {
      await check.stop();
    }
  });

  test("control recovery records the replacement inode so cleanup removes socket before PID", async () => {
    const timer = new FakeTimer();
    let inode = { dev: 1n, ino: 2n };
    const identity = identityHarness(undefined, "linux", () => inode);
    identity.recordControlSocketIdentity();
    const ownerGuard = new IncumbentOwnerGuard({
      readPidFile: () => null,
      persistPidFile: () => {},
      isProcessRunning: () => false,
      readProcessGenerationToken: () => undefined,
    });
    let control = daemonSocketServerDouble({ isListening: () => false, close: async () => {} });
    const unused = (): never => {
      throw new Error("unexpected maintenance side effect");
    };
    const host: DaemonMaintenanceHost = {
      services: {
        timer: () => timer,
        idGenerator: () => new CountingIdGenerator("rebind"),
        options: () => ({}),
        mcpDispatcher: () =>
          new InProcessMcpDispatcher({
            idGenerator: new CountingIdGenerator("forward"),
            createServer: unused,
            cancelScopeExecutions: unused,
            forgetScopeBindings: unused,
            closeReason: unused,
          }),
        httpIngress: unused,
        sessionManager: unused,
        devicePool: unused,
        databaseHealthProbe: unused,
      },
      identity: { recordControlSocketIdentity: () => identity.recordControlSocketIdentity() },
      identityState: {
        incumbentOwnerGuard: () => ownerGuard,
        generationStartedAt: () => 1,
        processStartedAt: () => 1,
        processGenerationToken: () => undefined,
        liveAcceptanceStartupSecret: () => undefined,
        acceptanceDiscoveryCapability: () => undefined,
      },
      lifecycle: {
        socketServer: () => control,
        setSocketServer: (server) => {
          if (server) {
            control = server;
          }
        },
        startupCompletion: () => Promise.resolve(),
        selfExitRecorder: unused,
        heartbeatMonitor: unused,
        setHeartbeatMonitor: unused,
        navigationRetentionMonitor: unused,
        setNavigationRetentionMonitor: unused,
        forwardLeaseIdleReleaser: unused,
        setForwardLeaseIdleReleaser: unused,
        orphanWatchdog: unused,
        setOrphanWatchdog: unused,
      },
      observationStreamHealth: () => ({ isHealthy: () => true, recover: unused }),
      setObservationStreamHealth: unused,
      healthCheck: unused,
      setHealthCheck: unused,
      lastDatabaseHealthFailure: unused,
      setLastDatabaseHealthFailure: unused,
      recoverFromDatabaseHealthFailure: unused,
      attemptRecovery: unused,
      sessionExecutionProbe: unused,
      cancelAndReleaseSession: unused,
      republishIdentity: unused,
      configureDeviceDataStreamServer: unused,
    };
    // A successful fake bind replaces the inode; no real listener or path is touched.
    const start = spyOn(UnixSocketServer.prototype, "start").mockImplementation(async () => {
      inode = { dev: 1n, ino: 3n };
    });
    const errors: string[] = [];
    const logError = spyOn(logger, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const flags = spyOn(FeatureFlagService, "getInstance").mockReturnValue(
      new FeatureFlagService(new FakeFeatureFlagRepository(), new FakeFeatureFlagApplier()),
    );
    const databasePath = spyOn(database, "getDatabasePath").mockReturnValue(":memory:");
    try {
      await new DaemonMaintenance(host).attemptRecovery("socket");
      expect(errors).toEqual([]);
      expect(start).toHaveBeenCalledTimes(1);
      const options = identity.getDaemonFileCleanupOptions();
      const paths = new Set([SOCKET_PATH, "/fake/daemon.pid"]);
      const unlinked: string[] = [];
      const unlink = (path: string) => {
        paths.delete(path);
        unlinked.push(path);
      };
      const files: DaemonCleanupFileSystem = {
        exists: (path) => paths.has(path),
        stat: () => inode,
        unlink: async (path) => {
          unlink(path);
        },
        unlinkSync: unlink,
        renameSync: (from, to) => {
          paths.delete(from);
          paths.add(to);
        },
        linkSync: (from, to) => {
          if (paths.has(to)) {
            throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
          }
          paths.add(to);
        },
        copyFileExclusiveSync: (from, to) => {
          if (paths.has(to)) {
            throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
          }
          if (!paths.has(from)) {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          paths.add(to);
        },
        readPid: () => ({
          pid: process.pid,
          socketPath: SOCKET_PATH,
          port: 3000,
          startedAt: 1,
          version: "test",
        }),
        persistOwner: () => {},
      };
      await cleanupDaemonFiles({ ...options, pidFilePath: "/fake/daemon.pid" }, files);
      expect(unlinked).toEqual([SOCKET_PATH, expect.stringContaining("/fake/daemon.pid.reap-")]);
      expect(options.socketFileIdentities.get(SOCKET_PATH)).toEqual(inode);
      expect(paths.size).toBe(0);
    } finally {
      databasePath.mockRestore();
      flags.mockRestore();
      logError.mockRestore();
      start.mockRestore();
    }
  });

  test("records control inode alongside auxiliary inodes for cleanup", () => {
    const identity = identityHarness();
    identity.recordControlSocketIdentity();
    const options = identity.getDaemonFileCleanupOptions();
    expect(options.socketPaths).toContain(SOCKET_PATH);
    expect(options.socketFileIdentities.get(SOCKET_PATH)).toEqual({ dev: 1n, ino: 2n });
  });
});

test("unknown future socket diagnostics cannot invalidate daemon identity", () => {
  const warning = {
    code: "AUXILIARY_SOCKET_UNAVAILABLE",
    name: "future-stream",
    socketPath: "/fake/future.sock",
  };
  expect(
    toDaemonStatus(
      { pid: 400, version: "test", unavailableSockets: [warning] },
      "/fake/control.sock",
    ),
  ).toMatchObject({
    pid: 400,
    version: "test",
    unavailableSockets: [warning],
  });
});

test("PID record omits degraded streams and publishes the launch nonce", async () => {
  const records: PidFileData[] = [];
  const identity = identityHarness(async (record) => {
    records.push(record);
  });
  const previousNonce = process.env[DAEMON_LAUNCH_NONCE_ENV];
  process.env[DAEMON_LAUNCH_NONCE_ENV] = "launch-uuid";
  try {
    await identity.startAuxiliarySocket("observation-stream", async () => {
      throw new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream");
    });
    await identity.writePidFile();
    expect(records[0]?.sockets).not.toHaveProperty("observation-stream");
    expect(records[0]?.sockets).toHaveProperty("control");
    expect(records[0]?.launchNonce).toBe("launch-uuid");
    const server = createHarnessServer("/fake/control.sock", undefined, new FakeTimer());
    const status = await server.dispatchLocalRequest({
      id: "nonce",
      type: "daemon_request",
      method: "ide/status",
      params: {},
    });
    expect(toDaemonStatus(status, "/fake/control.sock").launchNonce).toBe("launch-uuid");
  } finally {
    markAuxiliarySocketAvailable("observation-stream");
    if (previousNonce === undefined) {
      delete process.env[DAEMON_LAUNCH_NONCE_ENV];
    } else {
      process.env[DAEMON_LAUNCH_NONCE_ENV] = previousNonce;
    }
  }
});

test.each<NodeJS.Platform>(["win32", "linux"])(
  "socket stat failure uses the appropriate log level on %s",
  (platform) => {
    const identity = identityHarness(undefined, platform, () => {
      throw new Error("no inode");
    });
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      identity.recordControlSocketIdentity();
      expect(platform === "win32" ? debug : warn).toHaveBeenCalledWith(
        expect.stringContaining("Cannot record ownership"),
      );
      expect(platform === "win32" ? warn : debug).not.toHaveBeenCalled();
      expect(identity.getDaemonFileCleanupOptions().socketPaths).toEqual([]);
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  },
);
