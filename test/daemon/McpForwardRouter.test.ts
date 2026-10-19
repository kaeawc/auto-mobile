import { describe, expect, test } from "bun:test";
import {
  MAX_MCP_FORWARD_REROUTES,
  McpForwardRouter,
  sessionScopedForwardRoute,
  sharedMcpForwardRoute,
  type McpForwardRoute,
  type McpForwardRoutePort,
} from "../../src/daemon/socketServer/McpForwardRouter";
import {
  runKeyedSerial,
  type KeyedSerialState,
} from "../../src/daemon/socketServer/keyedSerialQueue";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

/** #11815: execution-key / loopback-client routing for MCP forwards, with the daemon state faked. */
class FakePort implements McpForwardRoutePort {
  activeSessions = new Set<string>();
  releasedSessions = new Set<string>();
  bound = new Map<string, McpForwardRoute>();
  scopeKey: string | undefined;
  autolockKey: string | undefined;
  autolockSession: string | undefined;
  holders = new Map<string, string>();
  deviceReads = new Set<string>();
  ownedDeviceSession: string | undefined;
  readonly keyedState: KeyedSerialState = {
    tails: new Map(),
    idleCloseKeys: new Map(),
    timer: new FakeTimer(),
    onAcquired: () => {},
    onDrained: () => {},
  };

  withAdmittedBoundSession<T>(
    args: unknown,
    forward: (recoverableSessionUuid?: string) => T,
  ): T | Promise<T> {
    const sessionUuid = (args as { sessionUuid?: string } | undefined)?.sessionUuid;
    if (sessionUuid && this.releasedSessions.has(sessionUuid)) {
      return Promise.resolve().then(() => forward(sessionUuid));
    }
    return forward();
  }
  boundClientRoute(socketSessionId: string): McpForwardRoute | undefined {
    return this.bound.get(socketSessionId);
  }
  requestArgumentScopeKey(): string | undefined {
    return this.scopeKey;
  }
  implicitAutolockScopeKey(): string | undefined {
    return this.autolockKey;
  }
  implicitAutolockSession(): string | undefined {
    return this.autolockSession;
  }
  resolveDeviceLabelSession(base: string): string {
    return base;
  }
  hasActiveSession(sessionUuid: string): boolean {
    return this.activeSessions.has(sessionUuid);
  }
  deviceHolderSession(deviceId: string): string | undefined {
    return this.holders.get(deviceId);
  }
  toolSelectionBaseSession(sessionUuid: string): string {
    return sessionUuid;
  }
  ownedDeviceSessionForMcpSession(): string | undefined {
    return this.ownedDeviceSession;
  }
  isDeviceReadCall(toolName: string): boolean {
    return this.deviceReads.has(toolName);
  }
  admissionArgs(request: DaemonRequest): unknown {
    return request.params;
  }
  runKeyed<T>(executionKey: string, fn: () => Promise<T>, idleCloseKey?: string): Promise<T> {
    return runKeyedSerial(this.keyedState, executionKey, fn, idleCloseKey);
  }
}

const toolsCall = (name: string, args: Record<string, unknown> = {}): DaemonRequest => ({
  id: "r1",
  type: "mcp_request",
  method: "tools/call",
  params: { name, arguments: args },
});

function fixture() {
  const port = new FakePort();
  return { port, router: new McpForwardRouter(port) };
}

describe("McpForwardRouter.resolve", () => {
  test("a healthy tools/call resolves synchronously, not through a promise", () => {
    const { router } = fixture();
    const route = router.resolve(toolsCall("observe"), "sock");
    expect(route instanceof Promise).toBe(false);
    expect(route).toEqual(sharedMcpForwardRoute("socket:sock"));
  });

  test("a released bound session resolves through the admission promise", async () => {
    const { port, router } = fixture();
    port.releasedSessions.add("s1");
    const route = router.resolve(toolsCall("observe", { sessionUuid: "s1" }), "sock");
    expect(route instanceof Promise).toBe(true);
    expect(await route).toEqual(sessionScopedForwardRoute("sock", "s1", undefined));
  });

  test("an unbound device acquisition keeps its own per-tool client", () => {
    const { router } = fixture();
    const route = router.resolve(toolsCall("startDevice"), "sock");
    expect(route).toEqual({
      executionKey: "socket:sock:acquisition:startDevice",
      clientKey: "socket:sock:acquisition:startDevice",
      toolSelectionProfileUuid: undefined,
    });
  });

  test("an explicit session routes to its own session-scoped client", () => {
    const { router } = fixture();
    const route = router.resolve(toolsCall("observe", { sessionUuid: "s1" }), "sock");
    expect(route).toEqual(sessionScopedForwardRoute("sock", "s1", undefined));
  });

  test("a scope key under a bound route keeps the bound client and takes the key", () => {
    const { port, router } = fixture();
    port.scopeKey = "device:emu";
    port.bound.set("sock", { executionKey: "x", clientKey: "bound" });
    expect(router.resolve(toolsCall("observe"), "sock")).toEqual({
      executionKey: "device:emu",
      clientKey: "bound",
    });
  });

  test("a bound host-inventory call serializes on host:inventory", () => {
    const { port, router } = fixture();
    port.bound.set("sock", { executionKey: "x", clientKey: "bound" });
    const route = router.resolve(toolsCall("listDevices"), "sock");
    expect(route).toEqual({ executionKey: "host:inventory", clientKey: "bound" });
  });

  test("an implicit platform selector keys on the autolock scope", () => {
    const { port, router } = fixture();
    port.autolockKey = "device:auto";
    expect(router.resolve(toolsCall("observe", { platform: "ios" }), "sock")).toEqual(
      sharedMcpForwardRoute("device:auto"),
    );
  });

  test("discovery with a session routes to the session-scoped client, else the bound route", () => {
    const { port, router } = fixture();
    const list = (params?: Record<string, unknown>): DaemonRequest => ({
      id: "r",
      type: "mcp_request",
      method: "tools/list",
      params,
    });
    expect(router.resolve(list({ sessionUuid: "s1" }), "sock")).toEqual(
      sessionScopedForwardRoute("sock", "s1", undefined),
    );
    expect(router.resolve(list(), "sock")).toEqual(sharedMcpForwardRoute("method:tools/list"));
    port.bound.set("sock", { executionKey: "x", clientKey: "bound" });
    expect(router.resolve(list(), "sock")).toEqual({ executionKey: "x", clientKey: "bound" });
  });

  test("a resource read names its URI, or its released session", () => {
    const { router } = fixture();
    const read = (params: Record<string, unknown>): DaemonRequest => ({
      id: "r",
      type: "mcp_request",
      method: "resources/read",
      params,
    });
    expect(router.resolve(read({ uri: "automobile:x" }), "sock")).toEqual(
      sharedMcpForwardRoute("resource:automobile:x"),
    );
    expect(router.resolve(read({}), "sock")).toEqual(sharedMcpForwardRoute("resource:unknown"));
  });
});

describe("McpForwardRouter device read lane", () => {
  const setup = () => {
    const f = fixture();
    f.port.scopeKey = "device:emu";
    f.port.deviceReads.add("observe");
    return f;
  };

  test("a watcher read of a held device moves to the read lane", () => {
    const { port, router } = setup();
    port.holders.set("emu", "holder");
    const route = router.resolve(toolsCall("observe", { deviceId: "emu" }), "sock");
    expect((route as McpForwardRoute).executionKey).toBe("device:emu:read");
  });

  test("the holder's own read stays on the control lane", () => {
    const { port, router } = setup();
    port.holders.set("emu", "holder");
    const route = router.resolve(
      toolsCall("observe", { deviceId: "emu", sessionUuid: "holder" }),
      "sock",
    );
    expect((route as McpForwardRoute).executionKey).toBe("device:emu");
  });

  test("a read of a free device, and a non-read call, stay on the control lane", () => {
    const { port, router } = setup();
    expect((router.resolve(toolsCall("observe"), "sock") as McpForwardRoute).executionKey).toBe(
      "device:emu",
    );
    port.holders.set("emu", "holder");
    expect((router.resolve(toolsCall("tapOn"), "sock") as McpForwardRoute).executionKey).toBe(
      "device:emu",
    );
  });

  test("a classifier that throws keeps the control lane", () => {
    const { port, router } = setup();
    port.holders.set("emu", "holder");
    port.isDeviceReadCall = () => {
      throw new Error("bad args");
    };
    expect((router.resolve(toolsCall("observe"), "sock") as McpForwardRoute).executionKey).toBe(
      "device:emu",
    );
  });
});

describe("McpForwardRouter.runForCurrentRoute", () => {
  test("runs fn with the admitted route when the key is unchanged", async () => {
    const { router } = fixture();
    const request = toolsCall("observe");
    const route = router.resolve(request, "sock") as McpForwardRoute;
    const seen: McpForwardRoute[] = [];
    const result = await router.runForCurrentRoute(route, request, "sock", async (r) => {
      seen.push(r);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual([route]);
  });

  test("follows a moved key, releasing the old one first", async () => {
    const { port, router } = fixture();
    const request = toolsCall("observe");
    const first = router.resolve(request, "sock") as McpForwardRoute;
    port.scopeKey = "device:emu";
    const seen: string[] = [];
    await router.runForCurrentRoute(first, request, "sock", async (r) => {
      seen.push(r.executionKey);
    });
    expect(seen).toEqual(["device:emu"]);
    await drainMicrotasks(20);
    expect(port.keyedState.tails.size).toBe(0);
  });

  test("fails after more than MAX_MCP_FORWARD_REROUTES hops", async () => {
    const { port, router } = fixture();
    const request = toolsCall("observe");
    const first = router.resolve(request, "sock") as McpForwardRoute;
    let n = 0;
    port.requestArgumentScopeKey = () => `device:${++n}`;
    await expect(
      router.runForCurrentRoute(first, request, "sock", async () => "never"),
    ).rejects.toThrow(`re-routed more than ${MAX_MCP_FORWARD_REROUTES} times`);
  });

  test("a released admitted session re-resolves to the current route", async () => {
    const { port, router } = fixture();
    const admitted = sessionScopedForwardRoute("sock", "s1", "device:emu");
    port.scopeKey = "device:emu";
    const seen: McpForwardRoute[] = [];
    await router.runForCurrentRoute(admitted, toolsCall("observe"), "sock", async (r) => {
      seen.push(r);
    });
    expect(seen).toEqual([sharedMcpForwardRoute("device:emu")]);
  });

  test("a live admitted session keeps its admitted client", async () => {
    const { port, router } = fixture();
    const admitted = sessionScopedForwardRoute("sock", "s1", "device:emu");
    port.scopeKey = "device:emu";
    port.activeSessions.add("s1");
    const seen: McpForwardRoute[] = [];
    await router.runForCurrentRoute(admitted, toolsCall("observe"), "sock", async (r) => {
      seen.push(r);
    });
    expect(seen).toEqual([admitted]);
  });
});
