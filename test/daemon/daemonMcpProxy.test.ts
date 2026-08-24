import { describe, expect, test, spyOn } from "bun:test";
import {
  DaemonMcpProxy,
  DaemonVersionMismatchError,
  DaemonBuildMismatchError,
  DaemonToolUnavailableError,
} from "../../src/daemon/daemonMcpProxy";
import {
  DaemonClient,
  DaemonUnavailableError,
  type DaemonClientLike,
} from "../../src/daemon/client";
import { ActionableError } from "../../src/models";
import {
  DAEMON_VERSION,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../../src/daemon/constants";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DeviceControlTransportError } from "../../src/daemon/deviceControlTransportFailure";

const OLDER_VERSION = "0.0.1";
const NEWER_VERSION = "9999.0.0";
// Pinned plain client version for the version-gate suite. The ambient
// DAEMON_VERSION is git-SHA-stamped in a source checkout (e.g. "0.0.39+g...")
// which is intentionally non-numeric; these tests exercise release-version
// (numeric) comparison semantics, so the client version is injected explicitly.
const CLIENT_VERSION = "0.0.39";
const ANCIENT_TIMESTAMP = 1;

// A FakeDaemonManager reporting a running daemon whose version matches this
// client (the ambient stamped DAEMON_VERSION). Forwarding/recovery tests use a
// real DaemonClient stub but must NOT consult the real local DaemonManager —
// otherwise a release daemon running on the dev machine (version "0.0.39") would
// mismatch the stamped client and trip the version gate. No buildId is set, so
// the build-identity gate treats it as a match (missing identity = compatible).
const matchingDaemonManager = (): FakeDaemonManager => {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
};

class ScriptedDaemonClient implements DaemonClientLike {
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly readResourceCalls: string[] = [];
  readonly readResourceParams: Array<Record<string, any>> = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  connectCallCount = 0;
  closeCallCount = 0;

  constructor(
    private readonly behavior: {
      toolResult?: any;
      toolError?: Error;
      toolErrorByName?: Map<string, Error>;
      resourceResult?: any;
      resourceError?: Error;
      daemonMethodResults?: Map<string, any>;
      daemonMethodError?: Error;
      daemonMethodErrors?: Map<string, Error>;
    },
  ) {}

  async connect(): Promise<void> {
    this.connectCallCount++;
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    const recordedParams = { ...params };
    delete recordedParams.__autoMobileBoundSessionUuid;
    this.callToolCalls.push({ toolName, params: recordedParams });
    const perToolError = this.behavior.toolErrorByName?.get(toolName);
    if (perToolError) {
      throw perToolError;
    }
    if (this.behavior.toolError) {
      throw this.behavior.toolError;
    }
    return this.behavior.toolResult ?? { content: [{ type: "text", text: "success" }] };
  }

  async readResource(uri: string, params: Record<string, any> = {}): Promise<any> {
    this.readResourceCalls.push(uri);
    const recordedParams = { ...params };
    delete recordedParams.__autoMobileBoundSessionUuid;
    this.readResourceParams.push(recordedParams);
    if (this.behavior.resourceError) {
      throw this.behavior.resourceError;
    }
    return this.behavior.resourceResult ?? { contents: [{ uri, text: "success" }] };
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    const recordedParams = { ...params };
    delete recordedParams.__autoMobileBoundSessionUuid;
    this.callDaemonMethodCalls.push({ method, params: recordedParams });
    const methodError = this.behavior.daemonMethodErrors?.get(method);
    if (methodError) {
      throw methodError;
    }
    if (this.behavior.daemonMethodError) {
      throw this.behavior.daemonMethodError;
    }
    return this.behavior.daemonMethodResults?.get(method) ?? {};
  }
}

describe("DaemonMcpProxy", () => {
  describe("connection management", () => {
    test("connects to daemon on first request", async () => {
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "testTool", inputSchema: {} }] }],
        ]),
      });
      const fakeManager = new FakeDaemonManager();
      fakeManager.statusResult = {
        running: true,
        pid: 1234,
        port: 3000,
        socketPath: "/tmp/test.sock",
        version: DAEMON_VERSION,
      };

      // Mock DaemonClient.isAvailable to return true
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: fakeManager,
        autoStartDaemon: false,
      });

      try {
        await proxy.listTools();

        expect(fakeClient.isConnected()).toBe(true);
        expect(fakeClient.callDaemonMethodCalls).toHaveLength(1);
        expect(fakeClient.callDaemonMethodCalls[0].method).toBe("tools/list");
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("scopes first discovery and device-aware calls to the configured initial session", async () => {
      const firstClient = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "first" }] },
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "firstScopedTool", inputSchema: {} }] }],
        ]),
      });
      const secondClient = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "second" }] },
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "secondScopedTool", inputSchema: {} }] }],
        ]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const firstProxy = new DaemonMcpProxy({
        initialSessionUuid: "device-session-a",
        clientFactory: () => firstClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });
      const secondProxy = new DaemonMcpProxy({
        initialSessionUuid: "device-session-b",
        clientFactory: () => secondClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await Promise.all([firstProxy.listTools(), secondProxy.listTools()]);
        await Promise.all([
          firstProxy.callTool("observe", { deviceId: "device-a" }),
          secondProxy.callTool("observe", { deviceId: "device-b" }),
        ]);

        expect(firstClient.callDaemonMethodCalls).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
          { method: "tools/list", params: { sessionUuid: "device-session-a" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
        ]);
        expect(secondClient.callDaemonMethodCalls).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "device-session-b" } },
          { method: "tools/list", params: { sessionUuid: "device-session-b" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-b" } },
        ]);
        expect(firstClient.callToolCalls).toEqual([
          {
            toolName: "observe",
            params: { deviceId: "device-a", sessionUuid: "device-session-a" },
          },
        ]);
        expect(secondClient.callToolCalls).toEqual([
          {
            toolName: "observe",
            params: { deviceId: "device-b", sessionUuid: "device-session-b" },
          },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await firstProxy.close();
        await secondProxy.close();
      }
    });

    test("keeps two configured session bindings alive independently while idle", async () => {
      const timer = new FakeTimer();
      const firstClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const secondClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const firstProxy = new DaemonMcpProxy({
        initialSessionUuid: "device-session-a",
        clientFactory: () => firstClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });
      const secondProxy = new DaemonMcpProxy({
        initialSessionUuid: "device-session-b",
        clientFactory: () => secondClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await Promise.all([firstProxy.listTools(), secondProxy.listTools()]);
        await timer.advanceTimeAsync(6_000);

        expect(
          firstClient.callDaemonMethodCalls.filter((call) => call.method === "daemon/heartbeat"),
        ).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
        ]);
        expect(
          secondClient.callDaemonMethodCalls.filter((call) => call.method === "daemon/heartbeat"),
        ).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "device-session-b" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-b" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-b" } },
          { method: "daemon/heartbeat", params: { sessionId: "device-session-b" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await firstProxy.close();
        await secondProxy.close();
      }
      expect(timer.getPendingIntervalCount()).toBe(0);
    });

    test("replays a learned session heartbeat through a recoverable daemon reconnect", async () => {
      const timer = new FakeTimer();
      const staleClient = new ScriptedDaemonClient({
        daemonMethodError: new DaemonUnavailableError("Daemon socket connection lost"),
      });
      const freshClient = new FakeDaemonClient();
      const clients: DaemonClientLike[] = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", {
          sessionUuid: "device-session-a",
          deviceId: "device-a",
        });
        await timer.advanceTimeAsync(2_000);

        expect(staleClient.callDaemonMethodCalls).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
        ]);
        expect(staleClient.closeCallCount).toBe(1);
        expect(freshClient.callDaemonMethodCalls).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "device-session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a stale heartbeat retry cannot fence a newer explicit binding", async () => {
      const timer = new FakeTimer();
      const heartbeatStarted = Promise.withResolvers<void>();
      const releaseFirstHeartbeat = Promise.withResolvers<void>();
      const retryHeartbeatCalled = Promise.withResolvers<void>();
      const staleClient = new FakeDaemonClient({
        onCallDaemonMethod: async (method) => {
          if (method === "daemon/heartbeat") {
            heartbeatStarted.resolve();
            await releaseFirstHeartbeat.promise;
            throw new Error("Session not found: session-a");
          }
        },
      });
      const freshClient = new FakeDaemonClient({
        onCallDaemonMethod: (method) => {
          if (method === "daemon/heartbeat") {
            retryHeartbeatCalled.resolve();
            throw new Error("Session not found: session-a");
          }
        },
      });
      const clients: DaemonClientLike[] = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", {
          sessionUuid: "session-a",
          deviceId: "device-a",
        });
        timer.advanceTime(2_000);
        await heartbeatStarted.promise;

        await proxy.callTool("observe", {
          sessionUuid: "session-b",
          deviceId: "device-b",
        });
        releaseFirstHeartbeat.resolve();
        await retryHeartbeatCalled.promise;
        await Promise.resolve();
        await Promise.resolve();

        await expect(proxy.callTool("observe", { deviceId: "device-b" })).resolves.toBeDefined();
        expect(freshClient.callToolCalls.at(-1)).toEqual({
          toolName: "observe",
          params: { deviceId: "device-b", sessionUuid: "session-b" },
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("normalizes an explicit session UUID before remembering and fencing it", async () => {
      let callCount = 0;
      const firstClient = new FakeDaemonClient({
        onCallTool: () => {
          callCount += 1;
          if (callCount === 2) {
            throw new Error("Session not found: session-a");
          }
        },
      });
      const retryClient = new ScriptedDaemonClient({
        toolError: new Error("Session not found: session-a"),
      });
      const clients: DaemonClientLike[] = [firstClient, retryClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", {
          sessionUuid: "  session-a  ",
          deviceId: "device-a",
        });
        expect(firstClient.callToolCalls[0]).toEqual({
          toolName: "observe",
          params: { sessionUuid: "session-a", deviceId: "device-a" },
        });

        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toMatchObject({
          sessionUuid: "session-a",
          reason: "session-not-found",
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a release received during connection setup prevents the first explicit call", async () => {
      const fakeClient = new FakeDaemonClient();
      fakeClient.subscribeToNotifications = async () => {
        fakeClient.emitNotification(
          SESSION_RELEASED_NOTIFICATION_METHOD,
          "session-a",
          "heartbeat-timeout",
        );
      };
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(
          proxy.callTool("observe", {
            sessionUuid: "session-a",
            deviceId: "device-a",
          }),
        ).rejects.toMatchObject({
          sessionUuid: "session-a",
          reason: "heartbeat-timeout",
        });
        expect(fakeClient.callToolCalls).toEqual([]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("observes the socket without cleanup before auto-starting", async () => {
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const fakeManager = new FakeDaemonManager();
      fakeManager.statusResult = { running: false };

      // Mock DaemonClient.isAvailable to return false initially, then true after start
      let isAvailableCalls = 0;
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockImplementation(async () => {
        isAvailableCalls++;
        return isAvailableCalls > 1;
      });

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: fakeManager,
        autoStartDaemon: true,
      });

      try {
        await proxy.listTools();

        expect(fakeManager.startCalled).toBe(true);
        expect(isAvailableSpy).toHaveBeenCalledWith(expect.any(String), { skipStaleCleanup: true });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    describe("version-mismatch handling", () => {
      function makeProxy(
        opts: {
          runningVersion?: string;
          startedAt?: number;
          autoStartDaemon?: boolean;
          waitForReadyResult?: boolean;
          daemonOptions?: { debug?: boolean; port?: number };
          statusAfterRestartVersion?: string;
          clientVersion?: string;
          daemonBuildId?: string;
          daemonEntryScript?: string;
          clientBuild?: { buildId: string; entryScript: string };
        } = {},
      ) {
        const timer = new FakeTimer();
        timer.advanceTime(100_000);
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        const initialStatus = {
          running: true,
          pid: 1234,
          port: 3000,
          socketPath: "/tmp/test.sock",
          ...(opts.runningVersion !== undefined ? { version: opts.runningVersion } : {}),
          ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
          ...(opts.daemonBuildId !== undefined ? { buildId: opts.daemonBuildId } : {}),
          ...(opts.daemonEntryScript !== undefined ? { entryScript: opts.daemonEntryScript } : {}),
        };
        fakeManager.statusResult = initialStatus;
        const restartedStatus = {
          ...initialStatus,
          version: opts.statusAfterRestartVersion ?? CLIENT_VERSION,
          startedAt: timer.now(),
          ...(opts.daemonOptions !== undefined ? { options: opts.daemonOptions } : {}),
        };
        fakeManager.statusResults = [
          initialStatus,
          restartedStatus,
          restartedStatus,
          restartedStatus,
        ];
        if (opts.waitForReadyResult !== undefined) {
          fakeManager.waitForReadyResult = opts.waitForReadyResult;
        }
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          autoStartDaemon: opts.autoStartDaemon ?? true,
          daemonOptions: opts.daemonOptions,
          timer,
          clientVersion: opts.clientVersion ?? CLIENT_VERSION,
          buildIdentity: opts.clientBuild,
        });
        return { fakeClient, fakeManager, isAvailableSpy, proxy };
      }

      async function expectVersionMismatch(
        promise: Promise<unknown>,
      ): Promise<DaemonVersionMismatchError> {
        try {
          await promise;
        } catch (error) {
          expect(error).toBeInstanceOf(DaemonVersionMismatchError);
          return error as DaemonVersionMismatchError;
        }
        throw new Error("Expected DaemonVersionMismatchError");
      }

      test("restarts daemon when MCP server version is newer", async () => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws when daemon version is newer", async () => {
        const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: NEWER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          const error = await expectVersionMismatch(proxy.listTools());
          expect(error.reason).toBe("daemonNewer");
          expect(error.daemonVersion).toBe(NEWER_VERSION);
          expect(error.clientVersion).toBe(CLIENT_VERSION);
          expect(fakeManager.restartCalled).toBe(false);
          expect(fakeClient.isConnected()).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does not restart when versions match", async () => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: CLIENT_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("allows a plain release client to use a same-release stamped daemon", async () => {
        const build = {
          buildId: "92e3642b15e5388c",
          entryScript: "/workspace/auto-mobile/dist/src/index.js",
        };
        const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeProxy({
          clientVersion: "0.0.46",
          runningVersion: "0.0.46+g8e5738e53463",
          startedAt: ANCIENT_TIMESTAMP,
          clientBuild: build,
          daemonBuildId: build.buildId,
          daemonEntryScript: build.entryScript,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
          expect(fakeClient.callDaemonMethodCalls).toEqual([{ method: "tools/list", params: {} }]);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts for a stamped client and a same-release plain daemon", async () => {
        const clientVersion = "0.0.46+g8e5738e53463";
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          clientVersion,
          runningVersion: "0.0.46",
          statusAfterRestartVersion: clientVersion,
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("self-heals same-release dev-build skew by restarting to this client's build", async () => {
        // Two checkouts at the same release (0.0.39) but different commits carry
        // different git stamps. The version gate must NOT hard-throw on the
        // non-numeric difference, and must NOT silently attach (the build-identity
        // hash is blind to non-entry-file changes in source mode) — it reconciles
        // by restarting the daemon to this client's build.
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          clientVersion: "0.0.39+gaaaaaaaaaaaa",
          runningVersion: "0.0.39+gbbbbbbbbbbbb",
          statusAfterRestartVersion: "0.0.39+gaaaaaaaaaaaa",
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws cooldown (no restart) for same-release dev-skew within the cooldown window", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeProxy({
          clientVersion: "0.0.39+gaaaaaaaaaaaa",
          runningVersion: "0.0.39+gbbbbbbbbbbbb",
          startedAt: 100_000 - Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2),
        });
        try {
          const error = await expectVersionMismatch(proxy.listTools());
          expect(error.reason).toBe("cooldown");
          expect(fakeManager.restartCalled).toBe(false);
          expect(fakeClient.isConnected()).toBe(false);
        } finally {
          warnSpy.mockRestore();
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws when daemon is older but within cooldown window", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: 100_000 - Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2),
        });
        try {
          const error = await expectVersionMismatch(proxy.listTools());
          expect(error.reason).toBe("cooldown");
          expect(error.retryAfterMs).toBe(Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2));
          expect(fakeManager.restartCalled).toBe(false);
          expect(fakeClient.isConnected()).toBe(false);
          expect(warnSpy).toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts older daemon once cooldown has elapsed", async () => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: 100_000 - DAEMON_VERSION_RESTART_COOLDOWN_MS - 1000,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws without restarting when autoStartDaemon is disabled", async () => {
        const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
          autoStartDaemon: false,
        });
        try {
          const error = await expectVersionMismatch(proxy.listTools());
          expect(error.reason).toBe("autoStartDisabled");
          expect(fakeManager.restartCalled).toBe(false);
          expect(fakeClient.isConnected()).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws when restarted daemon fails to become ready", async () => {
        const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
          waitForReadyResult: false,
        });
        try {
          await expect(proxy.listTools()).rejects.toThrow(DaemonUnavailableError);
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeClient.isConnected()).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("forwards daemonOptions when restarting", async () => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
          daemonOptions: { debug: true, port: 4242 },
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ debug: true, port: 4242 });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts when running daemon does not expose a version", async () => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws when restarted daemon version still differs", async () => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion: OLDER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
          statusAfterRestartVersion: OLDER_VERSION,
        });
        try {
          await expect(proxy.listTools()).rejects.toThrow(
            "daemon restart completed but version still differs",
          );
          expect(fakeManager.restartCalled).toBe(true);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test.each([
        ["prerelease tag", "0.0.21-beta.1"],
        ["unknown fallback", "unknown"],
        ["empty-after-prefix", "v"],
      ])("throws when version comparison is non-numeric (%s)", async (_label, runningVersion) => {
        const { fakeManager, isAvailableSpy, proxy } = makeProxy({
          runningVersion,
          startedAt: ANCIENT_TIMESTAMP,
        });
        try {
          await expect(proxy.listTools()).rejects.toThrow("version comparison is not numeric");
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });
    });

    describe("startup option mismatch handling", () => {
      function runningStatus(options: {
        debug?: boolean;
        embeddedSdk?: boolean;
        networkMockable?: boolean;
        toolResultsNoStructuredContent?: boolean;
        toolOutputsDir?: string;
        eventAllMarkers?: string[];
        eventAllMarkersCliOverride?: boolean;
        runnerReadinessTimeoutMs?: number;
        enabledTools?: string[];
        disabledTools?: string[];
      }) {
        return {
          running: true,
          pid: 1234,
          port: 3000,
          socketPath: "/tmp/test.sock",
          version: DAEMON_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
          options,
        };
      }

      test("restarts daemon when embedded SDK mode differs", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ embeddedSdk: false }), // ensureVersionMatches
          runningStatus({ embeddedSdk: false }), // ensureBuildMatches
          runningStatus({ embeddedSdk: false }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ embeddedSdk: true }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { embeddedSdk: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ embeddedSdk: true });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts daemon when debug mode differs", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ debug: false }), // ensureVersionMatches
          runningStatus({ debug: false }), // ensureBuildMatches
          runningStatus({ debug: false }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ debug: true }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { debug: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ debug: true });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts daemon when network-mockable mode differs (issue #4247)", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ networkMockable: false }), // ensureVersionMatches
          runningStatus({ networkMockable: false }), // ensureBuildMatches
          runningStatus({ networkMockable: false }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ networkMockable: true }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { networkMockable: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ networkMockable: true });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts daemon when toolResultsNoStructuredContent differs (issue #2759)", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ toolResultsNoStructuredContent: false }), // ensureVersionMatches
          runningStatus({ toolResultsNoStructuredContent: false }), // ensureBuildMatches
          runningStatus({ toolResultsNoStructuredContent: false }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ toolResultsNoStructuredContent: true }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { toolResultsNoStructuredContent: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ toolResultsNoStructuredContent: true });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts daemon when tool outputs directory differs", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ toolOutputsDir: "/tmp/old-artifacts" }), // ensureVersionMatches
          runningStatus({ toolOutputsDir: "/tmp/old-artifacts" }), // ensureBuildMatches
          runningStatus({ toolOutputsDir: "/tmp/old-artifacts" }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ toolOutputsDir: "/tmp/new-artifacts" }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { toolOutputsDir: "/tmp/new-artifacts" },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ toolOutputsDir: "/tmp/new-artifacts" });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts daemon when explicit empty event-all markers override differs", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ eventAllMarkers: ["@"] }), // ensureVersionMatches
          runningStatus({ eventAllMarkers: ["@"] }), // ensureBuildMatches
          runningStatus({ eventAllMarkers: ["@"] }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ eventAllMarkers: [], eventAllMarkersCliOverride: true }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { eventAllMarkers: [], eventAllMarkersCliOverride: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({
            eventAllMarkers: [],
            eventAllMarkersCliOverride: true,
          });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restarts daemon when requested event-all markers differ", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ eventAllMarkers: ["/"] }), // ensureVersionMatches
          runningStatus({ eventAllMarkers: ["/"] }), // ensureBuildMatches
          runningStatus({ eventAllMarkers: ["/"] }), // ensureStartupOptionsMatch (mismatch)
          runningStatus({ eventAllMarkers: ["@"] }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { eventAllMarkers: ["@"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({ eventAllMarkers: ["@"] });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does not restart daemon when output-reduction flags match", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ toolResultsNoStructuredContent: true }), // ensureVersionMatches
          runningStatus({ toolResultsNoStructuredContent: true }), // ensureBuildMatches
          runningStatus({ toolResultsNoStructuredContent: true }), // ensureStartupOptionsMatch
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { toolResultsNoStructuredContent: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does not restart daemon when embedded SDK mode matches", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ embeddedSdk: true }), // ensureVersionMatches
          runningStatus({ embeddedSdk: true }), // ensureBuildMatches
          runningStatus({ embeddedSdk: true }), // ensureStartupOptionsMatch
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { embeddedSdk: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does not restart daemon when event-all markers match", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ eventAllMarkers: ["@"] }), // ensureVersionMatches
          runningStatus({ eventAllMarkers: ["@"] }), // ensureBuildMatches
          runningStatus({ eventAllMarkers: ["@"] }), // ensureStartupOptionsMatch
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { eventAllMarkers: ["@"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does not restart for permutation-equivalent exact-tool selections", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ enabledTools: ["sqlQuery", "clipboard"] }),
          runningStatus({ enabledTools: ["sqlQuery", "clipboard"] }),
          runningStatus({ enabledTools: ["sqlQuery", "clipboard"] }),
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { enabledTools: ["clipboard", "sqlQuery"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does not restart when running exact-tool selections satisfy the requested subset", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ enabledTools: ["clipboard", "sqlQuery"] }),
          runningStatus({ enabledTools: ["clipboard", "sqlQuery"] }),
          runningStatus({ enabledTools: ["clipboard", "sqlQuery"] }),
          runningStatus({ enabledTools: ["clipboard"] }),
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { enabledTools: ["clipboard"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("preserves running same-polarity exact-tool selections when adding a requested override", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ disabledTools: ["tapOn"] }),
          runningStatus({ disabledTools: ["tapOn"] }),
          runningStatus({ disabledTools: ["tapOn"] }),
          runningStatus({ disabledTools: ["tapOn", "swipeOn"] }),
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { disabledTools: ["swipeOn"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({
            enabledTools: [],
            disabledTools: ["tapOn", "swipeOn"],
          });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("a requested disable removes the running daemon's opposite enable on restart", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ enabledTools: ["observe"] }),
          runningStatus({ enabledTools: ["observe"] }),
          runningStatus({ enabledTools: ["observe"] }),
          runningStatus({ disabledTools: ["observe"] }),
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { disabledTools: ["observe"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({
            enabledTools: [],
            disabledTools: ["observe"],
          });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("a requested enable removes the running daemon's opposite disable on restart", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ disabledTools: ["clipboard"] }),
          runningStatus({ disabledTools: ["clipboard"] }),
          runningStatus({ disabledTools: ["clipboard"] }),
          runningStatus({ enabledTools: ["clipboard"] }),
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { enabledTools: ["clipboard"] },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({
            disabledTools: [],
            enabledTools: ["clipboard"],
          });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("does NOT restart (no downgrade) when a bare client connects to a configured daemon (issue #3846)", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        // Daemon is running with output-reduction + embedded-SDK flags and a
        // custom readiness budget; the
        // connecting client is bare (no daemonOptions) and must NOT trigger a
        // restart that strips those settings.
        fakeManager.statusResults = [
          runningStatus({
            embeddedSdk: true,
            toolResultsNoStructuredContent: true,
            eventAllMarkers: ["@"],
            runnerReadinessTimeoutMs: 45_000,
          }), // ensureVersionMatches
          runningStatus({
            embeddedSdk: true,
            toolResultsNoStructuredContent: true,
            eventAllMarkers: ["@"],
            runnerReadinessTimeoutMs: 45_000,
          }), // ensureBuildMatches
          runningStatus({
            embeddedSdk: true,
            toolResultsNoStructuredContent: true,
            eventAllMarkers: ["@"],
            runnerReadinessTimeoutMs: 45_000,
          }), // ensureStartupOptionsMatch
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          // Bare client: no daemonOptions at all.
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("restart to gain a requested flag preserves the daemon's other flags (issue #3846)", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        // Daemon already has embeddedSdk; client additionally wants
        // toolResultsNoStructuredContent. The restart must ADD the requested
        // flag while PRESERVING the daemon's existing one, not reset to bare.
        fakeManager.statusResults = [
          runningStatus({ embeddedSdk: true, runnerReadinessTimeoutMs: 45_000 }), // ensureVersionMatches
          runningStatus({ embeddedSdk: true, runnerReadinessTimeoutMs: 45_000 }), // ensureBuildMatches
          runningStatus({ embeddedSdk: true, runnerReadinessTimeoutMs: 45_000 }), // ensureStartupOptionsMatch (deficit)
          runningStatus({
            embeddedSdk: true,
            toolResultsNoStructuredContent: true,
            runnerReadinessTimeoutMs: 45_000,
          }), // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          daemonOptions: { toolResultsNoStructuredContent: true },
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          expect(fakeManager.restartOptions).toEqual({
            embeddedSdk: true,
            toolResultsNoStructuredContent: true,
            runnerReadinessTimeoutMs: 45_000,
          });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("version-mismatch restart preserves the running daemon's flags for a bare client (issue #3846)", async () => {
        const timer = new FakeTimer();
        timer.advanceTime(100_000);
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        const configuredOld = {
          running: true,
          pid: 1234,
          port: 3000,
          socketPath: "/tmp/test.sock",
          version: OLDER_VERSION,
          startedAt: ANCIENT_TIMESTAMP,
          options: { embeddedSdk: true, toolResultsNoStructuredContent: true },
        };
        fakeManager.statusResult = configuredOld;
        fakeManager.statusResults = [
          configuredOld, // ensureVersionMatches (older → restart)
          { ...configuredOld, version: CLIENT_VERSION, startedAt: timer.now() }, // post-restart verify
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          timer,
          clientVersion: CLIENT_VERSION,
          // Bare client: no daemonOptions.
        });

        try {
          await proxy.listTools();
          expect(fakeManager.restartCalled).toBe(true);
          // The bare client must NOT strip the daemon's flags on a version restart.
          expect(fakeManager.restartOptions).toEqual({
            embeddedSdk: true,
            toolResultsNoStructuredContent: true,
          });
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });

      test("throws on embedded SDK mode mismatch when auto-start is disabled", async () => {
        const fakeClient = new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        });
        const fakeManager = new FakeDaemonManager();
        fakeManager.statusResults = [
          runningStatus({ embeddedSdk: false }), // ensureVersionMatches
          runningStatus({ embeddedSdk: false }), // ensureBuildMatches
          runningStatus({ embeddedSdk: false }), // ensureStartupOptionsMatch
        ];
        const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
        const proxy = new DaemonMcpProxy({
          clientFactory: () => fakeClient,
          daemonManager: fakeManager,
          autoStartDaemon: false,
          daemonOptions: { embeddedSdk: true },
        });

        try {
          await expect(proxy.listTools()).rejects.toThrow("startup options differ");
          expect(fakeManager.restartCalled).toBe(false);
          expect(fakeClient.isConnected()).toBe(false);
        } finally {
          isAvailableSpy.mockRestore();
          await proxy.close();
        }
      });
    });

    test("throws error when auto-start is disabled and daemon not running", async () => {
      const fakeClient = new FakeDaemonClient();
      const fakeManager = new FakeDaemonManager();
      fakeManager.statusResult = { running: false };

      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: fakeManager,
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.listTools()).rejects.toThrow("auto-start is disabled");
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("tool operations", () => {
    test("listTools returns tools from daemon", async () => {
      const expectedTools = [
        { name: "tapOn", description: "Tap on element", inputSchema: {} },
        { name: "observe", description: "Observe screen", inputSchema: {} },
      ];
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: expectedTools }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const tools = await proxy.listTools();

        expect(tools).toEqual(expectedTools);
        expect(fakeClient.callDaemonMethodCalls).toContainEqual({
          method: "tools/list",
          params: {},
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("listTools caches results", async () => {
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [{ name: "test" }] }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.listTools();
        await proxy.listTools();
        await proxy.listTools();

        // Should only call daemon once due to caching
        expect(fakeClient.callDaemonMethodCalls.length).toBe(1);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("callTool forwards to daemon", async () => {
      const expectedResult = { content: [{ type: "text", text: "tapped!" }] };
      const fakeClient = new FakeDaemonClient({ toolResult: expectedResult });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const result = await proxy.callTool("tapOn", { text: "Button" });

        expect(result).toEqual(expectedResult);
        expect(fakeClient.callToolCalls).toContainEqual({
          toolName: "tapOn",
          params: { text: "Button" },
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("callTool reconnects and retries once when daemon session is stale", async () => {
      const recoveredResult = { content: [{ type: "text", text: "observed after reconnect" }] };
      const staleClient = new ScriptedDaemonClient({
        toolError: new Error("Session not found"),
      });
      const freshClient = new ScriptedDaemonClient({
        toolResult: recoveredResult,
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const result = await proxy.callTool("observe", { deviceId: "device-1" });

        expect(result).toEqual(recoveredResult);
        expect(staleClient.connectCallCount).toBe(1);
        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.callToolCalls).toEqual([
          { toolName: "observe", params: { deviceId: "device-1" } },
        ]);
        expect(freshClient.connectCallCount).toBe(1);
        expect(freshClient.callToolCalls).toEqual([
          { toolName: "observe", params: { deviceId: "device-1" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("callTool surfaces second session failure after one reconnect retry", async () => {
      const firstClient = new ScriptedDaemonClient({
        toolError: new Error("Session not found"),
      });
      const secondClient = new ScriptedDaemonClient({
        toolError: new Error("Session not found"),
      });
      const clients = [firstClient, secondClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.callTool("observe", {})).rejects.toThrow("Session not found");
        expect(firstClient.closeCallCount).toBe(1);
        expect(firstClient.callToolCalls).toHaveLength(1);
        expect(secondClient.callToolCalls).toHaveLength(1);
        expect(clients).toHaveLength(0);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("callTool does not reconnect for non-session daemon errors", async () => {
      const client = new ScriptedDaemonClient({
        toolError: new Error("Permission denied"),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.callTool("observe", {})).rejects.toThrow("Permission denied");
        expect(client.callToolCalls).toHaveLength(1);
        expect(client.closeCallCount).toBe(0);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("callTool recovery invalidates cached daemon definitions", async () => {
      const staleClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "oldTool", inputSchema: {} }] }],
        ]),
        toolError: new Error("Session not found"),
      });
      const freshClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "newTool", inputSchema: {} }] }],
        ]),
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.listTools()).resolves.toEqual([{ name: "oldTool", inputSchema: {} }]);
        await proxy.callTool("observe", {});
        await expect(proxy.listTools()).resolves.toEqual([{ name: "newTool", inputSchema: {} }]);

        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.callDaemonMethodCalls).toHaveLength(1);
        expect(freshClient.callToolCalls).toHaveLength(1);
        expect(freshClient.callDaemonMethodCalls).toEqual([{ method: "tools/list", params: {} }]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("resource operations", () => {
    test("listResources returns resources from daemon", async () => {
      const expectedResources = [{ uri: "automobile:devices/booted", name: "Booted devices" }];
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["resources/list", { resources: expectedResources }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const resources = await proxy.listResources();

        expect(resources).toEqual(expectedResources);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("readResource forwards a trimmed initial binding to the daemon", async () => {
      const expectedResult = { contents: [{ uri: "automobile:test", text: "data" }] };
      const fakeClient = new FakeDaemonClient({ resourceResult: expectedResult });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        initialSessionUuid: " session-a ",
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const result = await proxy.readResource("automobile:devices/booted");

        expect(result).toEqual(expectedResult);
        expect(fakeClient.readResourceCalls).toContain("automobile:devices/booted");
        expect(fakeClient.readResourceParams).toEqual([{ sessionUuid: "session-a" }]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("readResource reconnects and retries once with its initial session binding", async () => {
      const recoveredResult = { contents: [{ uri: "automobile:devices/booted", text: "[]" }] };
      const staleClient = new ScriptedDaemonClient({
        resourceError: new Error(
          "MCP error -32603: Failed to read resource from daemon: Session not found",
        ),
      });
      const freshClient = new ScriptedDaemonClient({
        resourceResult: recoveredResult,
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const result = await proxy.readResource("automobile:devices/booted");

        expect(result).toEqual(recoveredResult);
        expect(staleClient.connectCallCount).toBe(1);
        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
        expect(staleClient.readResourceParams).toEqual([{ sessionUuid: "session-a" }]);
        expect(freshClient.connectCallCount).toBe(1);
        expect(freshClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
        expect(freshClient.readResourceParams).toEqual([{ sessionUuid: "session-a" }]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("sibling-session recovery after daemon restart (#2737)", () => {
    // A daemon restart (build-mismatch #2733, version-mismatch, env change, or
    // crash recovery) tears down every other connected session's live socket.
    // DaemonClient now types that transport failure as DaemonUnavailableError
    // (see daemonTransportError.test.ts), so the sibling's next forwarded call
    // is recoverable here and reconnects+retries once instead of wedging (#2599).
    // Critically, a *daemon-returned application error* that merely mentions a
    // transport code (e.g. a tool reporting a downstream `connect ECONNREFUSED`)
    // stays an ActionableError and must NOT be retried.

    test("callTool recovers when a sibling's socket dropped (DaemonUnavailableError)", async () => {
      const recoveredResult = { content: [{ type: "text", text: "sibling recovered" }] };
      const staleClient = new ScriptedDaemonClient({
        toolError: new DaemonUnavailableError("Daemon socket connection lost: connection closed"),
      });
      const freshClient = new ScriptedDaemonClient({ toolResult: recoveredResult });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const result = await proxy.callTool("observe", { deviceId: "device-1" });

        expect(result).toEqual(recoveredResult);
        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.callToolCalls).toHaveLength(1);
        expect(freshClient.connectCallCount).toBe(1);
        expect(freshClient.callToolCalls).toEqual([
          { toolName: "observe", params: { deviceId: "device-1" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("replays a successful session binding on later sessionless calls after reconnect", async () => {
      const staleClient = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "bound" }] },
      });
      const originalCallTool = staleClient.callTool.bind(staleClient);
      staleClient.callTool = async (toolName, params) => {
        if (staleClient.callToolCalls.length === 1) {
          const recordedParams = { ...params };
          delete recordedParams.__autoMobileBoundSessionUuid;
          staleClient.callToolCalls.push({ toolName, params: recordedParams });
          throw new DaemonUnavailableError("Daemon socket connection lost: connection closed");
        }
        return await originalCallTool(toolName, params);
      };
      const freshClient = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "recovered" }] },
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        const result = await proxy.callTool("videoRecording", {
          action: "stop",
          deviceId: "device-a",
          recordingId: "recording-a",
        });

        expect(result).toEqual({ content: [{ type: "text", text: "recovered" }] });
        expect(staleClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          {
            toolName: "videoRecording",
            params: {
              action: "stop",
              deviceId: "device-a",
              recordingId: "recording-a",
              sessionUuid: "session-a",
            },
          },
        ]);
        expect(freshClient.callToolCalls).toEqual([
          {
            toolName: "videoRecording",
            params: {
              action: "stop",
              deviceId: "device-a",
              recordingId: "recording-a",
              sessionUuid: "session-a",
            },
          },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("listTools re-seeds an initial session binding on reconnect so discovery stays session-scoped", async () => {
      // listTools forwards to a shared transport. A reconnect mid-listTools would
      // otherwise retry tools/list with empty params against the fresh unseeded
      // transport, returning the full unfiltered tool list instead of the
      // session-scoped one. Binding discovery like callTool re-seeds the retried
      // tools/list so it returns the session-scoped list (issue #4610).
      const staleClient = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "bound" }] },
        daemonMethodErrors: new Map([["tools/list", new Error("Session not found")]]),
      });
      const freshClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "scopedTool", inputSchema: {} }] }],
        ]),
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const tools = await proxy.listTools();

        expect(tools).toEqual([{ name: "scopedTool", inputSchema: {} }]);
        // The stale attempt and the reconnect retry both carry the bound session.
        expect(staleClient.callDaemonMethodCalls).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "session-a" } },
          { method: "tools/list", params: { sessionUuid: "session-a" } },
        ]);
        expect(freshClient.callDaemonMethodCalls).toEqual([
          { method: "daemon/heartbeat", params: { sessionId: "session-a" } },
          { method: "tools/list", params: { sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("does not replay an executePlan session after its successful release", async () => {
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("executePlan", { sessionUuid: "session-a", deviceId: "device-a" });
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(client.callToolCalls).toEqual([
          { toolName: "executePlan", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("preserves the binding when an executePlan rejects (a pre-handler rejection leaves the session live)", async () => {
      // An executePlan can reject BEFORE the handler runs — capability enforcement
      // or schema parsing in src/server/index.ts — in which case
      // DefaultPlanLifecycleManager.afterExecution() never runs and the daemon
      // session stays LIVE. The proxy must NOT forget the binding on rejection, or
      // a later sessionless call after a reconnect would strand that still-live
      // session. The binding is cleared only by the daemon's real session-released
      // signal (see the release-signal tests), never by a bare plan rejection
      // (issue [#4610](https://github.com/kaeawc/auto-mobile/issues/4610)).
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        toolErrorByName: new Map([["executePlan", new Error("plan boom")]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        await expect(proxy.callTool("executePlan", { deviceId: "device-a" })).rejects.toThrow(
          "plan boom",
        );
        await proxy.callTool("observe", { deviceId: "device-a" });

        // The third call is still rewritten to session-a: the binding survived the
        // rejection because nothing proved the session was released.
        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "executePlan", params: { deviceId: "device-a", sessionUuid: "session-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("terminally fences a bound session after the replay backstop elapses", async () => {
      // The daemon's heartbeat/idle cleanup can release an ordinary session while
      // this proxy stays connected. Once the replay window elapses with no
      // activity refreshing the binding, a later device-aware call must fail
      // instead of silently recreating the session
      // (issue [#4610](https://github.com/kaeawc/auto-mobile/issues/4610)).
      const timer = new FakeTimer();
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        // Move the clock without running the keeper to model a dropped heartbeat
        // path where the replay lease is the final safety backstop.
        timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS);
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*expired/i,
        );

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("still replays a bound session before the idle window elapses", async () => {
      const timer = new FakeTimer();
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("allows a learned binding to retarget to a later explicit session", async () => {
      const client = new FakeDaemonClient();
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        await proxy.callTool("observe", { sessionUuid: "session-b", deviceId: "device-b" });
        await proxy.callTool("observe", { deviceId: "device-b" });

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { sessionUuid: "session-b", deviceId: "device-b" } },
          { toolName: "observe", params: { sessionUuid: "session-b", deviceId: "device-b" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("keeps replaying a bound session across continuous implicit activity beyond one TTL", async () => {
      // Continuous implicit (sessionless) calls forward the bound UUID and extend
      // the live daemon session, so the replay lease must refresh off the forwarded
      // args. Otherwise total elapsed time crossing one TTL retires a still-live
      // session, and a later reconnect would seed an unbound transport that treats
      // session-disabled capabilities as enabled
      // (issue [#4610](https://github.com/kaeawc/auto-mobile/issues/4610)).
      const timer = new FakeTimer();
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        // Two implicit calls, each within the TTL, but cumulatively past it. Each
        // forwarded implicit call must renew the lease so the binding survives.
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await proxy.callTool("observe", { deviceId: "device-a" });
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("refreshes the replay lease when an admitted bound call is rejected by the handler", async () => {
      // An implicit sessionless call has the bound UUID injected and reaches the
      // daemon, which refreshes the LIVE session in getOrCreateSession(). The
      // handler then rejects (e.g. a tool failure), so the success-only
      // rememberSessionUuid never runs. Without refreshing the lease in the catch
      // path, crossing one TTL retires the still-live session and a later reconnect
      // would seed an unbound transport (issue [#4610](https://github.com/kaeawc/auto-mobile/issues/4610)).
      const timer = new FakeTimer();
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        toolErrorByName: new Map([["tapOn", new ActionableError("tap failed after admission")]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        // An admitted-then-rejected implicit call within the TTL. It must renew the
        // lease off the injected UUID even though it throws.
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await expect(proxy.callTool("tapOn", { deviceId: "device-a" })).rejects.toThrow(
          "tap failed after admission",
        );
        // Cumulatively past one TTL from the initial bind; only the refreshed lease
        // keeps the binding alive for this final implicit call.
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "tapOn", params: { deviceId: "device-a", sessionUuid: "session-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("successful heartbeats keep the replay lease alive across a failed tool transport", async () => {
      // The failed tool request did not refresh the daemon session, but the
      // independent heartbeat keeper did. The binding therefore remains live
      // across the old replay-TTL boundary (issue #5411).
      const timer = new FakeTimer();
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        toolErrorByName: new Map([
          ["tapOn", new DaemonUnavailableError("Daemon socket connection lost: connection closed")],
        ]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await expect(proxy.callTool("tapOn", { deviceId: "device-a" })).rejects.toBeInstanceOf(
          DaemonUnavailableError,
        );
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await proxy.callTool("observe", { deviceId: "device-a" });

        // The final implicit observe remains bound because heartbeat activity,
        // not the failed tool attempt, refreshed the live session.
        const lastCall = client.callToolCalls[client.callToolCalls.length - 1];
        expect(lastCall).toEqual({
          toolName: "observe",
          params: { deviceId: "device-a", sessionUuid: "session-a" },
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("injects the bound UUID when a later call carries a non-string sessionUuid", async () => {
      // A null/number/object sessionUuid is not an explicit session selection, so
      // the retained binding must still be injected rather than bypassed
      // (issue [#4610](https://github.com/kaeawc/auto-mobile/issues/4610)).
      const client = new ScriptedDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        await proxy.callTool("observe", {
          deviceId: "device-a",
          sessionUuid: null as unknown as string,
        });
        await proxy.callTool("observe", {
          deviceId: "device-a",
          sessionUuid: 42 as unknown as string,
        });

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("readResource recovers when a sibling's socket dropped", async () => {
      const recoveredResult = { contents: [{ uri: "automobile:devices/booted", text: "[]" }] };
      const staleClient = new ScriptedDaemonClient({
        resourceError: new DaemonUnavailableError(
          "Daemon socket connection lost: connection closed",
        ),
      });
      const freshClient = new ScriptedDaemonClient({ resourceResult: recoveredResult });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const result = await proxy.readResource("automobile:devices/booted");

        expect(result).toEqual(recoveredResult);
        expect(staleClient.closeCallCount).toBe(1);
        expect(freshClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("caps sibling recovery at one retry", async () => {
      const firstClient = new ScriptedDaemonClient({
        toolError: new DaemonUnavailableError("Daemon socket connection lost: connection closed"),
      });
      const secondClient = new ScriptedDaemonClient({
        toolError: new DaemonUnavailableError("Daemon socket connection lost: connection closed"),
      });
      const clients = [firstClient, secondClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.callTool("observe", {})).rejects.toBeInstanceOf(DaemonUnavailableError);
        expect(firstClient.closeCallCount).toBe(1);
        expect(firstClient.callToolCalls).toHaveLength(1);
        expect(secondClient.callToolCalls).toHaveLength(1);
        expect(clients).toHaveLength(0);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("does NOT retry a daemon-returned tool error that mentions a transport code", async () => {
      // Regression guard: a tool whose *downstream* connection fails surfaces the
      // raw errno in its message (e.g. EmulatorConsoleClient: sendSms over the
      // emulator console). That ActionableError reaches the proxy as a normal tool
      // failure — retrying it would re-run a non-idempotent action and mask the
      // real cause. It must be surfaced, not classified as a recoverable session.
      const client = new ScriptedDaemonClient({
        toolError: new ActionableError(
          "Emulator console connection to 127.0.0.1:5554 failed: connect ECONNREFUSED 127.0.0.1:5554",
        ),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.callTool("sendSms", {})).rejects.toThrow("ECONNREFUSED");
        expect(client.callToolCalls).toHaveLength(1);
        expect(client.closeCallCount).toBe(0);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("session-released signal (issue #4610)", () => {
    // A real daemon->proxy "session released" push clears the remembered binding
    // the moment the daemon releases the session (heartbeat / idle / plan),
    // instead of waiting out the replay-TTL guess. The TTL stays as a
    // dropped-frame backstop.

    test("a released signal terminally fences an initial binding", async () => {
      const fakeClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        // The initial routing binding scopes calls before any mutable device selection.
        await proxy.listTools();
        await proxy.callTool("observe", { deviceId: "device-a" });
        fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a");
        await expect(proxy.listTools()).rejects.toThrow(/session-a.*(?:expired|released)/i);
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*(?:expired|released)/i,
        );
        await expect(
          proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" }),
        ).rejects.toThrow(/session-a.*(?:expired|released)/i);

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("forwards only the released session's fresh screenshot read", async () => {
      const expectedResult = {
        contents: [
          {
            uri: "automobile:device-session/session-a/screenshot",
            mimeType: "application/json",
            text: JSON.stringify({ code: "SESSION_NOT_ACTIVE" }),
          },
        ],
      };
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        resourceResult: expectedResult,
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.listTools();
        fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a");

        await expect(
          proxy.readResource("automobile:device-session/session-a/screenshot"),
        ).resolves.toEqual(expectedResult);
        await expect(proxy.readResource("automobile:devices/booted")).rejects.toThrow(
          /session-a.*(?:expired|released)/i,
        );
        expect(fakeClient.readResourceParams).toEqual([
          {
            sessionUuid: "session-a",
            __autoMobileReleasedSessionUuid: "session-a",
          },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("preserves the daemon heartbeat snapshot on a terminal binding error", async () => {
      const timer = new FakeTimer();
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.listTools();
        fakeClient.emitNotification(
          SESSION_RELEASED_NOTIFICATION_METHOD,
          "session-a",
          "heartbeat-timeout",
          {
            sessionId: "session-a",
            deviceId: "emulator-5554",
            releaseReason: "heartbeat-timeout",
            releasedAtMs: 20_000,
            terminal: true,
            heartbeat: {
              lastHeartbeatMs: 9_000,
              hasReceivedHeartbeat: true,
              timeoutMs: 10_000,
              ageMs: 11_000,
            },
          },
        );

        const error: any = await proxy.listTools().catch((caught) => caught);
        expect(error.release).toMatchObject({
          deviceId: "emulator-5554",
          releaseReason: "heartbeat-timeout",
          heartbeat: { ageMs: 11_000, timeoutMs: 10_000 },
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a released signal for a different session leaves the binding intact", async () => {
      const fakeClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        // A derived-only release (`${base}:${label}`) or an unrelated session key
        // must NOT clear a base binding matched by exact equality.
        fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a:device-a");
        fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-b");
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    // Issue #4611 (follow-up P1): a release observed WHILE a callTool is in flight
    // must survive the call's completion. The in-flight call's post-call
    // remember/refresh previously re-established the released UUID unconditionally,
    // so the next sessionless call would inject it and recreate the freed session.
    test("a release during a fulfilled in-flight call is not undone by the post-call remember", async () => {
      let callCount = 0;
      const fakeClient: FakeDaemonClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        onCallTool: () => {
          callCount += 1;
          // Fire the release DURING the second (sessionless, bound) call — after the
          // bound UUID was injected into forwardedArgs but before the call resolves.
          if (callCount === 2) {
            fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a");
          }
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        // Call 2 injects session-a, then the release lands mid-flight.
        await proxy.callTool("observe", { deviceId: "device-a" });
        // Call 3 must fail terminally without reaching the daemon.
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*(?:expired|released)/i,
        );

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a release during the first explicit call fences the transport before reuse", async () => {
      const fakeClient: FakeDaemonClient = new FakeDaemonClient({
        onCallTool: () => {
          fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a");
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", {
          sessionUuid: "session-a",
          deviceId: "device-a",
        });
        await expect(
          proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" }),
        ).rejects.toThrow(/session-a.*(?:expired|released)/i);
        expect(fakeClient.callToolCalls).toHaveLength(1);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("does not let a bound connection retarget a different device session", async () => {
      const fakeClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(
          proxy.callTool("observe", { sessionUuid: "session-b", deviceId: "device-b" }),
        ).rejects.toThrow("MCP connection is bound to device session session-a");
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          {
            toolName: "observe",
            params: {
              deviceId: "device-a",
              sessionUuid: "session-a",
            },
          },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a release during an admitted-then-rejected in-flight call is not undone by the refresh", async () => {
      let callCount = 0;
      const fakeClient: FakeDaemonClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        onCallTool: () => {
          callCount += 1;
          if (callCount === 2) {
            // Admitted (recorded + reached the daemon handler), then released
            // mid-flight, then rejected by the handler (non-recoverable error).
            fakeClient.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a");
            throw new Error("handler rejected the admitted call");
          }
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        await expect(proxy.callTool("tapOn", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*(?:expired|released)/i,
        );
        // The admitted-failure refresh must not resurrect the released UUID's lease.
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*(?:expired|released)/i,
        );

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "tapOn", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a pre-dispatch transport failure does not refresh the replay lease", async () => {
      let callCount = 0;
      const transportError = new DeviceControlTransportError(
        "Device-control transport recovery exhausted while handling observe",
        {
          code: "device_control_transport_failure",
          transport: "daemon_loopback_http",
          toolName: "observe",
          sessionUuid: "session-a",
          sessionValid: false,
          deviceSessionValid: false,
          phase: "connect",
          retryable: true,
          reconnectAttempted: true,
          replayAttempted: false,
        },
      );
      const fakeClient = new FakeDaemonClient({
        onCallTool: () => {
          callCount++;
          if (callCount === 1) {
            throw transportError;
          }
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(
          proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" }),
        ).rejects.toBe(transportError);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("an invalid response session does not refresh the replay lease", async () => {
      let callCount = 0;
      const transportError = new DeviceControlTransportError(
        "Device-control transport closed while handling observe",
        {
          code: "device_control_transport_failure",
          transport: "daemon_loopback_http",
          toolName: "observe",
          deviceId: "device-a",
          deviceSessionUuid: "device-epoch-a",
          sessionUuid: "session-a",
          sessionValid: false,
          deviceSessionValid: true,
          phase: "response",
          retryable: false,
          reconnectAttempted: false,
          replayAttempted: false,
        },
      );
      const fakeClient = new FakeDaemonClient({
        onCallTool: () => {
          callCount++;
          if (callCount === 1) {
            throw transportError;
          }
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(
          proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" }),
        ).rejects.toBe(transportError);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a response-phase transport failure still refreshes an admitted replay lease", async () => {
      const timer = new FakeTimer();
      let callCount = 0;
      const responseError = new DeviceControlTransportError(
        "Device-control transport recovery exhausted while handling observe",
        {
          code: "device_control_transport_failure",
          transport: "daemon_loopback_http",
          toolName: "observe",
          deviceId: "device-a",
          deviceSessionUuid: "device-epoch-a",
          sessionUuid: "session-a",
          sessionValid: true,
          deviceSessionValid: true,
          phase: "response",
          retryable: true,
          reconnectAttempted: true,
          replayAttempted: true,
        },
      );
      const fakeClient = new FakeDaemonClient({
        onCallTool: () => {
          callCount++;
          if (callCount === 2) {
            throw responseError;
          }
        },
        onCallDaemonMethod: (method) => {
          if (method === "daemon/heartbeat") {
            throw new Error("heartbeat disabled for lease-refresh isolation");
          }
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
        heartbeatIntervalMs: DAEMON_BOUND_SESSION_REPLAY_TTL_MS * 2,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        await Promise.resolve();
        await Promise.resolve();
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS - 1);
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toBe(
          responseError,
        );
        timer.advanceTime(2);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("with NO release mid-call, the in-flight call still remembers the binding normally", async () => {
      // Positive control: the mid-flight guard must not over-fire. With the
      // onCallTool seam present but emitting nothing, the binding persists and the
      // next sessionless call is still rewritten (issue #4611).
      let observed = 0;
      const fakeClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
        onCallTool: () => {
          observed += 1;
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
        expect(observed).toBe(2);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("the TTL backstop terminally fences the binding when no signal arrives", async () => {
      // Dropped-frame path: no released signal is delivered, so the replay TTL
      // must still fence the binding on its own.
      const timer = new FakeTimer();
      const fakeClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS);
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*expired/i,
        );

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("cached discovery surfaces still enforce the bound-session replay backstop", async () => {
      const discoveryCases = [
        {
          name: "tools/list",
          read: (proxy: DaemonMcpProxy) => proxy.listTools(),
        },
        {
          name: "resources/list",
          read: (proxy: DaemonMcpProxy) => proxy.listResources(),
        },
        {
          name: "resources/list-templates",
          read: (proxy: DaemonMcpProxy) => proxy.listResourceTemplates(),
        },
      ];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      try {
        for (const discoveryCase of discoveryCases) {
          const timer = new FakeTimer();
          const fakeClient = new FakeDaemonClient({
            daemonMethodResults: new Map([
              ["tools/list", { tools: [{ name: "observe", inputSchema: {} }] }],
              ["resources/list", { resources: [{ uri: "automobile:test", name: "test" }] }],
              [
                "resources/list-templates",
                { resourceTemplates: [{ uriTemplate: "test://{id}", name: "test" }] },
              ],
            ]),
          });
          const proxy = new DaemonMcpProxy({
            clientFactory: () => fakeClient,
            daemonManager: matchingDaemonManager(),
            autoStartDaemon: false,
            timer,
          });

          try {
            await proxy.callTool("observe", {
              sessionUuid: "session-a",
              deviceId: "device-a",
            });
            await discoveryCase.read(proxy);
            timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS);

            await expect(discoveryCase.read(proxy)).rejects.toMatchObject({
              sessionUuid: "session-a",
              reason: "replay-lease-expired",
            });
          } finally {
            await proxy.close();
          }
        }
      } finally {
        isAvailableSpy.mockRestore();
      }
    });

    test("does not expire a configured initial binding before its release signal", async () => {
      const timer = new FakeTimer();
      const fakeClient = new FakeDaemonClient();
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        timer,
      });

      try {
        timer.advanceTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS);
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("terminally fences a configured binding after a confirmed missing-session fallback", async () => {
      const firstClient = new ScriptedDaemonClient({
        toolError: new Error("Session not found"),
      });
      const retryClient = new ScriptedDaemonClient({
        toolError: new Error("Session not found"),
      });
      const replacementClient = new FakeDaemonClient();
      const clients: DaemonClientLike[] = [firstClient, retryClient, replacementClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        initialSessionUuid: "session-a",
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow(
          /session-a.*(?:expired|released)/i,
        );
        await expect(
          proxy.callTool("observe", { sessionUuid: "session-b", deviceId: "device-b" }),
        ).rejects.toThrow(/session-a.*(?:expired|released)/i);
        expect(replacementClient.callToolCalls).toEqual([]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a tools/list invalidated mid-flight is not cached; the next listTools refetches (#4655)", async () => {
      // A list_changed (or bound-session release) lands WHILE a session-scoped
      // tools/list is pending. The handler nulls the cache immediately, but the
      // eventual (now-stale) response used to repopulate cachedTools
      // unconditionally, resurrecting the list the invalidation just cleared. The
      // response must NOT be cached, so the next listTools() refetches.
      let methodCallCount = 0;
      const fakeClient: FakeDaemonClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [{ name: "t", inputSchema: {} }] }]]),
        onCallDaemonMethod: (method) => {
          if (method === "tools/list") {
            methodCallCount += 1;
            if (methodCallCount === 1) {
              fakeClient.emitNotification("notifications/tools/list_changed");
            }
          }
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        const first = await proxy.listTools();
        expect(first).toEqual([{ name: "t", inputSchema: {} }]);
        // The mid-flight invalidation prevented caching, so a second call refetches.
        const second = await proxy.listTools();
        expect(second).toEqual([{ name: "t", inputSchema: {} }]);
        expect(fakeClient.callDaemonMethodCalls).toHaveLength(2);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("a tools/list with NO mid-flight invalidation caches normally (positive control, #4655)", async () => {
      // The discovery guard must not over-fire: with no push during the pending
      // call, the response is cached and the second listTools() serves the cache.
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [{ name: "t", inputSchema: {} }] }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.listTools();
        await proxy.listTools();
        expect(fakeClient.callDaemonMethodCalls).toHaveLength(1);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("an unknown pushed method is still logged and ignored", async () => {
      const fakeClient = new FakeDaemonClient({
        toolResult: { content: [{ type: "text", text: "ok" }] },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "session-a", deviceId: "device-a" });
        // A future notification family must not touch the binding.
        expect(() => fakeClient.emitNotification("notifications/some/future_thing")).not.toThrow();
        await proxy.callTool("observe", { deviceId: "device-a" });

        expect(fakeClient.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "session-a", deviceId: "device-a" } },
          { toolName: "observe", params: { deviceId: "device-a", sessionUuid: "session-a" } },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("cache invalidation", () => {
    test("invalidateCache clears all caches", async () => {
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "test" }] }],
          ["resources/list", { resources: [{ uri: "test" }] }],
        ]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        // Populate caches
        await proxy.listTools();
        await proxy.listResources();

        expect(fakeClient.callDaemonMethodCalls.length).toBe(2);

        // Invalidate caches
        proxy.invalidateCache();

        // Should fetch again
        await proxy.listTools();
        await proxy.listResources();

        expect(fakeClient.callDaemonMethodCalls.length).toBe(4);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("build-identity handshake", () => {
    const CLIENT_BUILD = { entryScript: "/client/dist/index.js", buildId: "clientbuild" };
    const DAEMON_BUILD = { entryScript: "/daemon/dist/index.js", buildId: "daemonbuild" };

    function makeBuildProxy(
      opts: {
        // Identity reported by the running daemon before any restart.
        daemonBuildId?: string | null;
        daemonEntryScript?: string | null;
        // Identity reported after a restart (defaults to the client's identity = match).
        restartedBuildId?: string;
        restartedEntryScript?: string;
        startedAt?: number;
        autoStartDaemon?: boolean;
        waitForReadyResult?: boolean;
      } = {},
    ) {
      const timer = new FakeTimer();
      timer.advanceTime(100_000);
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const fakeManager = new FakeDaemonManager();

      const mismatchStatus = {
        running: true,
        pid: 1234,
        port: 3000,
        socketPath: "/tmp/test.sock",
        version: DAEMON_VERSION, // versions match so only the build differs
        startedAt: opts.startedAt ?? ANCIENT_TIMESTAMP,
        ...(opts.daemonBuildId === null
          ? {}
          : { buildId: opts.daemonBuildId ?? DAEMON_BUILD.buildId }),
        ...(opts.daemonEntryScript === null
          ? {}
          : { entryScript: opts.daemonEntryScript ?? DAEMON_BUILD.entryScript }),
      };
      const restartedStatus = {
        ...mismatchStatus,
        buildId: opts.restartedBuildId ?? CLIENT_BUILD.buildId,
        entryScript: opts.restartedEntryScript ?? CLIENT_BUILD.entryScript,
        startedAt: timer.now(),
      };

      // ensureVersionMatches consumes one status() (versions match → returns), then
      // ensureBuildMatches consumes one to detect the mismatch. Both return the
      // mismatch status; the fallback statusResult is the post-restart identity.
      fakeManager.statusResult = restartedStatus;
      fakeManager.statusResults = [mismatchStatus, mismatchStatus];
      if (opts.waitForReadyResult !== undefined) {
        fakeManager.waitForReadyResult = opts.waitForReadyResult;
      }

      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: fakeManager,
        autoStartDaemon: opts.autoStartDaemon ?? true,
        timer,
        buildIdentity: { ...CLIENT_BUILD },
      });
      return { fakeClient, fakeManager, isAvailableSpy, proxy };
    }

    async function expectBuildMismatch(
      promise: Promise<unknown>,
    ): Promise<DaemonBuildMismatchError> {
      try {
        await promise;
      } catch (error) {
        expect(error).toBeInstanceOf(DaemonBuildMismatchError);
        return error as DaemonBuildMismatchError;
      }
      throw new Error("Expected DaemonBuildMismatchError");
    }

    test("restarts daemon and invalidates cache when build differs", async () => {
      const { fakeManager, isAvailableSpy, proxy } = makeBuildProxy();
      const invalidateSpy = spyOn(proxy, "invalidateCache");
      try {
        await proxy.listTools();
        expect(fakeManager.restartCalled).toBe(true);
        expect(invalidateSpy).toHaveBeenCalled();
      } finally {
        invalidateSpy.mockRestore();
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("does not restart when build identity matches", async () => {
      const { fakeManager, isAvailableSpy, proxy } = makeBuildProxy({
        daemonBuildId: CLIENT_BUILD.buildId,
        daemonEntryScript: CLIENT_BUILD.entryScript,
      });
      try {
        await proxy.listTools();
        expect(fakeManager.restartCalled).toBe(false);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("treats a daemon with no build identity as a match (backward compatible)", async () => {
      const { fakeManager, isAvailableSpy, proxy } = makeBuildProxy({
        daemonBuildId: null,
        daemonEntryScript: null,
      });
      try {
        await proxy.listTools();
        expect(fakeManager.restartCalled).toBe(false);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("throws DaemonBuildMismatchError without restarting when auto-start is disabled", async () => {
      const { fakeClient, fakeManager, isAvailableSpy, proxy } = makeBuildProxy({
        autoStartDaemon: false,
      });
      try {
        const error = await expectBuildMismatch(proxy.listTools());
        expect(error.reason).toBe("autoStartDisabled");
        expect(error.daemonBuildId).toBe(DAEMON_BUILD.buildId);
        expect(error.clientBuildId).toBe(CLIENT_BUILD.buildId);
        expect(fakeManager.restartCalled).toBe(false);
        expect(fakeClient.isConnected()).toBe(false);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("throws with cooldown reason when the daemon is too young to replace", async () => {
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      const { fakeManager, isAvailableSpy, proxy } = makeBuildProxy({
        startedAt: 100_000 - Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2),
      });
      try {
        const error = await expectBuildMismatch(proxy.listTools());
        expect(error.reason).toBe("cooldown");
        expect(error.retryAfterMs).toBe(Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2));
        expect(fakeManager.restartCalled).toBe(false);
      } finally {
        warnSpy.mockRestore();
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("throws restartMismatch when restarted daemon build still differs", async () => {
      const { fakeManager, isAvailableSpy, proxy } = makeBuildProxy({
        restartedBuildId: DAEMON_BUILD.buildId,
        restartedEntryScript: DAEMON_BUILD.entryScript,
      });
      try {
        const error = await expectBuildMismatch(proxy.listTools());
        expect(error.reason).toBe("restartMismatch");
        expect(fakeManager.restartCalled).toBe(true);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("throws when restarted daemon fails to become ready", async () => {
      const { fakeManager, isAvailableSpy, proxy } = makeBuildProxy({
        waitForReadyResult: false,
      });
      try {
        await expect(proxy.listTools()).rejects.toThrow(DaemonUnavailableError);
        expect(fakeManager.restartCalled).toBe(true);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("unknown-tool self-heal", () => {
    test("reconnects and retries once when daemon reports an advertised tool as unknown", async () => {
      const recoveredResult = { content: [{ type: "text", text: "set after reconnect" }] };
      const staleClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "setPreference", inputSchema: {} }] }],
        ]),
        toolError: new Error("MCP error -32603: Unknown tool: setPreference"),
      });
      const freshClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "setPreference", inputSchema: {} }] }],
        ]),
        toolResult: recoveredResult,
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        // Prime the cache so we can prove it gets invalidated on recovery.
        await proxy.listTools();
        const result = await proxy.callTool("setPreference", { key: "k", value: "v" });

        expect(result).toEqual(recoveredResult);
        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.callToolCalls).toHaveLength(1);
        expect(freshClient.callToolCalls).toEqual([
          { toolName: "setPreference", params: { key: "k", value: "v" } },
        ]);
        // Recovery invalidated the cache, so a subsequent listTools re-queries the
        // fresh (post-recovery) client instead of returning the stale tool list.
        await proxy.listTools();
        expect(freshClient.callDaemonMethodCalls).toEqual([{ method: "tools/list", params: {} }]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("throws an actionable DaemonToolUnavailableError naming both builds when the tool stays unknown", async () => {
      const firstClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        toolError: new Error("MCP error -32603: Unknown tool: setPreference"),
      });
      const secondClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
        toolError: new Error("MCP error -32603: Unknown tool: setPreference"),
      });
      const clients = [firstClient, secondClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
        buildIdentity: { entryScript: "/client/dist/index.js", buildId: "clientbuild" },
      });

      try {
        let caught: unknown;
        try {
          await proxy.callTool("setPreference", { key: "k" });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(DaemonToolUnavailableError);
        const err = caught as DaemonToolUnavailableError;
        expect(err.toolName).toBe("setPreference");
        expect(err.message).toContain("setPreference");
        expect(err.message).toContain("clientbuild");
        // Capped at one retry: exactly two clients consumed.
        expect(clients).toHaveLength(0);
        expect(firstClient.callToolCalls).toHaveLength(1);
        expect(secondClient.callToolCalls).toHaveLength(1);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("does not retry on a non-recoverable daemon error", async () => {
      const client = new ScriptedDaemonClient({
        toolError: new Error("Permission denied"),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await expect(proxy.callTool("observe", {})).rejects.toThrow("Permission denied");
        expect(client.callToolCalls).toHaveLength(1);
        expect(client.closeCallCount).toBe(0);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("connection tool-selection profiles", () => {
    test("keeps an omitted tool-selection update on the connection profile after device routing binds", async () => {
      const client = new ScriptedDaemonClient({
        toolResult: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionUuid: "profile-a", toolName: "clipboard" }),
            },
          ],
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "device-session-a" });
        await proxy.callTool("setToolEnabled", { toolName: "clipboard" });
        await proxy.callTool("setToolEnabled", { toolName: "executePlan" });

        expect(client.callToolCalls).toEqual([
          { toolName: "observe", params: { sessionUuid: "device-session-a" } },
          { toolName: "setToolEnabled", params: { toolName: "clipboard" } },
          {
            toolName: "setToolEnabled",
            params: {
              toolName: "executePlan",
              [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "profile-a",
            },
          },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("replays a generated profile for discovery and explicit device calls without turning it into a device session", async () => {
      const client = new ScriptedDaemonClient({
        toolResult: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionUuid: "profile-a", toolName: "executePlan" }),
            },
          ],
        },
        daemonMethodResults: new Map([["tools/list", { tools: [{ name: "executePlan" }] }]]),
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("setToolEnabled", { toolName: "executePlan" });
        await proxy.listTools();
        await proxy.callTool("executePlan", { sessionUuid: "device-session-a" });

        expect(client.callToolCalls).toEqual([
          {
            toolName: "setToolEnabled",
            params: { toolName: "executePlan" },
          },
          {
            toolName: "executePlan",
            params: {
              sessionUuid: "device-session-a",
              [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "profile-a",
            },
          },
        ]);
        expect(client.callDaemonMethodCalls).toEqual([
          {
            method: "tools/list",
            params: { [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "profile-a" },
          },
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("does not replace a retained device session when updating an explicit selection profile", async () => {
      const client = new ScriptedDaemonClient({
        toolResult: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionUuid: "profile-a", toolName: "clipboard" }),
            },
          ],
        },
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false,
      });

      try {
        await proxy.callTool("observe", { sessionUuid: "device-session-a" });
        await proxy.callTool("setToolEnabled", { toolName: "clipboard" });
        await proxy.callTool("setToolEnabled", {
          toolName: "clipboard",
          sessionUuid: "profile-a",
        });
        await proxy.callTool("observe", {});

        expect(client.callToolCalls[3]).toEqual({
          toolName: "observe",
          params: {
            sessionUuid: "device-session-a",
            [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "profile-a",
          },
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("DaemonVersionMismatchError restart hint", () => {
    test("strips git build metadata from the bunx restart hint for dev builds", () => {
      const error = new DaemonVersionMismatchError({
        clientVersion: "0.0.39+g1a2b3c4d5e6f.dirty",
        daemonVersion: "0.0.39+gffffffffffff",
        reason: "nonNumeric",
        detail: "version comparison is not numeric",
      });
      // The hint must be npm-installable: build metadata (+...) is not a valid npm tag.
      expect(error.message).toContain("bunx @kaeawc/auto-mobile@0.0.39 --daemon restart");
      expect(error.message).not.toContain("bunx @kaeawc/auto-mobile@0.0.39+g");
      // The displayed client/daemon versions stay fully qualified for diagnostics.
      expect(error.message).toContain("client=0.0.39+g1a2b3c4d5e6f.dirty");
      expect(error.message).toContain("daemon=0.0.39+gffffffffffff");
    });

    test("leaves a plain release version untouched in the restart hint", () => {
      const error = new DaemonVersionMismatchError({
        clientVersion: "0.0.40",
        daemonVersion: "0.0.39",
        reason: "daemonNewer",
        detail: "daemon is newer",
      });
      expect(error.message).toContain("bunx @kaeawc/auto-mobile@0.0.40 --daemon restart");
    });
  });
});
