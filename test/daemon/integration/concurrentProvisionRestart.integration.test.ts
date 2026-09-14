import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import { DaemonRestartDeferredError } from "../../../src/daemon/daemonRestartAdmission";
import {
  DaemonManager,
  type DaemonManagerLike,
  type DaemonProcessSignaler,
} from "../../../src/daemon/manager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonOptions, DaemonStatus, PidFileData } from "../../../src/daemon/types";
import { executionTracker } from "../../../src/server/executionTracker";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { sendSocketRequest } from "../helpers/socketRequest";

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

describe("concurrent client restart during provisionDevice", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    // Restart admission is process-global; this test must begin before any
    // unrelated integration test's accepted restart can fence provisioning.
    executionTracker.clearDaemonRestartPreparation();
  });

  afterEach(async () => {
    try {
      for (const dispose of cleanup.reverse()) {
        await dispose();
      }
    } finally {
      cleanup.length = 0;
      executionTracker.clearDaemonRestartPreparation();
    }
  });

  // Bun 1.3.14 crashes in this real Unix-socket admission flow on Windows;
  // daemon socket lifecycle remains covered there by platform-safe tests.
  test.skipIf(process.platform === "win32")(
    "a stale compatibility snapshot cannot terminate active provisioning",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "am-cpr-"));
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
      const socketPath = join(directory, "daemon.sock");
      const pidFilePath = join(directory, "daemon.pid");
      const lockFilePath = join(directory, "daemon.lock");
      const timer = new FakeTimer();
      timer.setCurrentTime(1);
      const socketServer = new UnixSocketServer(
        socketPath,
        "http://localhost:0/mcp",
        createFakeDaemonState(),
        timer,
        null,
      );
      await socketServer.start();
      cleanup.push(() => socketServer.close());

      const statusResponse = await sendSocketRequest(socketPath, "ide/status");
      const daemonIdentity = statusResponse.result as {
        version: string;
        pid: number;
        startedAt: number;
        buildId: string;
        entryScript: string;
      };
      const pidFile: PidFileData = {
        pid: daemonIdentity.pid,
        socketPath,
        port: 0,
        startedAt: daemonIdentity.startedAt,
        version: daemonIdentity.version,
        buildId: daemonIdentity.buildId,
        entryScript: daemonIdentity.entryScript,
      };
      writeFileSync(pidFilePath, JSON.stringify(pidFile));
      const staleSnapshot: DaemonStatus = {
        running: true,
        pid: daemonIdentity.pid,
        port: 0,
        socketPath,
        startedAt: daemonIdentity.startedAt,
        version: daemonIdentity.version,
        buildId: daemonIdentity.buildId,
        entryScript: daemonIdentity.entryScript,
      };
      const signalCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const processSignaler: DaemonProcessSignaler = {
        signal(pid, signal) {
          signalCalls.push({ pid, signal });
        },
      };
      const realManager = new DaemonManager(
        undefined,
        undefined,
        undefined,
        lockFilePath,
        pidFilePath,
        socketPath,
        undefined,
        undefined,
        undefined,
        undefined,
        processSignaler,
      );

      let enterRestart!: () => void;
      const restartEntered = new Promise<void>((resolve) => {
        enterRestart = resolve;
      });
      let allowRestart!: () => void;
      const restartAllowed = new Promise<void>((resolve) => {
        allowRestart = resolve;
      });
      const competingManager: DaemonManagerLike = {
        // Keep the competing client's observation independent from unrelated
        // parallel tests using the process-global execution tracker. The real
        // manager below still contacts the socket for its atomic admission.
        status: async () => staleSnapshot,
        start: (options?: DaemonOptions) => realManager.start(options),
        async restart(options?: DaemonOptions, expectedDaemon?: DaemonStatus) {
          enterRestart();
          await restartAllowed;
          await realManager.restart(options, expectedDaemon);
        },
        waitForReady: (...args) => realManager.waitForReady(...args),
        isStartupLockHeldByLiveProcess: () => realManager.isStartupLockHeldByLiveProcess(),
        waitForLockHolderReadiness: (timeoutMs) =>
          realManager.waitForLockHolderReadiness(timeoutMs),
      };
      const competingProxy = new DaemonMcpProxy({
        clientFactory: () => new FakeDaemonClient(),
        daemonManager: competingManager,
        // Keep availability probing on this test's isolated socket. The manager
        // below is already scoped to it; the proxy's default would otherwise
        // contend with other host-integration files through the global socket.
        socketPath,
        autoStartDaemon: true,
        clientVersion: "9999.0.0",
      });
      cleanup.push(() => competingProxy.close());

      const competingRequest = competingProxy.listTools();
      await restartEntered;

      // Register synchronously after the restart has reached its test barrier.
      // A different integration test cannot leave its process-global preparation
      // between this reset and admission, and the real socket RPC still decides
      // whether this active operation authorizes a restart.
      executionTracker.clearDaemonRestartPreparation();
      const provisioning = executionTracker.startExecution(
        "provisionDevice",
        "public-provision-session",
      );
      try {
        allowRestart();
        await expect(competingRequest).rejects.toBeInstanceOf(DaemonRestartDeferredError);
        expect(signalCalls).toEqual([]);
      } finally {
        executionTracker.endExecution(provisioning.id);
      }
    },
  );
});
