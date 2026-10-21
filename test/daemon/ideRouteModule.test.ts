import { describe, expect, test } from "bun:test";
import {
  ideFeatureRoutes,
  type IdeFeatureRouteDeps,
} from "../../src/daemon/socketServer/ideRouteModule";
import type { DaemonRequest } from "../../src/daemon/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { spyOn } from "bun:test";

/** #11815: the feature-flag, session-tool and ping routes, with only their dependencies injected. */
function fixture(overrides: Partial<IdeFeatureRouteDeps> = {}) {
  const calls: string[] = [];
  const deps: IdeFeatureRouteDeps = {
    requireFeatureFlagService: () => ({
      listFlags: async () => {
        calls.push("listFlags");
        return [{ key: "debug" }] as never;
      },
      setFlag: async (key, enabled, config) => {
        calls.push(`setFlag:${key}:${enabled}:${JSON.stringify(config)}`);
        return { key, enabled } as never;
      },
    }),
    sessionToolSelection: () => ({
      setEnabled: async (session, tool, enabled) => {
        calls.push(`setEnabled:${session}:${tool}:${enabled}`);
      },
    }),
    assertBrokerHostMutation: (_session, action) => calls.push(`host:${action}`),
    assertBrokerControl: (_session, action, target) =>
      calls.push(`control:${action}:${target.requesterSessionUuid}`),
    emitToolsListChanged: () => calls.push("emit:tools"),
    now: () => 4242,
    ...overrides,
  };
  const routes = ideFeatureRoutes(deps);
  const call = (method: string, params?: unknown) => {
    const handler = routes.get(method);
    if (!handler) {
      throw new Error(`no route ${method}`);
    }
    const request: DaemonRequest = { id: "1", type: "mcp_request", method, params };
    return handler(request, "socket-session");
  };
  return { calls, call, routes };
}

describe("ide feature routes", () => {
  test("the module serves exactly these four methods", () => {
    expect([...fixture().routes.keys()].sort()).toEqual([
      "ide/listFeatureFlags",
      "ide/ping",
      "ide/setFeatureFlag",
      "ide/setSessionToolEnabled",
    ]);
  });

  test("ide/ping answers with the injected clock", async () => {
    expect(await fixture().call("ide/ping")).toEqual({ ok: true, timestamp: 4242 });
  });

  test("ide/listFeatureFlags wraps the service's flags", async () => {
    const { call } = fixture();
    expect(await call("ide/listFeatureFlags")).toEqual({ flags: [{ key: "debug" }] });
  });

  test("ide/setFeatureFlag needs the service before it reads params, then the host-mutation gate", async () => {
    const missing = fixture({
      requireFeatureFlagService: () => {
        throw new Error("Feature flag service not available");
      },
    });
    await expect(missing.call("ide/setFeatureFlag", {})).rejects.toThrow(
      "Feature flag service not available",
    );
    const { calls, call } = fixture();
    await expect(call("ide/setFeatureFlag", { key: "", enabled: true })).rejects.toThrow(
      "setFeatureFlag requires 'key' (string) and 'enabled' (boolean) params",
    );
    expect(calls).toEqual([]);
    await call("ide/setFeatureFlag", { key: "debug", enabled: true, config: { a: 1 } });
    expect(calls).toEqual(["host:ide/setFeatureFlag", 'setFlag:debug:true:{"a":1}']);
  });

  test("a broker-bound refusal stops the flag write", async () => {
    const { calls, call } = fixture({
      assertBrokerHostMutation: () => {
        throw new Error("broker refused");
      },
    });
    await expect(call("ide/setFeatureFlag", { key: "debug", enabled: false })).rejects.toThrow(
      "broker refused",
    );
    expect(calls).toEqual([]);
  });

  test("ide/setSessionToolEnabled checks control, writes, then broadcasts", async () => {
    const configurable = spyOn(ToolRegistry, "isUserConfigurableTool").mockReturnValue(true);
    try {
      const { calls, call } = fixture();
      const result = await call("ide/setSessionToolEnabled", {
        sessionUuid: "s1",
        toolName: "tapOn",
        enabled: false,
      });
      expect(result).toEqual({ sessionUuid: "s1", toolName: "tapOn", enabled: false });
      expect(calls).toEqual([
        "control:ide/setSessionToolEnabled:s1",
        "setEnabled:s1:tapOn:false",
        "emit:tools",
      ]);
    } finally {
      configurable.mockRestore();
    }
  });

  test("ide/setSessionToolEnabled refuses a tool that is not user configurable, before any gate", async () => {
    const { calls, call } = fixture();
    await expect(
      call("ide/setSessionToolEnabled", { sessionUuid: "s1", toolName: "nope", enabled: true }),
    ).rejects.toThrow("setSessionToolEnabled requires sessionUuid");
    expect(calls).toEqual([]);
  });
});
