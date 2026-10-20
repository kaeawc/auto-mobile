import { makeSessionManager } from "../helpers/sessionManagerSuite";
import { unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { z } from "zod/v4";
import type { ListToolsResult } from "@modelcontextprotocol/client";
import { createListSessionTools } from "../../src/server/pipeline/ingress/listSessionTools";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { ListChangedBroadcaster } from "../../src/daemon/listChangedBroadcast";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import type {
  McpForwardContext,
  McpForwardRoute,
} from "../../src/daemon/socketServerParts/socketServerContracts";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { InMemoryToolSelectionProfileRegistry } from "../../src/daemon/InMemoryToolSelectionProfileRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { StubMcpClient } from "./helpers/fakeMcpClient";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";

function harness(options: { resourceRefresh?: boolean } = {}) {
  const timer = new FakeTimer();
  const server = createHarnessServer("unused", undefined, timer, null, {
    enforce: false,
    mcpDispatcher:
      options.resourceRefresh === false
        ? unreachableMcpDispatcher
        : {
            ...unreachableMcpDispatcher,
            refreshResources: () => ResourceRegistry.refreshBeforeList(),
          },
  });
  let trips = 0;
  let name = "first";
  let failure = false;
  let duringList: (() => void) | undefined;
  server.mcpClientFactory = async (session, profile) => {
    trips++;
    return new StubMcpClient({
      listTools: async () => {
        if (failure) {
          throw new Error("list failed");
        }
        const result = {
          tools: [
            {
              name: `${name}:${session ?? "none"}:${profile ?? "none"}`,
              inputSchema: { type: "object" as const },
            },
          ],
        };
        duringList?.();
        return result;
      },
      listResources: async () => {
        await ResourceRegistry.refreshBeforeList();
        return { resources: ResourceRegistry.getResourceDefinitions() };
      },
    });
  };
  const route: McpForwardRoute = { clientKey: "shared", executionKey: "method:tools/list" };
  const context = (overrides: Partial<McpForwardContext> = {}): McpForwardContext => ({
    request: { id: "list", type: "mcp_request", method: "tools/list", params: {} },
    route,
    socketSessionId: "socket-a",
    totalTimeoutMs: 1000,
    deadline: new ProgressExtendableDeadline(timer.now(), 1000),
    ...overrides,
  });
  return {
    server,
    timer,
    context,
    trips: () => trips,
    rename: (value: string) => {
      name = value;
    },
    fail: (value: boolean) => {
      failure = value;
    },
    during: (callback?: () => void) => {
      duringList = callback;
    },
  };
}

describe("control socket discovery cache", () => {
  beforeAll(async () => {
    const h = harness();
    await h.server.forwardRequest(h.context());
  });

  test("100 tools/list calls perform one loopback trip and one list serialization, preserving frame bytes", async () => {
    const h = harness();
    const socket = new FakeSocket();
    let serializations = 0;
    const stringify = JSON.stringify;
    const spy = spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        ("tools" in value ||
          ("result" in value &&
            value.result &&
            typeof value.result === "object" &&
            "tools" in value.result))
      ) {
        serializations++;
      }
      return stringify(value);
    });
    try {
      for (let i = 0; i < 100; i++) {
        const result = await h.server.forwardRequest(h.context());
        const frame = {
          id: `request-"\\\n-${i}`,
          type: "mcp_response" as const,
          success: true,
          result,
        };
        h.server.writeFrameTo(socket, "socket-a", frame);
        expect(socket.writes[i]).toBe(`${stringify(frame)}\n`);
      }
      expect({ loopbackTrips: h.trips(), listSerializations: serializations }).toEqual({
        loopbackTrips: 1,
        listSerializations: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("socket identity, session, profile, released seed and client route stay isolated", async () => {
    const h = harness();
    const base = h.context();
    const scopes = [
      base,
      h.context({ socketSessionId: "socket-b" }),
      h.context({ route: { ...base.route, sessionUuid: "session-a" } }),
      h.context({ route: { ...base.route, sessionUuid: "session-b" } }),
      h.context({ route: { ...base.route, toolSelectionProfileUuid: "profile-a" } }),
      h.context({ route: { ...base.route, toolSelectionProfileUuid: "profile-b" } }),
      h.context({ route: { ...base.route, releasedSessionUuid: "released" } }),
      h.context({ route: { ...base.route, clientKey: "acquisition" } }),
    ];
    for (const [i, scope] of scopes.entries()) {
      h.rename(`scope-${i}`);
      const result = await h.server.forwardRequest(scope);
      h.rename("must-not-reload");
      expect(await h.server.forwardRequest(scope)).toEqual(result);
    }
    expect(h.trips()).toBe(scopes.length);
  });

  test("list_changed invalidates a warm tool list", async () => {
    const h = harness();
    const first = await h.server.forwardRequest(h.context());
    await h.server.forwardRequest(h.context());
    expect(h.trips()).toBe(1);
    h.rename("changed");
    ToolRegistry.notifyToolListChanged();
    const changed = await h.server.forwardRequest(h.context());
    expect(changed).not.toEqual(first);
    expect(await h.server.forwardRequest(h.context())).toEqual(changed);
    expect(h.trips()).toBe(2);
  });

  test.each(["enable-toggle", "acquisition"])(
    "%s changes the real session tool list on the same route",
    async (change) => {
      const restore = preserveToolRegistry();
      const h = harness();
      const store = new SessionToolBindingStore();
      const binding = new SessionToolBinding(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        store,
      );
      const profiles = new InMemoryToolSelectionProfileRegistry();
      const disabled = new Set<string>(["acquired"]);
      const service = {
        isEnabled: async (session: string | undefined, _tool: string, fallback: boolean) =>
          session ? !disabled.has(session) : fallback,
        setEnabled: async (session: string, _tool: string, enabled: boolean) => {
          if (enabled) {
            disabled.delete(session);
          } else {
            disabled.add(session);
          }
        },
      };
      let trips = 0;
      try {
        ToolRegistry.clearToolsForTesting();
        ToolRegistry.register("cacheSelectable", "selectable", z.object({}), async () => ({
          content: [],
        }));
        registerToolSelectionTools();
        const list = createListSessionTools({
          options: {
            sessionToolSelectionService: service,
            toolSelectionSessionManager: { getDeviceLabels: () => undefined },
          },
          bindingKey: "socket-a",
          sessionToolBinding: binding,
          toolSelectionProfileRegistry: profiles,
        });
        h.server.mcpClientFactory = async () => {
          trips++;
          return new StubMcpClient({ listTools: async () => (await list()) as ListToolsResult });
        };
        const first = await h.server.forwardRequest(h.context());
        expect(first).toMatchObject({
          tools: expect.arrayContaining([expect.objectContaining({ name: "cacheSelectable" })]),
        });
        expect(await h.server.forwardRequest(h.context())).toEqual(first);
        expect(trips).toBe(1);
        if (change === "enable-toggle") {
          binding.bindToolSelectionProfile("socket-a", "profile");
          await runWithToolSelectionContext(
            { toolSelectionProfileUuid: "profile", sessionToolSelectionService: service },
            () =>
              ToolRegistry.getTool("setToolEnabled")!.handler({
                toolName: "cacheSelectable",
                enabled: false,
              }),
          );
        } else {
          // Acquisition records the new session through this binding seam, then announces the
          // changed surface. Keep the socket and admitted route identical to the warm read.
          binding.bind("socket-a", "acquired");
          ToolRegistry.notifyToolListChanged();
        }
        const narrowed = await h.server.forwardRequest(h.context());
        expect(narrowed).toMatchObject({
          tools: [expect.objectContaining({ name: "setToolEnabled" })],
        });
        expect(await h.server.forwardRequest(h.context())).toEqual(narrowed);
        expect(trips).toBe(2);
      } finally {
        binding.dispose();
        store.dispose();
        restore();
      }
    },
  );

  test("device-label changes and clearing invalidate the session's enabled-tool union", async () => {
    const restore = preserveToolRegistry();
    const h = harness();
    const manager = makeSessionManager({ timer: h.timer });
    const binding = new SessionToolBinding("base");
    let trips = 0;
    try {
      await manager.createSession("base", "fake-device", "android");
      ToolRegistry.clearToolsForTesting();
      ToolRegistry.registerDeviceAware(
        "cacheLabelTool",
        "label tool",
        z.object({}),
        async () => ({}),
        { defaultEnabled: false },
      );
      const list = createListSessionTools({
        options: {
          toolSelectionSessionManager: manager,
          sessionToolSelectionService: { isEnabled: async (session) => session === "base:extra" },
        },
        bindingKey: "socket-a",
        sessionToolBinding: binding,
        toolSelectionProfileRegistry: new InMemoryToolSelectionProfileRegistry(),
      });
      h.server.mcpClientFactory = async () => {
        trips++;
        return new StubMcpClient({ listTools: async () => (await list()) as ListToolsResult });
      };
      expect(await h.server.forwardRequest(h.context())).toEqual({ tools: [] });
      await h.server.forwardRequest(h.context());
      expect(trips).toBe(1);
      manager.setDeviceLabels("base", { extra: "base:extra" });
      expect(await h.server.forwardRequest(h.context())).toMatchObject({
        tools: [expect.objectContaining({ name: "cacheLabelTool" })],
      });
      await h.server.forwardRequest(h.context());
      expect(trips).toBe(2);
      manager.clearSessionCache("base", "deviceLabels");
      expect(await h.server.forwardRequest(h.context())).toEqual({ tools: [] });
      await h.server.forwardRequest(h.context());
      expect(trips).toBe(3);
    } finally {
      binding.dispose();
      manager.stopCleanupTimer();
      restore();
    }
  });

  test("registry mutation without a broadcast invalidates the list", async () => {
    const h = harness();
    await h.server.forwardRequest(h.context());
    await h.server.forwardRequest(h.context());
    expect(h.trips()).toBe(1);
    h.rename("registered");
    ToolRegistry.unregister("iss13550-not-registered");
    await h.server.forwardRequest(h.context());
    expect(h.trips()).toBe(2);
  });

  test("a presentation preference change invalidates output-schema advertisement", async () => {
    const h = harness();
    const profiles = new InMemoryToolSelectionProfileRegistry();
    await h.server.forwardRequest(h.context());
    await h.server.forwardRequest(h.context());
    expect(h.trips()).toBe(1);
    profiles.setToolResultsNoStructuredContent("profile", true);
    await h.server.forwardRequest(h.context());
    expect(h.trips()).toBe(2);
  });

  test("a generation changed during a cold read cannot publish a stale cache entry", async () => {
    const h = harness();
    h.during(() => {
      h.during();
      ListChangedBroadcaster.emit("tools");
      h.rename("new-generation");
    });
    const stale = await h.server.forwardRequest(h.context());
    const fresh = await h.server.forwardRequest(h.context());
    expect(fresh).not.toEqual(stale);
    expect(await h.server.forwardRequest(h.context())).toEqual(fresh);
    expect(h.trips()).toBe(2);
  });

  test("resources/list preserves per-request refreshers and observes registration changes without a broadcast", async () => {
    const h = harness();
    let refreshes = 0;
    const uri = "automobile:iss13550-cache";
    const snapshot = ResourceRegistry.snapshotForTesting();
    const refresh = spyOn(ResourceRegistry, "refreshBeforeList").mockImplementation(async () => {
      refreshes++;
    });
    const context = h.context({
      request: { id: "resources", type: "mcp_request", method: "resources/list", params: {} },
    });
    try {
      await h.server.forwardRequest(context);
      await h.server.forwardRequest(context);
      expect(h.trips()).toBe(1);
      expect(refreshes).toBe(2);
      ResourceRegistry.register(uri, "cache", "cache", "text/plain", async () => ({
        uri,
        text: "ok",
      }));
      const changed = await h.server.forwardRequest(context);
      expect(changed).toEqual({ resources: ResourceRegistry.getResourceDefinitions() });
      expect(h.trips()).toBe(2);
      ListChangedBroadcaster.emit("resources");
      await h.server.forwardRequest(context);
      expect(h.trips()).toBe(3);
    } finally {
      ResourceRegistry.restoreForTesting(snapshot);
      refresh.mockRestore();
    }
  });

  test("a refresher that discovers a resource invalidates a warm resource list", async () => {
    const h = harness();
    const snapshot = ResourceRegistry.snapshotForTesting();
    const uri = "automobile:iss13550-refresh";
    let changed = false;
    const refresh = spyOn(ResourceRegistry, "refreshBeforeList").mockImplementation(async () => {
      if (changed && !ResourceRegistry.getResource(uri)) {
        ResourceRegistry.register(uri, "refreshed", "refreshed", "text/plain", async () => ({
          uri,
          text: "ok",
        }));
      }
    });
    const context = h.context({
      request: { id: "resources", type: "mcp_request", method: "resources/list", params: {} },
    });
    try {
      const first = await h.server.forwardRequest(context);
      await h.server.forwardRequest(context);
      expect(h.trips()).toBe(1);
      changed = true;
      const fresh = await h.server.forwardRequest(context);
      expect(fresh).not.toEqual(first);
      expect(await h.server.forwardRequest(context)).toEqual(fresh);
      expect(h.trips()).toBe(2);
    } finally {
      refresh.mockRestore();
      ResourceRegistry.restoreForTesting(snapshot);
    }
  });

  test("scope churn evicts the oldest answer instead of retaining lists without bound", async () => {
    const h = harness();
    for (let i = 0; i < 129; i++) {
      await h.server.forwardRequest(h.context({ socketSessionId: `socket-${i}` }));
    }
    const recent = h.context({ socketSessionId: "socket-128" });
    await h.server.forwardRequest(recent);
    expect(h.trips()).toBe(129);
    await h.server.forwardRequest(h.context({ socketSessionId: "socket-0" }));
    expect(h.trips()).toBe(130);
  });

  test("a custom dispatcher without a resource freshness hook keeps resources on the loopback path", async () => {
    const h = harness({ resourceRefresh: false });
    const refresh = spyOn(ResourceRegistry, "refreshBeforeList").mockResolvedValue(undefined);
    try {
      await h.server.forwardRequest(h.context());
      await h.server.forwardRequest(h.context());
      expect(h.trips()).toBe(1);
      const context = h.context({
        request: { id: "resources", type: "mcp_request", method: "resources/list", params: {} },
      });
      await h.server.forwardRequest(context);
      await h.server.forwardRequest(context);
      expect(h.trips()).toBe(3);
    } finally {
      refresh.mockRestore();
    }
  });

  test("failed, aborted and expired requests never become cache successes", async () => {
    const h = harness();
    h.fail(true);
    await expect(h.server.forwardRequest(h.context())).rejects.toThrow("list failed");
    h.fail(false);
    await h.server.forwardRequest(h.context());
    await h.server.forwardRequest(h.context());
    expect(h.trips()).toBe(2);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(h.server.forwardRequest(h.context({ signal: abort.signal }))).rejects.toThrow(
      "cancelled",
    );
    h.timer.advanceTime(1001);
    await expect(
      h.server.forwardRequest(h.context({ deadline: new ProgressExtendableDeadline(0, 1000) })),
    ).rejects.toThrow();
    expect(h.trips()).toBe(2);
  });
});
