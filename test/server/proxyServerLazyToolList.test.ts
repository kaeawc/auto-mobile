import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { registerMcpTools } from "../../src/server";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";

// Issue #5879: the proxy MCP server serves tools/list from the static tool
// registry without connecting to the daemon, so a wedged/absent daemon never
// hides the tool surface. The daemon connect/start is deferred to the first
// tool call.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(async () => {
  const availabilitySpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = {
    ...daemonManager.statusResult,
    version: DAEMON_VERSION,
  };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      clientFactory: () => new FakeDaemonClient(),
      daemonManager,
      autoStartDaemon: false,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lazy-tools-warmup-client", version: "0.0.1" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await proxy.callTool("observe", {});
  } finally {
    await client.close();
    await server.close();
    await proxy.close();
    availabilitySpy.mockRestore();
  }
});

beforeEach(() => {
  registerMcpTools(false);
});

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
  ToolRegistry.clearTools();
});

describe("proxy server lazy tools/list", () => {
  test("tools/list returns the selected static surface with no daemon available", async () => {
    // isAvailable is NOT stubbed and autoStartDaemon is false: a connection
    // attempt would throw. tools/list still resolves the selected surface.
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
        .filter((tool) => {
          const declared = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
            (registered) => registered.name === tool.name,
          );
          return declared?.defaultEnabled ?? true;
        })
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

  test("cold proxy discovery omits disabled tools while a direct call by name still forwards", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const fakeClient = new FakeDaemonClient({
      toolResultFor: (toolName) =>
        toolName === "setToolEnabled"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    sessionUuid: "cold-selection-profile",
                    scope: "connection-profile",
                  }),
                },
              ],
            }
          : undefined,
    });
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fakeClient,
        daemonManager: manager,
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
        daemonOptions: { disabledTools: ["listDevices"] },
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "selected-tools-test-client", version: "0.0.1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("listDevices");
      expect(names).not.toContain("provisionDevice");
      expect(names).toContain("observe");
      expect(proxy.isConnected()).toBe(false);

      const result = await client.callTool({ name: "listDevices", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(fakeClient.callToolCalls.some((call) => call.toolName === "listDevices")).toBe(true);
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
      expect(capabilities?.resources).toEqual({ subscribe: true, listChanged: true });
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});
