import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpOverloadError } from "../../src/daemon/McpTimeoutError";

// Issue #3223: the proxy MCP server re-emits daemon-forwarded list-changed
// notifications to its own (external) client.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

function createHarness() {
  isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const fakeClient = new FakeDaemonClient({
    daemonMethodResults: new Map<string, any>([["tools/list", { tools: [] }]]),
  });
  const fakeManager = new FakeDaemonManager();
  fakeManager.statusResult = {
    running: true,
    pid: 1234,
    port: 3000,
    socketPath: "/tmp/test.sock",
    version: DAEMON_VERSION,
  };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      clientFactory: () => fakeClient,
      daemonManager: fakeManager,
      autoStartDaemon: false,
    },
  });
  return { server, proxy, fakeClient };
}

describe("createProxyMcpServer list-changed forwarding", () => {
  test("an older tools/list response cannot restore output-schema state after list_changed", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    let holdList = false;
    let releaseList: (() => void) | undefined;
    let listStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const toolName = "stale-schema-tool";
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([
        [
          "tools/list",
          {
            tools: [
              { name: toolName, inputSchema: { type: "object" }, outputSchema: { type: "object" } },
            ],
          },
        ],
      ]),
      onCallDaemonMethod: async (method) => {
        if (method === "tools/list" && holdList) {
          listStarted?.();
          await held;
        }
      },
      onCallTool: () => {
        throw new McpOverloadError("overloaded", {
          code: "daemon_overloaded",
          retryable: true,
          retryAfterMs: 250,
          reason: "insufficient_forward_budget",
          queueWaitMs: 100,
          remainingTimeoutMs: 500,
        });
      },
    });
    const fakeManager = new FakeDaemonManager();
    fakeManager.statusResult = { ...fakeManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fakeClient,
        daemonManager: fakeManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stale-tool-list-client", version: "0.0.1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await client.listTools();
      fakeClient.emitNotification("notifications/tools/list_changed");
      holdList = true;
      const staleList = client.listTools();
      await started;
      fakeClient.emitNotification("notifications/tools/list_changed");
      releaseList?.();
      expect((await staleList).tools.map((tool) => tool.name)).toContain(toolName);
      const result = await client.callTool({ name: toolName, arguments: {} });
      expect(result.isError).toBe(true);
      expect("structuredContent" in result).toBe(false);
    } finally {
      releaseList?.();
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("daemon tools/list_changed is re-emitted as sendToolListChanged", async () => {
    const { server, proxy, fakeClient } = createHarness();
    const sendToolsSpy = spyOn(server, "sendToolListChanged").mockImplementation(() => {});
    const sendResourcesSpy = spyOn(server, "sendResourceListChanged").mockImplementation(() => {});

    await proxy.listTools();
    fakeClient.emitNotification("notifications/tools/list_changed");

    expect(sendToolsSpy).toHaveBeenCalledTimes(1);
    expect(sendResourcesSpy).not.toHaveBeenCalled();
  });

  test("daemon resources/list_changed is re-emitted as sendResourceListChanged", async () => {
    const { server, proxy, fakeClient } = createHarness();
    const sendToolsSpy = spyOn(server, "sendToolListChanged").mockImplementation(() => {});
    const sendResourcesSpy = spyOn(server, "sendResourceListChanged").mockImplementation(() => {});

    await proxy.listTools();
    fakeClient.emitNotification("notifications/resources/list_changed");

    expect(sendResourcesSpy).toHaveBeenCalledTimes(1);
    expect(sendToolsSpy).not.toHaveBeenCalled();
  });

  test("a throwing send is swallowed (dead transport never breaks the proxy)", async () => {
    const { server, proxy, fakeClient } = createHarness();
    spyOn(server, "sendToolListChanged").mockImplementation(() => {
      throw new Error("transport torn down");
    });

    await proxy.listTools();

    expect(() => fakeClient.emitNotification("notifications/tools/list_changed")).not.toThrow();
  });

  test("without a connected transport the real send helpers are safe no-ops", async () => {
    const { proxy, fakeClient } = createHarness();

    await proxy.listTools();

    // No transport is connected in this test, so the SDK's isConnected() guard
    // makes the un-mocked send helpers no-ops — the emit must not throw.
    expect(() => fakeClient.emitNotification("notifications/tools/list_changed")).not.toThrow();
  });
});
