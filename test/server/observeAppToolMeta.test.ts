import { describe, test, expect, beforeEach } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { OBSERVE_APP_RESOURCE_URI } from "../../src/server/observeAppResource";
import { z } from "zod/v4";

describe("tool → MCP App UI association via _meta.ui.resourceUri", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  test("getToolDefinitions emits _meta.ui.resourceUri when appUiResourceUri is set", () => {
    ToolRegistry.registerDeviceAware(
      "dummyApp",
      "desc",
      z.object({}),
      async () => ({ content: [] }),
      { appUiResourceUri: OBSERVE_APP_RESOURCE_URI }
    );
    const def = ToolRegistry.getToolDefinitions().find(d => d.name === "dummyApp");
    expect((def as { _meta?: { ui?: { resourceUri?: string } } })?._meta?.ui?.resourceUri).toBe(
      OBSERVE_APP_RESOURCE_URI
    );
  });

  test("a tool registered without the option carries no ui _meta", () => {
    ToolRegistry.registerDeviceAware("plain", "desc", z.object({}), async () => ({ content: [] }));
    const def = ToolRegistry.getToolDefinitions().find(d => d.name === "plain");
    expect((def as { _meta?: { ui?: unknown } })?._meta?.ui).toBeUndefined();
  });

  test("the observe tool advertises ui://automobile/observe", () => {
    registerObserveTools();
    const observe = ToolRegistry.getToolDefinitions().find(d => d.name === "observe");
    expect(observe).toBeDefined();
    expect((observe as { _meta?: { ui?: { resourceUri?: string } } })?._meta?.ui?.resourceUri).toBe(
      OBSERVE_APP_RESOURCE_URI
    );
  });
});
