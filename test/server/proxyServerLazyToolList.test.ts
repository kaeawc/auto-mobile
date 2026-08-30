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

  test("resources/list returns an immediate empty roster without blocking (daemon absent)", async () => {
    // With no daemon available and auto-start disabled, the background connect
    // kicked off by cold resource discovery fails silently; the client still gets
    // an immediate empty roster rather than a blocked/errored request.
    const isAvailableProbe = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);
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
    const client = new Client({ name: "lazy-resources-test-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const resources = await client.listResources();
      const templates = await client.listResourceTemplates();

      expect(resources.resources).toEqual([]);
      expect(templates.resourceTemplates).toEqual([]);
      // Auto-start is disabled and the daemon is absent, so the best-effort
      // background connect cannot establish a connection.
      expect(proxy.isConnected()).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
    } finally {
      await client.close();
      await proxy.close();
    }
  });

  test("advertises tools.listChanged so clients honor the reconciliation notification", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable");
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => new FakeDaemonClient(),
        daemonManager: new FakeDaemonManager(),
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cap-test-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const capabilities = client.getServerCapabilities();
      expect(capabilities?.tools).toEqual({ listChanged: true });
      expect(capabilities?.resources).toEqual({ listChanged: true });
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});
