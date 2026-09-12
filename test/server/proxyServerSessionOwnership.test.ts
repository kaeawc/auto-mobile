import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server session ownership errors", () => {
  test("returns machine-readable ownership loss as an error CallToolResult", async () => {
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
        "heartbeat-timeout",
        {
          sessionId: "session-123",
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
                  "Session ownership lost for session-123: heartbeat-timeout. " +
                  "Call getAndroid or getApple to acquire a new device session.",
                sessionUuid: "session-123",
                reason: "heartbeat-timeout",
                retryable: true,
                recovery: {
                  action: "acquire_replacement_session",
                  tools: ["getAndroid", "getApple"],
                },
                release: {
                  sessionId: "session-123",
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

  test("returns iOS daemon-shutdown loss and requires an in-band replacement session (#6724)", async () => {
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
                  "(the previous session was released: daemon-shutdown). " +
                  "Call getAndroid or getApple to acquire a new device session.",
                reason: "daemon-shutdown",
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
});
