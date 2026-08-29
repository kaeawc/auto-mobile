import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

// Issue #5879: the proxy MCP server serves tools/list from the static tool
// registry without connecting to the daemon, so a wedged/absent daemon never
// hides the tool surface. The daemon connect/start is deferred to the first
// tool call.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server lazy tools/list", () => {
  test("tools/list returns the full static surface with no daemon available", async () => {
    // isAvailable is NOT stubbed and autoStartDaemon is false: a connection
    // attempt would throw. tools/list must still resolve the whole surface.
    const isAvailableProbe = spyOn(DaemonClient, "isAvailable");
    isAvailableSpy = isAvailableProbe;
    const fakeClient = new FakeDaemonClient();
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fakeClient,
        daemonManager: new FakeDaemonManager(),
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lazy-tools-test-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.listTools();

      const staticNames = getStaticToolDefinitions()
        .map((tool) => tool.name)
        .sort();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(staticNames);
      expect(proxy.isConnected()).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
      expect(isAvailableProbe).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});
