import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";

/**
 * `criticalSection` and `barrier` have two independent gates:
 *  1. daemon-only registration — only registered in daemon mode (they rely on
 *     the daemon's cross-process lock coordinator).
 *  2. plan-only discovery gate — even in daemon mode they are hidden from normal
 *     MCP discovery (`getTool` / `tools/list`) because a single direct call would
 *     just block; they are runnable only as plan steps via `getToolForPlan`.
 * Pin both so neither can silently regress into the interactive tool surface.
 */
describe("criticalSection / barrier registration + plan-only discovery gate", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterAll(() => {
    // Leave a clean registry for any later suite in the same process.
    ToolRegistry.clearTools();
  });

  test("stdio mode registers neither criticalSection nor barrier at all", () => {
    registerMcpTools(false);

    // Sanity: non-gated tools are present, so registration actually ran.
    expect(ToolRegistry.getTool("observe")).toBeDefined();

    // Not registered in stdio mode — absent from both discovery and plan lookup.
    expect(ToolRegistry.getTool("criticalSection")).toBeUndefined();
    expect(ToolRegistry.getTool("barrier")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("criticalSection")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("barrier")).toBeUndefined();
  });

  test("daemon mode registers them plan-only: hidden from discovery, resolvable for plans", () => {
    registerMcpTools(true);

    // Hidden from normal MCP discovery (getTool honors the plan-only gate)...
    expect(ToolRegistry.getTool("criticalSection")).toBeUndefined();
    expect(ToolRegistry.getTool("barrier")).toBeUndefined();

    // ...and therefore absent from the advertised tools/list.
    const advertised = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(advertised).not.toContain("criticalSection");
    expect(advertised).not.toContain("barrier");

    // ...but still resolvable for plan execution (they are planExecutable).
    expect(ToolRegistry.getToolForPlan("criticalSection")).toBeDefined();
    expect(ToolRegistry.getToolForPlan("barrier")).toBeDefined();
  });
});
