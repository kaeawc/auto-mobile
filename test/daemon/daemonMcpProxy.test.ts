import { describe, expect, test, spyOn } from "bun:test";
import {
  DaemonMcpProxy,
  DaemonVersionMismatchError,
  DaemonBuildMismatchError,
  DaemonToolUnavailableError,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonUnavailableError, type DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION, DAEMON_VERSION_RESTART_COOLDOWN_MS } from "../../src/daemon/constants";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";

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
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  connectCallCount = 0;
  closeCallCount = 0;

  constructor(
    private readonly behavior: {
      toolResult?: any;
      toolError?: Error;
      resourceResult?: any;
      resourceError?: Error;
      daemonMethodResults?: Map<string, any>;
      daemonMethodError?: Error;
    }
  ) {}

  async connect(): Promise<void> {
    this.connectCallCount++;
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    this.callToolCalls.push({ toolName, params });
    if (this.behavior.toolError) {
      throw this.behavior.toolError;
    }
    return this.behavior.toolResult ?? { content: [{ type: "text", text: "success" }] };
  }

  async readResource(uri: string): Promise<any> {
    this.readResourceCalls.push(uri);
    if (this.behavior.resourceError) {
      throw this.behavior.resourceError;
    }
    return this.behavior.resourceResult ?? { contents: [{ uri, text: "success" }] };
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    this.callDaemonMethodCalls.push({ method, params });
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
          ["tools/list", { tools: [{ name: "testTool", inputSchema: {} }] }]
        ])
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
        autoStartDaemon: false
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

    test("auto-starts daemon when not running", async () => {
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [] }]
        ])
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
        autoStartDaemon: true
      });

      try {
        await proxy.listTools();

        expect(fakeManager.startCalled).toBe(true);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    describe("version-mismatch handling", () => {
      function makeProxy(opts: {
        runningVersion?: string;
        startedAt?: number;
        autoStartDaemon?: boolean;
        waitForReadyResult?: boolean;
        daemonOptions?: { debug?: boolean; port?: number };
        statusAfterRestartVersion?: string;
        clientVersion?: string;
      } = {}) {
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
        };
        fakeManager.statusResult = initialStatus;
        fakeManager.statusResults = [
          initialStatus,
          {
            ...initialStatus,
            version: opts.statusAfterRestartVersion ?? CLIENT_VERSION,
            startedAt: timer.now(),
          },
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
        });
        return { fakeClient, fakeManager, isAvailableSpy, proxy };
      }

      async function expectVersionMismatch(promise: Promise<unknown>): Promise<DaemonVersionMismatchError> {
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
          await expect(proxy.listTools()).rejects.toThrow("daemon restart completed but version still differs");
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
      function runningStatus(options: { embeddedSdk?: boolean }) {
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
        autoStartDaemon: false
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
        { name: "observe", description: "Observe screen", inputSchema: {} }
      ];
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: expectedTools }]
        ])
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
      });

      try {
        const tools = await proxy.listTools();

        expect(tools).toEqual(expectedTools);
        expect(fakeClient.callDaemonMethodCalls).toContainEqual({
          method: "tools/list",
          params: {}
        });
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("listTools caches results", async () => {
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "test" }] }]
        ])
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
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
        autoStartDaemon: false
      });

      try {
        const result = await proxy.callTool("tapOn", { text: "Button" });

        expect(result).toEqual(expectedResult);
        expect(fakeClient.callToolCalls).toContainEqual({
          toolName: "tapOn",
          params: { text: "Button" }
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
        autoStartDaemon: false
      });

      try {
        const result = await proxy.callTool("observe", { deviceId: "device-1" });

        expect(result).toEqual(recoveredResult);
        expect(staleClient.connectCallCount).toBe(1);
        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.callToolCalls).toEqual([
          { toolName: "observe", params: { deviceId: "device-1" } }
        ]);
        expect(freshClient.connectCallCount).toBe(1);
        expect(freshClient.callToolCalls).toEqual([
          { toolName: "observe", params: { deviceId: "device-1" } }
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
        autoStartDaemon: false
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
        autoStartDaemon: false
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
          ["tools/list", { tools: [{ name: "oldTool", inputSchema: {} }] }]
        ]),
        toolError: new Error("Session not found"),
      });
      const freshClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: "newTool", inputSchema: {} }] }]
        ]),
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
      });

      try {
        await expect(proxy.listTools()).resolves.toEqual([{ name: "oldTool", inputSchema: {} }]);
        await proxy.callTool("observe", {});
        await expect(proxy.listTools()).resolves.toEqual([{ name: "newTool", inputSchema: {} }]);

        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.callDaemonMethodCalls).toHaveLength(1);
        expect(freshClient.callToolCalls).toHaveLength(1);
        expect(freshClient.callDaemonMethodCalls).toEqual([
          { method: "tools/list", params: {} }
        ]);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });
  });

  describe("resource operations", () => {
    test("listResources returns resources from daemon", async () => {
      const expectedResources = [
        { uri: "automobile:devices/booted", name: "Booted devices" }
      ];
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["resources/list", { resources: expectedResources }]
        ])
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
      });

      try {
        const resources = await proxy.listResources();

        expect(resources).toEqual(expectedResources);
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("readResource forwards to daemon", async () => {
      const expectedResult = { contents: [{ uri: "automobile:test", text: "data" }] };
      const fakeClient = new FakeDaemonClient({ resourceResult: expectedResult });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
      });

      try {
        const result = await proxy.readResource("automobile:devices/booted");

        expect(result).toEqual(expectedResult);
        expect(fakeClient.readResourceCalls).toContain("automobile:devices/booted");
      } finally {
        isAvailableSpy.mockRestore();
        await proxy.close();
      }
    });

    test("readResource reconnects and retries once when daemon session is stale", async () => {
      const recoveredResult = { contents: [{ uri: "automobile:devices/booted", text: "[]" }] };
      const staleClient = new ScriptedDaemonClient({
        resourceError: new Error("MCP error -32603: Failed to read resource from daemon: Session not found"),
      });
      const freshClient = new ScriptedDaemonClient({
        resourceResult: recoveredResult,
      });
      const clients = [staleClient, freshClient];
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => clients.shift()!,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
      });

      try {
        const result = await proxy.readResource("automobile:devices/booted");

        expect(result).toEqual(recoveredResult);
        expect(staleClient.connectCallCount).toBe(1);
        expect(staleClient.closeCallCount).toBe(1);
        expect(staleClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
        expect(freshClient.connectCallCount).toBe(1);
        expect(freshClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
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
          ["resources/list", { resources: [{ uri: "test" }] }]
        ])
      });
      const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);

      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        autoStartDaemon: false
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

    function makeBuildProxy(opts: {
      // Identity reported by the running daemon before any restart.
      daemonBuildId?: string | null;
      daemonEntryScript?: string | null;
      // Identity reported after a restart (defaults to the client's identity = match).
      restartedBuildId?: string;
      restartedEntryScript?: string;
      startedAt?: number;
      autoStartDaemon?: boolean;
      waitForReadyResult?: boolean;
    } = {}) {
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
        ...(opts.daemonBuildId === null ? {} : { buildId: opts.daemonBuildId ?? DAEMON_BUILD.buildId }),
        ...(opts.daemonEntryScript === null ? {} : { entryScript: opts.daemonEntryScript ?? DAEMON_BUILD.entryScript }),
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

    async function expectBuildMismatch(promise: Promise<unknown>): Promise<DaemonBuildMismatchError> {
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
        daemonMethodResults: new Map([["tools/list", { tools: [{ name: "setPreference", inputSchema: {} }] }]]),
        toolError: new Error("MCP error -32603: Unknown tool: setPreference"),
      });
      const freshClient = new ScriptedDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [{ name: "setPreference", inputSchema: {} }] }]]),
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
