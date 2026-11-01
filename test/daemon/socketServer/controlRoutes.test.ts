import { describe, expect, test } from "bun:test";
import {
  dispatchInputRoute,
  isOwnerFencedMethod,
  runPassthroughForward,
  type InputRouteHandlers,
  type PassthroughClient,
} from "../../../src/daemon/socketServer/controlRoutes";
import { INPUT_ROUTES, inputRouteFor } from "../../../src/daemon/inputRoutes";
import { INTERNAL_MCP_REQUEST_TIMEOUT_PARAM } from "../../../src/daemon/wire/constants";
import type { DaemonRequest } from "../../../src/daemon/types";

const req = (method: string, params: Record<string, unknown> = {}): DaemonRequest =>
  ({ id: "1", method, params }) as DaemonRequest;

function recordingHandlers() {
  const calls: string[] = [];
  const handlers: InputRouteHandlers<string> = {
    tap: async () => (calls.push("tap"), "tap"),
    swipe: async () => (calls.push("swipe"), "swipe"),
    typeText: async () => (calls.push("typeText"), "typeText"),
    pressButton: async () => (calls.push("pressButton"), "pressButton"),
    key: async () => (calls.push("key"), "key"),
    gesture: async (_r, kind) => (calls.push(`gesture:${kind}`), `gesture:${kind}`),
  };
  return { calls, handlers };
}

describe("controlRoutes input dispatch", () => {
  test("every table route reaches its named handler", async () => {
    for (const route of INPUT_ROUTES) {
      const { calls, handlers } = recordingHandlers();
      await dispatchInputRoute(handlers, inputRouteFor(route.method)!, req(route.method), {
        socketSessionId: "s",
        input: "ctx",
      });
      const expected = route.handler === "gesture" ? `gesture:${route.gestureKind}` : route.handler;
      expect(calls).toEqual([expected]);
    }
  });

  test("owner fence covers input and listed ide mutations only", () => {
    const mutations = new Set(["ide/updateService"]);
    expect(isOwnerFencedMethod("input/tap", mutations)).toBe(true);
    expect(isOwnerFencedMethod("ide/updateService", mutations)).toBe(true);
    expect(isOwnerFencedMethod("ide/ping", mutations)).toBe(false);
  });
});

describe("controlRoutes passthrough forwards", () => {
  function setup(method: string, params: Record<string, unknown> = {}) {
    const calls: unknown[][] = [];
    const mcpClient: PassthroughClient = {
      listTools: async (...args: unknown[]) => (
        calls.push(["listTools", ...args]),
        { name: "listTools" }
      ),
      listResources: async (...args: unknown[]) => (
        calls.push(["listResources", ...args]),
        { name: "listResources" }
      ),
      readResource: async (...args: unknown[]) => (
        calls.push(["readResource", ...args]),
        { name: "readResource" }
      ),
      listResourceTemplates: async (...args: unknown[]) => (
        calls.push(["listResourceTemplates", ...args]),
        { name: "listResourceTemplates" }
      ),
      callTool: async (...args: unknown[]) => (
        calls.push(["callTool", ...args]),
        { name: "callTool" }
      ),
    };
    const admissions: unknown[] = [];
    const ctx = {
      mcpClient,
      request: req(method, params),
      timeoutMs: 500,
      options: { timeout: 500 },
      admitted: <T>(args: unknown, forward: () => T) => (admissions.push(args), forward()),
      readAdmissionArgs: () => "read-args",
    };
    return { ctx, calls, admissions };
  }

  test.each([
    ["tools/list", "listTools"],
    ["resources/list", "listResources"],
    ["resources/list-templates", "listResourceTemplates"],
  ])("%s calls %s after admission", async (method, sdk) => {
    const { ctx, calls, admissions } = setup(method, { a: 1 });
    const out = runPassthroughForward(ctx);
    expect(await out).toEqual({ name: sdk });
    expect(calls).toEqual([[sdk, undefined, { timeout: 500 }]]);
    expect(admissions).toEqual([{ a: 1 }]);
  });

  test("resources/read uses the admission args and requires a uri", async () => {
    const ok = setup("resources/read", { uri: "automobile:x" });
    await runPassthroughForward(ok.ctx);
    expect(ok.admissions).toEqual(["read-args"]);
    expect(ok.calls).toEqual([["readResource", { uri: "automobile:x" }, { timeout: 500 }]]);
    await expect(runPassthroughForward(setup("resources/read").ctx)!).rejects.toThrow(
      "resources/read requires params.uri",
    );
  });

  test("resources/read preserves request metadata without leaking routing parameters", async () => {
    const _meta = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { "io.modelcontextprotocol/ui": {} },
      },
    };
    const { ctx, calls } = setup("resources/read", {
      uri: "ui://automobile/observe",
      _meta,
      sessionUuid: "owner",
    });
    await runPassthroughForward(ctx);
    expect(calls).toEqual([
      ["readResource", { uri: "ui://automobile/observe", _meta }, { timeout: 500 }],
    ]);
  });

  test("ide/getNavigationGraph forwards the remaining timeout without admission", async () => {
    const { ctx, calls, admissions } = setup("ide/getNavigationGraph", { appId: "a" });
    await runPassthroughForward(ctx);
    expect(admissions).toEqual([]);
    expect(calls).toEqual([
      [
        "callTool",
        {
          name: "getNavigationGraph",
          arguments: { appId: "a", [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 500 },
        },
        { timeout: 500 },
      ],
    ]);
  });

  test("tools/call and task methods are left to the server", async () => {
    for (const m of ["tools/call", "tasks/get"]) {
      expect(runPassthroughForward(setup(m).ctx)).toBeUndefined();
    }
  });
});
