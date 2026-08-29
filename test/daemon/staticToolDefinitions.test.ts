import { afterEach, describe, expect, test } from "bun:test";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";

// Issue #5879 / Codex review: the static cold-start surface must mirror the
// runtime `ToolRegistry.getToolDefinitions()` shape, not just carry names.

describe("getStaticToolDefinitions", () => {
  const originalAlwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS;

  afterEach(() => {
    if (originalAlwaysLoad === undefined) {
      delete process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS;
    } else {
      process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS = originalAlwaysLoad;
    }
  });

  test("preserves _meta (the MCP Apps UI pointer) for tools that carry it", () => {
    const observe = getStaticToolDefinitions().find((tool) => tool.name === "observe");
    expect(observe).toBeDefined();
    expect(observe!._meta).toEqual({ ui: { resourceUri: "ui://automobile/observe" } });
  });

  test("advertises outputSchema by default", () => {
    const withOutput = getStaticToolDefinitions().filter((tool) => tool.outputSchema !== undefined);
    expect(withOutput.length).toBeGreaterThan(0);
  });

  test("drops outputSchema when suppressOutputSchema is set", () => {
    const anyOutputSchema = getStaticToolDefinitions({ suppressOutputSchema: true }).some(
      (tool) => tool.outputSchema !== undefined,
    );
    expect(anyOutputSchema).toBe(false);
    // _meta and names are unaffected by suppression.
    const observe = getStaticToolDefinitions({ suppressOutputSchema: true }).find(
      (tool) => tool.name === "observe",
    );
    expect(observe!._meta).toEqual({ ui: { resourceUri: "ui://automobile/observe" } });
  });

  test("synthesizes _meta.anthropic/alwaysLoad when AUTOMOBILE_ALWAYS_LOAD_TOOLS=true", () => {
    process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS = "true";
    const tools = getStaticToolDefinitions();
    for (const tool of tools) {
      expect(tool._meta?.["anthropic/alwaysLoad"]).toBe(true);
    }
    // Existing _meta is merged, not overwritten.
    const observe = tools.find((tool) => tool.name === "observe");
    expect(observe!._meta).toEqual({
      ui: { resourceUri: "ui://automobile/observe" },
      "anthropic/alwaysLoad": true,
    });
  });

  test("omits alwaysLoad meta when the env is unset", () => {
    delete process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS;
    const tools = getStaticToolDefinitions();
    expect(tools.some((tool) => tool._meta?.["anthropic/alwaysLoad"] !== undefined)).toBe(false);
    // A tool with no other _meta carries none at all.
    const accessibility = tools.find((tool) => tool.name === "accessibility");
    expect(accessibility!._meta).toBeUndefined();
  });

  test("every definition carries a name and an input schema", () => {
    const tools = getStaticToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.inputSchema).toBe("object");
    }
  });
});
