import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { McpOverloadError } from "../../src/daemon/McpTimeoutError";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

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
});
