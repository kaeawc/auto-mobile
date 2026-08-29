import { afterEach, describe, expect, test } from "bun:test";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { serverConfig } from "../../src/utils/ServerConfig";

// Issue #5879 / Codex review: the static cold-start surface must mirror the
// runtime `ToolRegistry.getToolDefinitions()` shape, not just carry names.

describe("getStaticToolDefinitions", () => {
  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
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

  test("drops outputSchema when toolResultsNoStructuredContent is enabled", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const anyOutputSchema = getStaticToolDefinitions().some(
      (tool) => tool.outputSchema !== undefined,
    );
    expect(anyOutputSchema).toBe(false);
    // _meta and names are unaffected by the flag.
    const observe = getStaticToolDefinitions().find((tool) => tool.name === "observe");
    expect(observe!._meta).toEqual({ ui: { resourceUri: "ui://automobile/observe" } });
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
