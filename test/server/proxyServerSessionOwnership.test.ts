import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { appendHeartbeatExpiryMessage } from "../../src/server/deviceSessionResult";
import { SessionManager, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";

import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

describe("appendHeartbeatExpiryMessage", () => {
  const release: SessionReleaseSnapshot = {
    sessionId: "session-123",
    deviceId: "emulator-5554",
    releaseReason: "heartbeat-timeout",
    releasedAtMs: 20_000,
    terminal: true,
    heartbeat: {
      lastHeartbeatMs: 9_000,
      hasReceivedHeartbeat: true,
      timeoutMs: 20_000,
      ageMs: 21_001,
    },
  };

  test.each(["heartbeat-timeout", "missing-first-heartbeat"])(
    "formats the recorded leash and age for %s",
    (releaseReason) => {
      expect(appendHeartbeatExpiryMessage("Ownership lost.", { ...release, releaseReason })).toBe(
        "Ownership lost. No heartbeat for 21001 ms (limit 20000 ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).",
      );
    },
  );

  test("preserves the message without a release snapshot", () => {
    expect(appendHeartbeatExpiryMessage("Ownership lost.")).toBe("Ownership lost.");
  });

  test.each(["device-killed", "rehydration-owner-timeout", "cli-idle-timeout"])(
    "preserves the message for %s despite heartbeat diagnostics",
    (releaseReason) => {
      expect(appendHeartbeatExpiryMessage("Ownership lost.", { ...release, releaseReason })).toBe(
        "Ownership lost.",
      );
    },
  );
});

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server session ownership errors", () => {
  beforeAll(async () => {
    const availabilitySpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        initialSessionUuid: "warmup-session",
        clientFactory: () => new FakeDaemonClient(),
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ownership-warmup-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await proxy.callTool("observe", {});
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
      availabilitySpy.mockRestore();
    }
  });

  test.each(["heartbeat-timeout", "missing-first-heartbeat"])(
    "returns machine-readable %s ownership loss as an error CallToolResult",
    async (releaseReason) => {
      isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const daemonManager = new FakeDaemonManager();
      daemonManager.statusResult = {
        ...daemonManager.statusResult,
        version: DAEMON_VERSION,
      };
      const { server, proxy } = createProxyMcpServer({
        proxyConfig: {
          timer: new FakeTimer(),
          initialSessionUuid: "session-123",
          clientFactory: () => fakeClient,
          daemonManager,
          autoStartDaemon: false,
        },
      });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "ownership-test-client", version: "0.0.1" });

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        await proxy.listTools();
        fakeClient.emitNotification(
          SESSION_RELEASED_NOTIFICATION_METHOD,
          "session-123",
          releaseReason,
          {
            sessionId: "session-123",
            deviceId: "emulator-5554",
            releaseReason,
            releasedAtMs: 20_000,
            terminal: true,
            heartbeat: {
              lastHeartbeatMs: 9_000,
              hasReceivedHeartbeat: releaseReason === "heartbeat-timeout",
              timeoutMs: 10_000,
              ageMs: 11_000,
            },
          },
        );

        const result = await client.callTool({
          name: "observe",
          arguments: { deviceId: "emulator-5554" },
        });

        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "session_ownership_lost",
                  message:
                    `Session ownership lost for session-123: ${releaseReason}. ` +
                    "Call getAndroid or getApple to acquire a new device session. " +
                    "No heartbeat for 11000 ms (limit 10000 ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).",
                  sessionUuid: "session-123",
                  reason: releaseReason,
                  retryable: true,
                  recovery: {
                    action: "acquire_replacement_session",
                    tools: ["getAndroid", "getApple"],
                  },
                  release: {
                    sessionId: "session-123",
                    deviceId: "emulator-5554",
                    releaseReason,
                    releasedAtMs: 20_000,
                    terminal: true,
                    heartbeat: {
                      lastHeartbeatMs: 9_000,
                      hasReceivedHeartbeat: releaseReason === "heartbeat-timeout",
                      timeoutMs: 10_000,
                      ageMs: 11_000,
                    },
                  },
                },
              }),
            },
          ],
          isError: true,
        });
        expect(fakeClient.callToolCalls).toEqual([]);
      } finally {
        await client.close();
        await server.close();
        await proxy.close();
      }
    },
  );

  test("explicit-release regression returns ownership loss from a real release snapshot", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer,
        initialSessionUuid: "released-uuid",
        clientFactory: () => fakeClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "explicit-release-client", version: "0.0.1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await manager.createSession("released-uuid", "handset", "android");
      await manager.releaseSession("released-uuid");
      const release = manager.getTerminalReleaseSnapshot("released-uuid");
      expect(release).toMatchObject({ releaseReason: "explicit-release", terminal: true });
      fakeClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "released-uuid",
        "explicit-release",
        release,
      );
      const result = await client.callTool({
        name: "observe",
        arguments: { sessionUuid: "released-uuid" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "session_ownership_lost",
              message:
                "Session ownership lost for released-uuid: explicit-release. " +
                "Call getAndroid or getApple to acquire a new device session.",
              sessionUuid: "released-uuid",
              reason: "explicit-release",
              retryable: true,
              recovery: {
                action: "acquire_replacement_session",
                tools: ["getAndroid", "getApple"],
              },
              release,
            },
          }),
        },
      ]);
      expect(fakeClient.callToolCalls).toEqual([]);
    } finally {
      manager.stopCleanupTimer();
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("preserves machine-readable ownership loss across discovery errors", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        initialSessionUuid: "session-123",
        clientFactory: () => fakeClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ownership-test-client", version: "0.0.1" });
    const ownershipLoss = /session_ownership_lost.*session-123.*heartbeat-timeout/;

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      fakeClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "session-123",
        "heartbeat-timeout",
      );

      await Promise.all([
        expect(client.listTools()).rejects.toThrow(ownershipLoss),
        expect(client.listResources()).rejects.toThrow(ownershipLoss),
        expect(client.listResourceTemplates()).rejects.toThrow(ownershipLoss),
        expect(client.readResource({ uri: "automobile:devices/booted" })).rejects.toThrow(
          ownershipLoss,
        ),
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("returns iOS device-killed loss and requires an in-band replacement session (#6724)", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const originalClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? {
              content: [{ type: "text", text: JSON.stringify({ sessionId: "shutdown-session" }) }],
            }
          : undefined,
    });
    const replacementClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? {
              content: [
                { type: "text", text: JSON.stringify({ sessionId: "replacement-session" }) },
              ],
            }
          : undefined,
    });
    let clientFactoryCalls = 0;
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => {
          clientFactoryCalls += 1;
          return clientFactoryCalls === 1 ? originalClient : replacementClient;
        },
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shutdown-recovery-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await client.callTool({ name: "getApple", arguments: {} });
      originalClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "shutdown-session",
        "device-killed",
      );

      const loss = await client.callTool({
        name: "observe",
        arguments: { deviceId: "ios-simulator-1" },
      });
      expect(loss).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "no_active_device_session",
                message:
                  "This MCP connection has no active device session " +
                  "(the previous session was released: device-killed). " +
                  "Call getAndroid or getApple to acquire a new device session.",
                reason: "device-killed",
                retryable: true,
                recovery: {
                  action: "acquire_replacement_session",
                  tools: ["getAndroid", "getApple"],
                },
              },
            }),
          },
        ],
      });

      originalClient.emitConnectionClosed();
      await client.callTool({ name: "getApple", arguments: {} });
      await client.callTool({
        name: "observe",
        arguments: {},
      });

      expect(originalClient.callToolCalls).toEqual([{ toolName: "getApple", params: {} }]);
      expect(replacementClient.callToolCalls).toEqual([
        { toolName: "getApple", params: {} },
        {
          toolName: "observe",
          params: { sessionUuid: "replacement-session" },
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("reconnects and reclaims the same iOS session across a daemon-shutdown handoff (#6724)", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const originalClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? {
              content: [{ type: "text", text: JSON.stringify({ sessionId: "shutdown-session" }) }],
            }
          : undefined,
    });
    const replacementClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResult: { content: [{ type: "text", text: "reclaimed" }] },
    });
    let clientFactoryCalls = 0;
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => {
          clientFactoryCalls += 1;
          return clientFactoryCalls === 1 ? originalClient : replacementClient;
        },
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shutdown-recovery-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await client.callTool({ name: "getApple", arguments: {} });
      originalClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "shutdown-session",
        "daemon-shutdown",
      );
      originalClient.emitConnectionClosed();

      const result = await client.callTool({
        name: "observe",
        arguments: {},
      });

      expect(result).toEqual({
        content: [{ type: "text", text: "reclaimed" }],
      });
      expect(originalClient.callToolCalls).toEqual([{ toolName: "getApple", params: {} }]);
      expect(replacementClient.callToolCalls).toEqual([
        {
          toolName: "observe",
          params: { sessionUuid: "shutdown-session" },
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});
