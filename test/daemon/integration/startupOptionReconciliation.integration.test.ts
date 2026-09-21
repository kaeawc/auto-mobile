import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../../src/daemon/client";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import type { DaemonManagerLike, DaemonRestartResult } from "../../../src/daemon/manager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonOptions, DaemonStatus } from "../../../src/daemon/types";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { sendSocketRequest } from "../helpers/socketRequest";

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getAllSessions: () => [],
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

describe("sequential startup-option reconciliation", () => {
  let server: UnixSocketServer | undefined;
  let socketPath: string;

  afterEach(async () => {
    await server?.close();
    if (socketPath && existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a configured client applies exact tools without restarting the daemon",
    async () => {
      socketPath = join(tmpdir(), `am-options-${randomUUID()}.sock`);
      const timer = new FakeTimer();
      const requestedOptions: DaemonOptions = {
        enabledTools: ["listDevices", "provisionDevice", "deleteDevice"],
      };
      server = new UnixSocketServer(
        socketPath,
        "http://localhost:0/mcp",
        createFakeDaemonState(),
        timer,
        null,
        { identityStartedAt: 1, startupOptions: {} },
      );
      await server.start();

      const bareSocketStatus = (await sendSocketRequest(socketPath, "ide/status")).result!;
      let recordedStatus: DaemonStatus = {
        running: true,
        ...bareSocketStatus,
        socketPath,
        options: {},
      };
      let restartedWith: DaemonOptions | undefined;
      const connectionProfileUuid = randomUUID();
      const manager: DaemonManagerLike = {
        status: async () => recordedStatus,
        start: async () => "started",
        restart: async (options): Promise<DaemonRestartResult> => {
          restartedWith = options;
          await server!.close();
          server = new UnixSocketServer(
            socketPath,
            "http://localhost:0/mcp",
            createFakeDaemonState(),
            timer,
            null,
            { identityStartedAt: 2, startupOptions: options },
          );
          await server.start();
          const successorStatus = (await sendSocketRequest(socketPath, "ide/status")).result!;
          // Model the real interval after the successor socket is ready but before
          // final PID metadata publishes buildId and entryScript.
          recordedStatus = {
            running: true,
            pid: successorStatus.pid,
            version: successorStatus.version,
            startedAt: successorStatus.startedAt,
            socketPath,
            options,
          };
          return "restarted";
        },
        waitForReady: async () => true,
        isStartupLockHeldByLiveProcess: () => false,
        waitForLockHolderReadiness: async () => false,
      };
      const proxy = new DaemonMcpProxy({
        socketPath,
        daemonManager: manager,
        daemonOptions: requestedOptions,
        daemonStatusProbe: async () => await new DaemonClient(socketPath).getDaemonStatus(),
        clientFactory: () =>
          new FakeDaemonClient({
            toolResultFor: (toolName) =>
              toolName === "setToolEnabled"
                ? {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          sessionUuid: connectionProfileUuid,
                          scope: "connection-profile",
                        }),
                      },
                    ],
                  }
                : undefined,
            daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
          }),
      });

      try {
        expect(await proxy.listTools()).toEqual([]);
        expect(restartedWith).toBeUndefined();
      } finally {
        await proxy.close();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "malformed startup options do not mask a valid socket-owner identity",
    async () => {
      socketPath = join(tmpdir(), `am-malformed-options-${randomUUID()}.sock`);
      server = new UnixSocketServer(
        socketPath,
        "http://localhost:0/mcp",
        createFakeDaemonState(),
        new FakeTimer(),
        null,
        {
          startupOptions: JSON.parse('{"enabledTools":"observe"}'),
        },
      );
      await server.start();

      await expect(new DaemonClient(socketPath).getDaemonStatus()).rejects.toThrow(
        "valid identity but malformed startup options",
      );
    },
  );
});
