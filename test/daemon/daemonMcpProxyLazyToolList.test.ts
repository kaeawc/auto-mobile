import { describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
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

  test.each(["android", "ios"] as const)(
    "once connected, advertises only the filtered %s tool list (AC4)",
    async (platform) => {
      const liveToolName = `${platform}LiveTool`;
      const tapOnSchema = {
        type: "object",
        properties: { platform: { const: platform } },
      };
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: liveToolName, inputSchema: {} }] }],
        ]),
      });
      const proxy = new DaemonMcpProxy({
        clientFactory: () => fakeClient,
        daemonManager: matchingDaemonManager(),
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
        staticToolDefinitionsProvider: () => [{ name: "tapOn", inputSchema: tapOnSchema }],
      });

      try {
        // Force a connection via a tool call.
        await proxy.callTool("observe", {});
        expect(proxy.isConnected()).toBe(true);

        const tools = await proxy.listAdvertisedTools();
        expect(tools).toEqual([{ name: liveToolName, inputSchema: {} }]);
        expect(tools.map((tool) => tool.name)).not.toContain("tapOn");
      } finally {
        await proxy.close();
      }
    },
  );

  test("connected fallback retains tapOn without re-advertising plan-only tools", async () => {
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    });

    try {
      await proxy.callTool("observe", {});
      const toolNames = (await proxy.listAdvertisedTools()).map((tool) => tool.name);

      expect(toolNames).toContain("tapOn");
      expect(toolNames).not.toContain("barrier");
      expect(toolNames).not.toContain("criticalSection");
      expect(toolNames).not.toContain("debugSearch");
      expect(toolNames).not.toContain("sqlQuery");
    } finally {
      await proxy.close();
    }
  });

  test("connected fallback retains launch-gated schemas only when the daemon enabled them", async () => {
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const daemonManager = matchingDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      options: { debug: true, embeddedSdk: true },
    };
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    });

    try {
      await proxy.callTool("observe", {});
      const toolNames = (await proxy.listAdvertisedTools()).map((tool) => tool.name);

      expect(toolNames).toContain("debugSearch");
      expect(toolNames).toContain("sqlQuery");
    } finally {
      await proxy.close();
    }
  });

  test("connected fallback retains debug schemas when only effective debug is enabled", async () => {
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const daemonManager = matchingDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      effectiveDebug: true,
      options: { debug: false },
    };
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    });

    try {
      await proxy.callTool("observe", {});
      const toolNames = (await proxy.listAdvertisedTools()).map((tool) => tool.name);

      expect(toolNames).toContain("debugSearch");
      expect(
        fakeClient.callDaemonMethodCalls.filter((call) => call.method === "ide/status"),
      ).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  test("connected fallback omits debug schemas when effective debug is disabled", async () => {
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const daemonManager = matchingDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      effectiveDebug: false,
      options: { debug: true },
    };
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    });

    try {
      await proxy.callTool("observe", {});
      const toolNames = (await proxy.listAdvertisedTools()).map((tool) => tool.name);

      expect(toolNames).not.toContain("debugSearch");
      expect(
        fakeClient.callDaemonMethodCalls.filter((call) => call.method === "ide/status"),
      ).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  test("serves connected static schemas when the live tools list fails", async () => {
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      staticToolDefinitionsProvider: () => [{ name: "tapOn", inputSchema: { type: "object" } }],
    });

    try {
      await proxy.callTool("observe", {});
      await expect(proxy.listAdvertisedTools()).resolves.toEqual([
        { name: "tapOn", inputSchema: { type: "object" } },
      ]);
    } finally {
      await proxy.close();
    }
  });

  test("reconciles a connected static fallback and emits one tools list_changed", async () => {
    const fakeTimer = new FakeTimer();
    let liveListFails = true;
    const liveTool = {
      name: "liveOnlyTool",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    };
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [liveTool] }]]),
      onCallDaemonMethod: (method) => {
        if (method === "tools/list" && liveListFails) {
          throw new Error("wedged live list");
        }
      },
    });
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      timer: fakeTimer,
      staticToolDefinitionsProvider: () => [{ name: "tapOn", inputSchema: { type: "object" } }],
    });
    const kinds: ListChangedKind[] = [];
    proxy.onListChanged((kind) => kinds.push(kind));

    try {
      await proxy.callTool("observe", {});
      await expect(proxy.listAdvertisedTools()).resolves.toEqual([
        { name: "tapOn", inputSchema: { type: "object" } },
      ]);
      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);
      expect(kinds).toEqual([]);

      liveListFails = false;
      await fakeTimer.advanceTimeAsync(250);
      expect(kinds).toEqual(["tools"]);

      const tools = await proxy.listAdvertisedTools();
      expect(tools).toEqual([liveTool]);
      expect(kinds).toEqual(["tools"]);
    } finally {
      await proxy.close();
    }
  });

  test("bounds connected static fallback reconciliation retries", async () => {
    const fakeTimer = new FakeTimer();
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      timer: fakeTimer,
      staticToolDefinitionsProvider: () => [{ name: "tapOn", inputSchema: {} }],
    });
    const kinds: ListChangedKind[] = [];
    proxy.onListChanged((kind) => kinds.push(kind));

    try {
      await proxy.callTool("observe", {});
      await proxy.listAdvertisedTools();
      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);

      await fakeTimer.advanceTimeAsync(250);
      expect(fakeTimer.getPendingTimeouts()).toEqual([1_000]);
      await fakeTimer.advanceTimeAsync(1_000);
      expect(fakeTimer.getPendingTimeouts()).toEqual([4_000]);
      await fakeTimer.advanceTimeAsync(4_000);

      expect(fakeTimer.getPendingTimeouts()).toEqual([]);
      expect(
        fakeClient.callDaemonMethodCalls.filter((call) => call.method === "tools/list"),
      ).toHaveLength(4);
      expect(kinds).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  test("close cancels pending connected static fallback reconciliation", async () => {
    const fakeTimer = new FakeTimer();
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "tools/list") {
          throw new Error("wedged live list");
        }
      },
    });
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      timer: fakeTimer,
      staticToolDefinitionsProvider: () => [{ name: "tapOn", inputSchema: {} }],
    });
    const kinds: ListChangedKind[] = [];
    proxy.onListChanged((kind) => kinds.push(kind));

    await proxy.callTool("observe", {});
    await proxy.listAdvertisedTools();
    expect(fakeTimer.getPendingTimeouts()).toEqual([250]);

    await proxy.close();
    await fakeTimer.advanceTimeAsync(10_000);

    expect(
      fakeClient.callDaemonMethodCalls.filter((call) => call.method === "tools/list"),
    ).toHaveLength(1);
    expect(kinds).toEqual([]);
  });

  test("returns malformed live-only definitions as supplied by the daemon", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([
        [
          "tools/list",
          {
            tools: [
              { name: "liveOnly", description: "first", inputSchema: {} },
              { name: "liveOnly", description: "last", inputSchema: {} },
            ],
          },
        ],
      ]),
    });
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      staticToolDefinitionsProvider: () => [],
    });

    try {
      await proxy.callTool("observe", {});
      const tools = await proxy.listAdvertisedTools();

      expect(tools).toEqual([
        { name: "liveOnly", description: "first", inputSchema: {} },
        { name: "liveOnly", description: "last", inputSchema: {} },
      ]);
    } finally {
      await proxy.close();
    }
  });

  test("serves the static surface after an idle daemon connection closes", async () => {
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
      staticToolDefinitionsProvider: () => [
        { name: "staticTool", inputSchema: { type: "object" } },
      ],
    });

    try {
      await proxy.callTool("observe", {});
      expect(proxy.isConnected()).toBe(true);

      // A passive EOF while idle must invalidate the proxy's stale connected state.
      fakeClient.emitConnectionClosed();
      expect(proxy.isConnected()).toBe(false);
      expect(await proxy.listAdvertisedTools()).toEqual([
        { name: "staticTool", inputSchema: { type: "object" } },
      ]);
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

  test("never advertises outputSchema cold (reconciliation delivers it post-connect)", async () => {
    const proxy = new DaemonMcpProxy({ autoStartDaemon: false });
    try {
      const tools = await proxy.listAdvertisedTools();
      expect(tools.some((tool) => tool.outputSchema !== undefined)).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("serves an empty resource roster immediately, then reconciles for a resource-only client (AC #5879 review)", async () => {
    // A resource-only client never calls a tool, so the reconciliation must be
    // driven by a non-blocking background connect kicked off from cold resource
    // discovery — not by a tool call.
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map<string, any>([
        ["tools/list", { tools: [] }],
        ["resources/list", { resources: [{ uri: "automobile:live", name: "live" }] }],
        ["resources/list-templates", { resourceTemplates: [] }],
      ]),
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
      // Cold discovery returns an empty roster immediately (non-blocking).
      expect(await proxy.listAdvertisedResources()).toEqual([]);
      expect(await proxy.listAdvertisedResourceTemplates()).toEqual([]);

      // A background connect was kicked off — WITHOUT any tool call. Await it to
      // settle (ensureConnected returns the in-flight connecting promise).
      await proxy.ensureConnected();
      expect(proxy.isConnected()).toBe(true);
      expect(kinds).toContain("resources");
      expect(fakeClient.callToolCalls).toHaveLength(0);

      // Once connected, the live resource roster is served.
      const resources = await proxy.listAdvertisedResources();
      expect(resources.map((resource) => resource.uri)).toEqual(["automobile:live"]);
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
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

  test("retries a transient background resource connection failure", async () => {
    const fakeTimer = new FakeTimer();
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map<string, any>([
        ["resources/list", { resources: [{ uri: "automobile:live", name: "live" }] }],
      ]),
    });
    fakeClient.shouldFailConnect = true;
    let connectAttempts = 0;
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        connectAttempts += 1;
        if (connectAttempts === 3) {
          fakeClient.shouldFailConnect = false;
        }
        return fakeClient;
      },
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer: fakeTimer,
    });
    const kinds: ListChangedKind[] = [];
    proxy.onListChanged((kind) => kinds.push(kind));

    try {
      await proxy.listAdvertisedResources();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(connectAttempts).toBe(1);
      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);

      await fakeTimer.advanceTimeAsync(250);
      expect(connectAttempts).toBe(2);
      expect(fakeTimer.getPendingTimeouts()).toEqual([1_000]);

      await fakeTimer.advanceTimeAsync(1_000);
      expect(connectAttempts).toBe(3);
      expect(proxy.isConnected()).toBe(true);
      expect(kinds).toContain("resources");
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  test("cancels pending background resource retries when closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeClient = new FakeDaemonClient();
    fakeClient.shouldFailConnect = true;
    let connectAttempts = 0;
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        connectAttempts += 1;
        return fakeClient;
      },
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer: fakeTimer,
    });

    try {
      await proxy.listAdvertisedResources();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fakeTimer.getPendingTimeouts()).toEqual([250]);

      await proxy.close();
      await fakeTimer.advanceTimeAsync(10_000);
      expect(connectAttempts).toBe(1);
    } finally {
      isAvailableSpy.mockRestore();
    }
  });
});
