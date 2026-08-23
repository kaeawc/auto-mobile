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
                message: "Session ownership lost for session-123: heartbeat-timeout",
                sessionUuid: "session-123",
                reason: "heartbeat-timeout",
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

      await expect(client.listTools()).rejects.toThrow(ownershipLoss);
      await expect(client.listResources()).rejects.toThrow(ownershipLoss);
      await expect(client.listResourceTemplates()).rejects.toThrow(ownershipLoss);
      await expect(
        client.readResource({ uri: "automobile:devices/booted" }),
      ).rejects.toThrow(ownershipLoss);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});
