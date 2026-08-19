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
              code: "session_ownership_lost",
              sessionUuid: "session-123",
              reason: "heartbeat-timeout",
            }),
          },
        ],
        isError: true,
      });
      expect(fakeClient.callToolCalls).toEqual([]);
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});
