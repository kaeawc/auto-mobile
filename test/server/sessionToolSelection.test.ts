import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

describe("per-session exact-tool selection", () => {
  let fixture: McpTestFixture | undefined;

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
  });

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
