import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import {
  createToolCatalogResourceHandler,
  type ToolCatalogResourceDependencies,
} from "../../../src/server/toolCatalogResource";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { ToolRegistry } from "../../../src/server/toolRegistry";

const configurableTools = () =>
  ToolRegistry.getAllTools().filter((tool) => ToolRegistry.isUserConfigurableTool(tool.name));

function registerCatalogTools(): void {
  ToolRegistry.register(
    "catalogDefaultEnabled",
    "enabled catalog tool",
    z.object({}),
    async () => ({}),
    {
      defaultEnabled: true,
    },
  );
  ToolRegistry.register(
    "catalogDefaultGated",
    "gated catalog tool",
    z.object({}),
    async () => ({}),
    {
      defaultEnabled: false,
    },
  );
  ToolRegistry.register("catalogHidden", "hidden catalog tool", z.object({}), async () => ({}), {
    hidden: true,
  });
}

async function read(dependencies: ToolCatalogResourceDependencies) {
  const content = await createToolCatalogResourceHandler(dependencies)();
  return JSON.parse(content.text!);
}

describe("tool catalog resource", () => {
  beforeEach(() => {
    ResourceRegistry.clearResources();
    ToolRegistry.clearTools();
    registerCatalogTools();
  });
  afterEach(() => {
    ResourceRegistry.clearResources();
    ToolRegistry.clearTools();
  });

  test("lists every configurable tool exactly once using the injected no-session policy", async () => {
    const enabledNames = new Set(
      configurableTools()
        .filter((_, index) => index % 2 === 0)
        .map((tool) => tool.name),
    );
    const isEnabled = async (
      _sessionUuid: string | undefined,
      toolName: string,
      _declaredDefault: boolean,
    ) => enabledNames.has(toolName);

    const payload = await read({
      now: () => new Date("2026-09-19T12:00:00.000Z"),
      sessionToolSelectionService: { isEnabled },
    });

    const expectedNames = configurableTools()
      .map((tool) => tool.name)
      .sort();
    expect(payload.lastUpdated).toBe("2026-09-19T12:00:00.000Z");
    expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual(expectedNames);
    expect(new Set(payload.tools.map((tool: { name: string }) => tool.name)).size).toBe(
      expectedNames.length,
    );
    for (const tool of payload.tools as Array<{
      name: string;
      enabledWithoutSession: boolean;
      requiresDeviceSession: boolean;
    }>) {
      expect(tool.enabledWithoutSession).toBe(enabledNames.has(tool.name));
      expect(tool.requiresDeviceSession).toBe(!enabledNames.has(tool.name));
    }
  });

  test("matches the acquisition-time default-enabled policy without querying a session repository", async () => {
    const service = new SessionToolSelectionService({
      list: async () => {
        throw new Error("no-session policy must not query the repository");
      },
      set: async () => {},
      deleteSession: async () => {},
    });
    const tools = configurableTools();
    const expectedEnabledNames = new Set(
      await Promise.all(
        tools.map(async (tool) => {
          const enabled = await service.isEnabled(undefined, tool.name, tool.defaultEnabled);
          return enabled ? tool.name : undefined;
        }),
      ).then((names) => names.filter((name): name is string => name !== undefined)),
    );

    const payload = await read({
      now: () => new Date("2026-09-19T12:00:00.000Z"),
      sessionToolSelectionService: service,
    });

    expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual(
      tools.map((tool) => tool.name).sort(),
    );
    for (const tool of payload.tools as Array<{
      name: string;
      enabledWithoutSession: boolean;
      requiresDeviceSession: boolean;
    }>) {
      expect(tool.enabledWithoutSession).toBe(expectedEnabledNames.has(tool.name));
      expect(tool.requiresDeviceSession).toBe(!expectedEnabledNames.has(tool.name));
    }
  });
});
