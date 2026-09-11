import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { getToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { executionTracker } from "../../src/server/executionTracker";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";

describe("per-session exact-tool selection", () => {
  let fixture: McpTestFixture | undefined;
  let restoreToolPipeline: (() => void) | undefined;

  afterEach(async () => {
    restoreToolPipeline?.();
    restoreToolPipeline = undefined;
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
  });

  for (const acquisition of ["getAndroid", "getApple"]) {
    test.each([
      ["broadcast", "lookup"],
      ["plan", "lookup"],
      ["broadcast", "handler"],
      ["plan", "handler"],
    ])(acquisition + " rejects publication after a %s release during %s", async (source, stage) => {
      const lookupStarted = Promise.withResolvers<void>();
      const releaseLookup = Promise.withResolvers<void>();
      fixture = new McpTestFixture({
        sessionToolSelectionService: {
          isEnabled: async (_sessionUuid, toolName, declaredDefault) => {
            if (toolName === "inputText" && stage === "lookup") {
              lookupStarted.resolve();
              await releaseLookup.promise;
            }
            return declaredDefault;
          },
        },
      });
      await fixture.setup();
      ToolRegistry.clearTools();
      ToolRegistry.register(
        acquisition,
        "acquire",
        z.object({}),
        async () => {
          if (stage === "handler") {
            lookupStarted.resolve();
            await releaseLookup.promise;
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ sessionUuid: "released-session" }) }],
          };
        },
        { defaultEnabled: true },
      );
      ToolRegistry.register("inputText", "input", z.object({}), async () => ({ content: [] }), {
        defaultEnabled: false,
      });
      ToolRegistry.register(
        "inspectRouting",
        "routing",
        z.object({}),
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionUuid: getToolSelectionContext()?.routingSessionUuid,
              }),
            },
          ],
        }),
        { defaultEnabled: true },
      );
      const pending = fixture.client.request(
        { method: "tools/call", params: { name: acquisition, arguments: {} } },
        z.any(),
      );
      await lookupStarted.promise;
      if (source === "broadcast") {
        SessionReleaseBroadcaster.emit("released-session", "released-during-discovery");
      } else {
        ToolRegistry.notifySessionBindingReleased("released-session");
      }
      releaseLookup.resolve();
      await expect(pending).rejects.toThrow(/released during acquisition/);
      const routed = await fixture.client.request(
        { method: "tools/call", params: { name: "inspectRouting", arguments: {} } },
        z.any(),
      );
      expect(JSON.parse(routed.content[0].text)).toEqual({});
    });

    test(acquisition + " reports the acquired profile on a seeded transport", async () => {
      fixture = new McpTestFixture({
        sessionContext: { initialSessionToolBinding: "old-session" },
        sessionToolSelectionService: {
          isEnabled: async (sessionUuid, toolName, declaredDefault) =>
            toolName === "inputText" ? sessionUuid === "old-session" : declaredDefault,
        },
      });
      await fixture.setup();
      ToolRegistry.clearTools();
      ToolRegistry.register(
        acquisition,
        "acquire",
        z.object({}),
        async () => ({
          content: [{ type: "text", text: JSON.stringify({ sessionUuid: "new-session" }) }],
        }),
        { defaultEnabled: true },
      );
      ToolRegistry.register("inputText", "input", z.object({}), async () => ({ content: [] }), {
        defaultEnabled: false,
      });
      expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).toContain(
        "inputText",
      );
      const response = await fixture.client.request(
        { method: "tools/call", params: { name: acquisition, arguments: {} } },
        z.any(),
      );
      expect(JSON.parse(response.content[0].text)).toEqual({
        sessionUuid: "new-session",
        gatedTools: ["inputText"],
      });
    });

    test(acquisition + " publishes concurrent acquisitions in response order", async () => {
      const lookupStarted = Promise.withResolvers<void>();
      const releaseLookup = Promise.withResolvers<void>();
      let held = false;
      fixture = new McpTestFixture({
        sessionToolSelectionService: {
          isEnabled: async (sessionUuid, toolName, declaredDefault) => {
            if (toolName !== "inputText") {
              return declaredDefault;
            }
            if (sessionUuid === "session-a" && !held) {
              held = true;
              lookupStarted.resolve();
              await releaseLookup.promise;
            }
            return sessionUuid === "session-b";
          },
        },
      });
      await fixture.setup();
      ToolRegistry.clearTools();
      ToolRegistry.register(
        acquisition,
        "acquire",
        z.object({ target: z.string() }),
        async (args) => ({
          content: [{ type: "text", text: JSON.stringify({ sessionUuid: args.target }) }],
        }),
        { defaultEnabled: true },
      );
      ToolRegistry.register("inputText", "input", z.object({}), async () => ({ content: [] }), {
        defaultEnabled: false,
      });
      ToolRegistry.register(
        "inspectRouting",
        "routing",
        z.object({}),
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionUuid: getToolSelectionContext()?.routingSessionUuid }),
            },
          ],
        }),
        { defaultEnabled: true },
      );
      const acquire = async (target: string) => {
        const response = await fixture!.client.request(
          { method: "tools/call", params: { name: acquisition, arguments: { target } } },
          z.any(),
        );
        return JSON.parse(response.content[0].text);
      };
      const first = acquire("session-a");
      try {
        await lookupStarted.promise;
        expect(await acquire("session-b")).toEqual({ sessionUuid: "session-b", gatedTools: [] });
        expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).toContain(
          "inputText",
        );
      } finally {
        releaseLookup.resolve();
      }
      expect(await first).toEqual({ sessionUuid: "session-a", gatedTools: ["inputText"] });
      expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        "inputText",
      );
      const routed = await fixture.client.request(
        { method: "tools/call", params: { name: "inspectRouting", arguments: {} } },
        z.any(),
      );
      expect(JSON.parse(routed.content[0].text)).toEqual({ sessionUuid: "session-a" });
    });

    test(acquisition + " preserves acquisition when profile discovery fails", async () => {
      fixture = new McpTestFixture({
        sessionToolSelectionService: {
          isEnabled: async (_sessionUuid, toolName, declaredDefault) => {
            if (toolName === "inputText") {
              throw new Error("profile database unavailable");
            }
            return declaredDefault;
          },
        },
      });
      await fixture.setup();
      ToolRegistry.clearTools();
      ToolRegistry.register(
        acquisition,
        "acquire",
        z.object({}),
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionUuid: "acquired-session", timing: { total: 1 } }),
            },
          ],
        }),
        { defaultEnabled: true },
      );
      ToolRegistry.register("inputText", "input", z.object({}), async () => ({ content: [] }), {
        defaultEnabled: false,
      });
      const response = await fixture.client.request(
        { method: "tools/call", params: { name: acquisition, arguments: {} } },
        z.any(),
      );
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        sessionUuid: "acquired-session",
        timing: { total: 1 },
      });
    });

    test(
      acquisition + " names gated tools after acquisition and respects re-enabling",
      async () => {
        fixture = new McpTestFixture();
        await fixture.setup();
        ToolRegistry.clearTools();
        ToolRegistry.register(
          acquisition,
          "acquire",
          z.object({}),
          async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({ sessionUuid: "acquired-session", timing: { total: 1 } }),
              },
            ],
          }),
          { defaultEnabled: true },
        );
        ToolRegistry.register("inputText", "input", z.object({}), async () => ({ content: [] }), {
          defaultEnabled: false,
        });
        ToolRegistry.register("hiddenTool", "hidden", z.object({}), async () => ({ content: [] }), {
          defaultEnabled: false,
          hidden: true,
        });
        registerToolSelectionTools();
        const acquire = async () => {
          const response = await fixture!.client.request(
            { method: "tools/call", params: { name: acquisition, arguments: {} } },
            z.any(),
          );
          return JSON.parse(response.content[0].text);
        };
        const payload = await acquire();
        expect(payload.sessionUuid).toBe("acquired-session");
        expect(payload.timing).toEqual({ total: 1 });
        expect(payload.gatedTools).toEqual(["inputText"]);
        const listed = await fixture.client.listTools();
        expect(listed.tools.map((tool) => tool.name)).not.toContain("inputText");
        const control = listed.tools.find((tool) => tool.name === "setToolEnabled")!;
        expect((control.inputSchema.properties!.toolName as { enum: string[] }).enum).toContain(
          "inputText",
        );
        await fixture.client.request(
          {
            method: "tools/call",
            params: { name: "setToolEnabled", arguments: { toolName: payload.gatedTools[0] } },
          },
          z.any(),
        );
        expect((await acquire()).gatedTools).toEqual([]);
        expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).toContain(
          "inputText",
        );
      },
    );
  }

  test("enables one exact tool without exposing its former group sibling", async () => {
    const enabled = new Set<string>();
    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled"> = {
      isEnabled: async (_sessionUuid, toolName, declaredDefault) =>
        enabled.has(toolName) || declaredDefault,
      setEnabled: async (_sessionUuid, toolName, value) => {
        if (value) {
          enabled.add(toolName);
        } else {
          enabled.delete(toolName);
        }
      },
    };
    fixture = new McpTestFixture({
      sessionToolSelectionService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "clipboard" }] }),
      { defaultEnabled: false },
    );
    ToolRegistry.register(
      "selectAllText",
      "selectAllText",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "selectAllText" }] }),
      { defaultEnabled: false },
    );
    registerToolSelectionTools();

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard" },
        },
      },
      z.any(),
    );

    const listed = await fixture.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("clipboard");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("selectAllText");
  });

  test("can disable a tool that is enabled by default", async () => {
    const overrides = new Map<string, boolean>();
    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled"> = {
      isEnabled: async (_sessionUuid, toolName, declaredDefault) =>
        overrides.get(toolName) ?? declaredDefault,
      setEnabled: async (_sessionUuid, toolName, enabled) => {
        overrides.set(toolName, enabled);
      },
    };
    fixture = new McpTestFixture({
      sessionToolSelectionService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "observe",
      "observe",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "observe" }] }),
      { defaultEnabled: true },
    );
    registerToolSelectionTools();

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "observe", enabled: false },
        },
      },
      z.any(),
    );

    const listed = await fixture.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain("observe");
    expect(listed.tools.map((tool) => tool.name)).toContain("setToolEnabled");
  });

  test("a connection-profile disable still rejects calls after device routing binds", async () => {
    const overrides = new Map<string, Map<string, boolean>>([
      ["connection-profile", new Map([["observe", false]])],
    ]);
    const profileService: Pick<
      SessionToolSelectionService,
      "isEnabled" | "getOverride" | "setEnabled"
    > = {
      isEnabled: async (sessionUuid, toolName, declaredDefault) =>
        (sessionUuid ? overrides.get(sessionUuid)?.get(toolName) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid, toolName) => overrides.get(sessionUuid)?.get(toolName),
      setEnabled: async () => {},
    };
    fixture = new McpTestFixture({
      sessionContext: {
        initialSessionToolBinding: "routing-session",
        initialToolSelectionProfile: "connection-profile",
      },
      sessionToolSelectionService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "observe",
      "observe",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: true },
    );

    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "observe",
    );
    await expect(
      fixture.client.request(
        { method: "tools/call", params: { name: "observe", arguments: {} } },
        z.any(),
      ),
    ).rejects.toThrow("Tool observe is disabled");
  });

  test("an omitted update after routing binds creates an independent connection profile", async () => {
    const persisted: Array<{ sessionUuid: string; toolName: string; enabled: boolean }> = [];
    fixture = new McpTestFixture({
      sessionContext: { initialSessionToolBinding: "routing-session" },
      sessionToolSelectionService: {
        isEnabled: async (_sessionUuid, _toolName, declaredDefault) => declaredDefault,
        setEnabled: async (sessionUuid, toolName, enabled) => {
          persisted.push({ sessionUuid, toolName, enabled });
        },
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "clipboard" }] }),
      { defaultEnabled: false },
    );
    registerToolSelectionTools();

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard" },
        },
      },
      z.any(),
    );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.sessionUuid).not.toBe("routing-session");
    expect(persisted[0]?.sessionUuid.length).toBeGreaterThan(0);
  });

  test("an explicit routing-session update does not become the connection profile", async () => {
    const overrides = new Map<string, Map<string, boolean>>();
    fixture = new McpTestFixture({
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, toolName, declaredDefault) =>
          (sessionUuid ? overrides.get(sessionUuid)?.get(toolName) : undefined) ?? declaredDefault,
        getOverride: async (sessionUuid, toolName) => overrides.get(sessionUuid)?.get(toolName),
        setEnabled: async (sessionUuid, toolName, enabled) => {
          const sessionOverrides = overrides.get(sessionUuid) ?? new Map<string, boolean>();
          sessionOverrides.set(toolName, enabled);
          overrides.set(sessionUuid, sessionOverrides);
        },
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "observe",
      "observe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: true },
    );
    registerToolSelectionTools();

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "observe", enabled: false, sessionUuid: "routing-a" },
        },
      },
      z.any(),
    );

    const result = await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "observe",
          arguments: { sessionUuid: "routing-b" },
        },
      },
      z.any(),
    );
    expect(result.content[0]?.text).toBe("ran");
  });

  test("a derived routing binding retains the base session grant for discovery and calls", async () => {
    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (sessionUuid, toolName, declaredDefault) =>
        sessionUuid === "base-session" && toolName === "clipboard" ? true : declaredDefault,
      getOverride: async (sessionUuid, toolName) =>
        sessionUuid === "base-session" && toolName === "clipboard" ? true : undefined,
    };
    fixture = new McpTestFixture({
      sessionContext: { initialSessionToolBinding: "base-session:B" },
      sessionToolSelectionService: profileService,
      toolSelectionSessionManager: {
        getDeviceLabels: (sessionUuid) =>
          sessionUuid === "base-session" ? { A: "base-session", B: "base-session:B" } : undefined,
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: false },
    );

    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).toContain(
      "clipboard",
    );
    const result = await fixture.client.request(
      { method: "tools/call", params: { name: "clipboard", arguments: {} } },
      z.any(),
    );
    expect(result.content[0]?.text).toBe("ran");
  });

  test("discovers a device-aware tool enabled through any sibling label route", async () => {
    const overrides = new Map<string, boolean>([["base-session:B", true]]);
    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
        (sessionUuid ? overrides.get(sessionUuid) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid) => overrides.get(sessionUuid),
    };
    fixture = new McpTestFixture({
      sessionContext: { initialSessionToolBinding: "base-session" },
      sessionToolSelectionService: profileService,
      toolSelectionSessionManager: {
        getDeviceLabels: (sessionUuid) =>
          sessionUuid === "base-session" ? { A: "base-session", B: "base-session:B" } : undefined,
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: false },
    );
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: false },
    );

    const listedNames = (await fixture.client.listTools()).tools.map((tool) => tool.name);
    expect(listedNames).toContain("observe");
    expect(listedNames).not.toContain("clipboard");
  });

  test("does not let one sibling label disable a tool on every route", async () => {
    const overrides = new Map<string, boolean>([["base-session:A", false]]);
    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
        (sessionUuid ? overrides.get(sessionUuid) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid) => overrides.get(sessionUuid),
    };
    fixture = new McpTestFixture({
      sessionContext: { initialSessionToolBinding: "base-session" },
      sessionToolSelectionService: profileService,
      toolSelectionSessionManager: {
        getDeviceLabels: (sessionUuid) =>
          sessionUuid === "base-session" ? { A: "base-session:A", B: "base-session" } : undefined,
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: true },
    );

    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).toContain("observe");
    await expect(
      fixture.client.request(
        {
          method: "tools/call",
          params: { name: "observe", arguments: { device: "A" } },
        },
        z.any(),
      ),
    ).rejects.toThrow("Tool observe is disabled");

    overrides.set("base-session", false);
    expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "observe",
    );
  });

  test("resolves a sibling label from the base when bound to a derived route", async () => {
    fixture = new McpTestFixture({
      sessionContext: { initialSessionToolBinding: "base-session:B" },
      toolSelectionSessionManager: {
        getDeviceLabels: (sessionUuid) =>
          sessionUuid === "base-session" ? { A: "base-session", B: "base-session:B" } : undefined,
      },
    });
    await fixture.setup();

    let resolvedSessionUuid: string | undefined;
    restoreToolPipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async ({ args }) => {
          resolvedSessionUuid = args.sessionUuid;
          return {
            args,
            baseSessionUuid: args.sessionUuid,
            device: undefined,
            internalCall: false,
            sessionUuid: args.sessionUuid,
            shouldResolveDevice: false,
          };
        },
      },
    });
    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      z.object({ device: z.string().optional() }),
      async () => ({ content: [{ type: "text", text: "device" }] }),
      {
        defaultEnabled: true,
        nonDeviceHandler: async () => ({ content: [{ type: "text", text: "ran" }] }),
      },
    );

    const result = await fixture.client.request(
      {
        method: "tools/call",
        params: { name: "observe", arguments: { device: "A" } },
      },
      z.any(),
    );

    expect(result.content[0]?.text).toBe("ran");
    expect(resolvedSessionUuid).toBe("base-session");
  });

  test("does not authorize a targeted label from the ambient sibling route", async () => {
    const overrides = new Map<string, boolean>([
      ["base-session:B", true],
      ["base-session", false],
      ["base-session:A", false],
    ]);
    fixture = new McpTestFixture({
      sessionContext: { initialSessionToolBinding: "base-session:B" },
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
          (sessionUuid ? overrides.get(sessionUuid) : undefined) ?? declaredDefault,
        getOverride: async (sessionUuid, _toolName) => overrides.get(sessionUuid),
      },
      toolSelectionSessionManager: {
        getDeviceLabels: (sessionUuid) =>
          sessionUuid === "base-session" ? { A: "base-session:A", B: "base-session:B" } : undefined,
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      z.object({ device: z.string().optional() }),
      async () => ({ content: [{ type: "text", text: "ran" }] }),
      { defaultEnabled: false },
    );

    await expect(
      fixture.client.request(
        {
          method: "tools/call",
          params: { name: "observe", arguments: { device: "A" } },
        },
        z.any(),
      ),
    ).rejects.toThrow("Tool observe is disabled");
  });

  test("rejects unknown, structural, and self-disable targets", async () => {
    fixture = new McpTestFixture({
      sessionToolSelectionService: {
        isEnabled: async (_sessionUuid, _toolName, declaredDefault) => declaredDefault,
        setEnabled: async () => {},
      },
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "barrier",
      "barrier",
      z.object({}),
      async () => ({ content: [] }),
      { defaultEnabled: true, planOnly: true, planExecutable: true },
    );
    registerToolSelectionTools();

    for (const toolName of ["missing", "barrier", "setToolEnabled"]) {
      await expect(
        fixture.client.request(
          {
            method: "tools/call",
            params: {
              name: "setToolEnabled",
              arguments: { toolName },
            },
          },
          z.any(),
        ),
      ).rejects.toThrow("not user-configurable");
    }
  });
});

// The post-handler cancellation guard added alongside the gated-tools
// enrichment must stay scoped to that enrichment. A cancellation that lands
// while ANY other tool is finishing used to discard that tool's complete result
// and replace it with an error naming an acquisition it never performed; and on
// a real acquisition the throw dropped the minted session UUID without ever
// releasing it, leaving the daemon holding the device for a client that never
// learned the handle.
describe("post-handler cancellation guard scope", () => {
  let fixture: McpTestFixture | undefined;
  let restoreAutolock: (() => void) | undefined;

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    restoreAutolock?.();
    restoreAutolock = undefined;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
  });

  test("a non-acquisition tool's finished result survives a concurrent cancellation", async () => {
    const sessionId = "cancel-guard-session";
    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({}),
      async () => {
        // Model transport/session teardown landing while the handler is
        // finishing, after it already produced a complete, correct result.
        await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ value: "finished" }) }],
        };
      },
      { defaultEnabled: true },
    );

    const response = await fixture.client.request(
      { method: "tools/call", params: { name: "clipboard", arguments: {} } },
      z.any(),
    );
    expect(JSON.parse(response.content[0].text)).toEqual({ value: "finished" });
  });

  for (const acquisition of ["getAndroid", "getApple"]) {
    test(acquisition + " releases the minted session when enrichment is cancelled", async () => {
      const sessionId = "cancel-guard-acquire-session";
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const releases: string[] = [];
      const releaseSession = sessionManager.releaseSession.bind(sessionManager);
      sessionManager.releaseSession = async (uuid, reason, allowExpired) => {
        releases.push(uuid);
        return await releaseSession(uuid, reason, allowExpired);
      };
      const pool = new DevicePool(
        sessionManager,
        "daemon-test",
        timer,
        undefined,
        new FakeDeviceUtils(),
      );
      DaemonState.getInstance().initialize(sessionManager, pool);

      fixture = new McpTestFixture({ sessionContext: { sessionId } });
      await fixture.setup();
      ToolRegistry.clearTools();
      ToolRegistry.register(
        acquisition,
        "acquire",
        z.object({}),
        async () => {
          await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ sessionUuid: "minted-session" }) },
            ],
          };
        },
        { defaultEnabled: true },
      );

      await expect(
        fixture.client.request(
          { method: "tools/call", params: { name: acquisition, arguments: {} } },
          z.any(),
        ),
      ).rejects.toThrow(/cancelled during acquisition/);
      expect(releases).toEqual(["minted-session"]);
    });
  }

  test("a cancelled acquisition keeps a pre-existing autolock session it merely reused", async () => {
    const sessionId = "cancel-guard-reuse-session";
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    restoreAutolock = () => {
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-test",
      timer,
      undefined,
      new FakeDeviceUtils(),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const device = { name: "Pixel 8", platform: "android" as const, deviceId: "reused-android-1" };
    await pool.initializeWithDevices([device]);
    pool.notifyDeviceReady(device.deviceId);

    // This MCP client already owns a live autolock session on the device.
    const existingSessionUuid = await pool.autolockDevice(device.deviceId, "android", sessionId);

    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "getAndroid",
      "acquire",
      z.object({}),
      async () => {
        // Reuse, not mint: autolock hands back the caller's own live session.
        const reused = await pool.autolockDevice(device.deviceId, "android", sessionId);
        await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid: reused }) }],
        };
      },
      { defaultEnabled: true },
    );

    await expect(
      fixture.client.request(
        { method: "tools/call", params: { name: "getAndroid", arguments: {} } },
        z.any(),
      ),
    ).rejects.toThrow(/cancelled during acquisition/);

    // The cancelled request never minted this ownership, so retiring the
    // session and idling the device would disrupt the client's other work.
    expect(sessionManager.getSession(existingSessionUuid)).not.toBeNull();
    expect(pool.getDevice(device.deviceId)).toMatchObject({
      status: "busy",
      sessionId: existingSessionUuid,
    });
  });

  // The pre-call snapshot this guard used to rely on (read from the pool's
  // mcpSessionAutolockMap BEFORE the handler ran) is blind to a session minted
  // by a CONCURRENT call on the same MCP connection: both calls snapshot
  // `undefined`, the first mints S, the serialized second merely reuses S, and
  // cancelling the second then released a session — and idled a device — the
  // first call had already handed to the client. Ownership must come from the
  // acquisition path itself, per call.
  test("a cancelled acquisition keeps a session a concurrent sibling call minted", async () => {
    const sessionId = "cancel-guard-concurrent-session";
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    restoreAutolock = () => {
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-test",
      timer,
      undefined,
      new FakeDeviceUtils(),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const device = {
      name: "Pixel 8",
      platform: "android" as const,
      deviceId: "concurrent-android-1",
    };
    await pool.initializeWithDevices([device]);
    pool.notifyDeviceReady(device.deviceId);

    // Both requests are in flight — and have therefore already taken any
    // pre-call snapshot — before either one publishes an autolock session.
    const secondCallStarted = Promise.withResolvers<void>();
    const firstCallSettled = Promise.withResolvers<void>();

    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "getAndroid",
      "acquire",
      z.object({ which: z.string() }),
      async (args: { which: string }) => {
        if (args.which === "first") {
          await secondCallStarted.promise;
          const minted = await pool.autolockDevice(device.deviceId, "android", sessionId);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid: minted }) }],
          };
        }
        secondCallStarted.resolve();
        await firstCallSettled.promise;
        // Reuse, not mint: the sibling call already published this session.
        const reused = await pool.autolockDevice(device.deviceId, "android", sessionId);
        await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid: reused }) }],
        };
      },
      { defaultEnabled: true },
    );

    const firstCall = fixture.client.request(
      { method: "tools/call", params: { name: "getAndroid", arguments: { which: "first" } } },
      z.any(),
    );
    const secondCall = fixture.client.request(
      { method: "tools/call", params: { name: "getAndroid", arguments: { which: "second" } } },
      z.any(),
    );

    const firstResponse = await firstCall;
    const mintedPayload = JSON.parse(firstResponse.content[0].text);
    const mintedSessionUuid = mintedPayload.sessionUuid as string;
    expect(mintedSessionUuid).toBeTruthy();
    // Wire boundary: the ownership disposition is an internal, per-execution
    // channel and must never reach the client-visible acquisition result.
    expect(Object.keys(firstResponse)).not.toContain("__acquisitionOwnership");
    expect(Object.keys(mintedPayload).filter((key) => key.startsWith("__"))).toEqual([]);
    firstCallSettled.resolve();

    await expect(secondCall).rejects.toThrow(/cancelled during acquisition/);

    // The cancelled second call only reused this session; releasing it would
    // retire a handle the first call already returned to the client and idle
    // the device that call is still driving.
    expect(sessionManager.getSession(mintedSessionUuid)).not.toBeNull();
    expect(pool.getDevice(device.deviceId)).toMatchObject({
      status: "busy",
      sessionId: mintedSessionUuid,
    });
  });

  // The inverse interleaving of the case above: the MINTER is the call that is
  // cancelled, after a sibling acquisition already reused its session and
  // returned that handle to the client. The mint-time disposition alone says
  // "minted", so releasing on it retires a session the sibling is still using
  // and idles the device beneath it. Ownership must be fenced against reuse
  // that happened after the mint.
  test("a cancelled minter keeps a session a sibling call already reused", async () => {
    const sessionId = "cancel-guard-reused-after-mint-session";
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    restoreAutolock = () => {
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-test",
      timer,
      undefined,
      new FakeDeviceUtils(),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const device = {
      name: "Pixel 8",
      platform: "android" as const,
      deviceId: "reused-after-mint-android-1",
    };
    await pool.initializeWithDevices([device]);
    pool.notifyDeviceReady(device.deviceId);

    const minted = Promise.withResolvers<string>();
    const siblingReused = Promise.withResolvers<void>();

    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "getAndroid",
      "acquire",
      z.object({ which: z.string() }),
      async (args: { which: string }) => {
        if (args.which === "minter") {
          const sessionUuid = await pool.autolockDevice(device.deviceId, "android", sessionId);
          minted.resolve(sessionUuid);
          // The sibling reuses and returns this handle to the client while the
          // minter is still in its own gated-tools enrichment.
          await siblingReused.promise;
          await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid }) }],
          };
        }
        await minted.promise;
        const reused = await pool.autolockDevice(device.deviceId, "android", sessionId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid: reused }) }],
        };
      },
      { defaultEnabled: true },
    );

    const minterCall = fixture.client.request(
      { method: "tools/call", params: { name: "getAndroid", arguments: { which: "minter" } } },
      z.any(),
    );
    const siblingCall = fixture.client.request(
      { method: "tools/call", params: { name: "getAndroid", arguments: { which: "sibling" } } },
      z.any(),
    );

    const siblingResponse = await siblingCall;
    const mintedSessionUuid = await minted.promise;
    expect(JSON.parse(siblingResponse.content[0].text).sessionUuid).toBe(mintedSessionUuid);
    siblingReused.resolve();

    await expect(minterCall).rejects.toThrow(/cancelled during acquisition/);

    // The sibling already holds this handle: retiring it would strand the
    // client and idle the device it is still driving.
    expect(sessionManager.getSession(mintedSessionUuid)).not.toBeNull();
    expect(pool.getDevice(device.deviceId)).toMatchObject({
      status: "busy",
      sessionId: mintedSessionUuid,
    });
  });

  // A sibling ACQUISITION is not the only post-mint use of a published session:
  // `autolockDevice` publishes the mapping to the MCP connection, so any
  // ordinary device tool on that connection (`observe`, `tapOn`, ...) is
  // admitted onto the same session through
  // `ToolRegistry.resolveImplicitAutolockSession` without ever touching the
  // acquisition path. Cancelling the minter mid-enrichment must not retire the
  // session beneath that execution either.
  test("a cancelled minter keeps a session an ordinary tool call was admitted onto", async () => {
    const sessionId = "cancel-guard-implicit-admission-session";
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    restoreAutolock = () => {
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceUtils = new FakeDeviceUtils();
    const device = {
      name: "Pixel 8",
      platform: "android" as const,
      deviceId: "implicit-admission-android-1",
    };
    deviceUtils.setBootedDevices("android", [device]);
    const pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, deviceUtils);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.initializeWithDevices([device]);
    pool.notifyDeviceReady(device.deviceId);

    const minted = Promise.withResolvers<string>();
    const siblingAdmitted = Promise.withResolvers<void>();

    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    let observedSessionUuid: string | undefined;
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      z.object({ platform: z.string().optional(), sessionUuid: z.string().optional() }),
      async (_device: unknown, args: { sessionUuid?: string }) => {
        observedSessionUuid = args.sessionUuid;
        return { success: true };
      },
      // `booted` keeps this fake tool out of CtrlProxy/accessibility setup.
      { deviceReadiness: "booted" },
    );
    ToolRegistry.register(
      "getAndroid",
      "acquire",
      z.object({}),
      async () => {
        const sessionUuid = await pool.autolockDevice(device.deviceId, "android", sessionId);
        minted.resolve(sessionUuid);
        // The ordinary tool call is admitted onto the published session while
        // the minter is still in its own gated-tools enrichment.
        await siblingAdmitted.promise;
        await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid }) }],
        };
      },
      { defaultEnabled: true },
    );

    const minterCall = fixture.client.request(
      { method: "tools/call", params: { name: "getAndroid", arguments: {} } },
      z.any(),
    );

    const mintedSessionUuid = await minted.promise;
    // Pre-seed the keep-awake cache so the ordinary tool's context setup never
    // shells out to adb (this suite runs on fakes).
    sessionManager.setKeepScreenAwake(mintedSessionUuid, { applied: false, skipReason: "test" });
    await ToolRegistry.getTool("observe")!.handler({
      platform: "android",
      __mcpSessionId: sessionId,
    });
    expect(observedSessionUuid).toBe(mintedSessionUuid);
    siblingAdmitted.resolve();

    await expect(minterCall).rejects.toThrow(/cancelled during acquisition/);

    // An ordinary tool call already ran on this handle: retiring it would idle
    // the device underneath that execution.
    expect(sessionManager.getSession(mintedSessionUuid)).not.toBeNull();
    expect(pool.getDevice(device.deviceId)).toMatchObject({
      status: "busy",
      sessionId: mintedSessionUuid,
    });
  });

  test("a cancelled acquisition returns its pooled device to the pool", async () => {
    const sessionId = "cancel-guard-pooled-session";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-test",
      timer,
      undefined,
      new FakeDeviceUtils(),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const device = { name: "Pixel 8", platform: "android" as const, deviceId: "pooled-android-1" };
    await pool.initializeWithDevices([device]);
    pool.notifyDeviceReady(device.deviceId);

    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "getAndroid",
      "acquire",
      z.object({}),
      async () => {
        await pool.assignDeviceToSession("pooled-minted-session", "android");
        await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sessionUuid: "pooled-minted-session" }),
            },
          ],
        };
      },
      { defaultEnabled: true },
    );

    await expect(
      fixture.client.request(
        { method: "tools/call", params: { name: "getAndroid", arguments: {} } },
        z.any(),
      ),
    ).rejects.toThrow(/cancelled during acquisition/);

    // Releasing only the session leaves the pooled device busy forever: the
    // client never learned the UUID, so nothing can ever call releaseDevice.
    expect(pool.getDevice(device.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });

  test("a cancelled acquisition drops its direct-session mapping in direct mode", async () => {
    const sessionId = "cancel-guard-direct-session";
    clearDirectSessionDevices();
    // Direct (non-daemon) mode: no SessionManager to release through, so the
    // process-local direct-session registry is the only thing that keeps the
    // cancelled UUID resolvable.
    expect(DaemonState.getInstance().isInitialized()).toBe(false);

    fixture = new McpTestFixture({ sessionContext: { sessionId } });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "getAndroid",
      "acquire",
      z.object({}),
      async () => {
        registerDirectSessionDevice("direct-minted-session", {
          platform: "android",
          name: "Pixel_9",
          deviceId: "emulator-5554",
        });
        await executionTracker.cancelSessionExecutions(sessionId, "test-cancel");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sessionUuid: "direct-minted-session" }),
            },
          ],
        };
      },
      { defaultEnabled: true },
    );

    await expect(
      fixture.client.request(
        { method: "tools/call", params: { name: "getAndroid", arguments: {} } },
        z.any(),
      ),
    ).rejects.toThrow(/cancelled during acquisition/);

    expect(resolveDirectSessionDevice("direct-minted-session")).toBeUndefined();
  });
});
