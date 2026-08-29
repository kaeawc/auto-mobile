import { describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import type { ListChangedKind } from "../../src/server/listChangedBroadcast";

// A FakeDaemonManager reporting a running daemon whose version matches this
// client's stamped DAEMON_VERSION, so the version gate does not fire when a
// lazy tool call actually connects.
function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

describe("DaemonMcpProxy.listAdvertisedTools (lazy tools/list — issue #5879)", () => {
  test("serves the full static tool surface without connecting to the daemon", async () => {
    // No isAvailable spy and autoStartDaemon:false: any connection attempt would
    // throw "Daemon is not running and auto-start is disabled". A wedged/absent
    // daemon must NOT hide the tool surface (AC1/AC3).
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable");
    const fakeClient = new FakeDaemonClient();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: new FakeDaemonManager(),
      autoStartDaemon: false,
    });

    try {
      const tools = await proxy.listAdvertisedTools();

      const staticNames = getStaticToolDefinitions().map((tool) => tool.name);
      expect(tools.map((tool) => tool.name).sort()).toEqual([...staticNames].sort());
      // Includes daemon/plan-only tools the proxy process never registers itself.
      expect(tools.map((tool) => tool.name)).toContain("barrier");
      expect(tools.map((tool) => tool.name)).toContain("criticalSection");
      // Never connected, never even probed the socket.
      expect(proxy.isConnected()).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
      expect(isAvailableSpy).not.toHaveBeenCalled();
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("every advertised tool carries a name and an input schema", async () => {
    const proxy = new DaemonMcpProxy({ autoStartDaemon: false });
    try {
      const tools = await proxy.listAdvertisedTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe("object");
      }
    } finally {
      await proxy.close();
    }
  });

  test("the FIRST tool call — not tools/list — connects to the daemon (AC2)", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([
        ["tools/list", { tools: [{ name: "liveTool", inputSchema: {} }] }],
      ]),
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
    });

    try {
      await proxy.listAdvertisedTools();
      expect(proxy.isConnected()).toBe(false);
      expect(fakeClient.callToolCalls).toHaveLength(0);

      await proxy.callTool("observe", {});
      expect(proxy.isConnected()).toBe(true);
      expect(fakeClient.callToolCalls.map((call) => call.toolName)).toContain("observe");
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("once connected, serves the live daemon tool list, not the static surface (AC4)", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([
        ["tools/list", { tools: [{ name: "liveOnlyTool", inputSchema: {} }] }],
      ]),
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
    });

    try {
      // Force a connection via a tool call.
      await proxy.callTool("observe", {});
      expect(proxy.isConnected()).toBe(true);

      const tools = await proxy.listAdvertisedTools();
      expect(tools.map((tool) => tool.name)).toEqual(["liveOnlyTool"]);
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("prompts a tools/list re-fetch once the deferred connection is established (AC5)", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
    });
    const kinds: ListChangedKind[] = [];
    proxy.onListChanged((kind) => kinds.push(kind));

    try {
      // Serve static first (no connection), then connect via a tool call.
      await proxy.listAdvertisedTools();
      expect(kinds).toEqual([]);

      await proxy.callTool("observe", {});
      expect(kinds).toContain("tools");
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("does not emit a reconciliation tools/list_changed when no static list was served", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
    });
    const kinds: ListChangedKind[] = [];
    proxy.onListChanged((kind) => kinds.push(kind));

    try {
      // Connect directly, without ever serving the static advertisement.
      await proxy.callTool("observe", {});
      expect(kinds).not.toContain("tools");
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("derives outputSchema suppression from daemon options, not serverConfig (AC #5879 review)", async () => {
    // The default provider must drop outputSchema when the daemon the proxy will
    // connect to runs with toolResultsNoStructuredContent — read from the proxy's
    // daemonOptions, since proxy-mode startup never sets this on serverConfig.
    const suppressed = new DaemonMcpProxy({
      autoStartDaemon: false,
      daemonOptions: { toolResultsNoStructuredContent: true },
    });
    const advertised = new DaemonMcpProxy({
      autoStartDaemon: false,
      daemonOptions: { toolResultsNoStructuredContent: false },
    });
    try {
      const suppressedTools = await suppressed.listAdvertisedTools();
      const advertisedTools = await advertised.listAdvertisedTools();
      expect(suppressedTools.some((tool) => tool.outputSchema !== undefined)).toBe(false);
      expect(advertisedTools.some((tool) => tool.outputSchema !== undefined)).toBe(true);
    } finally {
      await suppressed.close();
      await advertised.close();
    }
  });

  test("honors an injected static tool definitions provider", async () => {
    const proxy = new DaemonMcpProxy({
      autoStartDaemon: false,
      staticToolDefinitionsProvider: () => [
        { name: "injectedTool", description: "d", inputSchema: { type: "object" } },
      ],
    });
    try {
      const tools = await proxy.listAdvertisedTools();
      expect(tools).toEqual([
        { name: "injectedTool", description: "d", inputSchema: { type: "object" } },
      ]);
    } finally {
      await proxy.close();
    }
  });
});
