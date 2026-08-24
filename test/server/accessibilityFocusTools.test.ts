import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerAccessibilityFocusTools } from "../../src/server/accessibilityFocusTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

/**
 * accessibilityFocus is a debug-only device-aware tool. `getTool`/the default
 * listing gate on availability (which is false for a debugOnly tool when --debug
 * is off), so it must be resolved via getAllTools({ includeUnavailable: true }).
 */
describe("accessibilityFocusTools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  function focusTool() {
    return ToolRegistry.getAllTools({ includeUnavailable: true }).find(
      (t) => t.name === "accessibilityFocus",
    );
  }

  test("registers the accessibilityFocus device-aware tool", () => {
    registerAccessibilityFocusTools();

    const tool = focusTool();
    expect(tool).toBeDefined();
    expect(tool!.requiresDevice).toBe(true);
    expect(tool!.deviceAwareHandler).toBeDefined();
  });

  test("marks the tool debugOnly", () => {
    registerAccessibilityFocusTools();

    expect(focusTool()!.debugOnly).toBe(true);
  });

  test("hides the tool from the default (non-debug) listing", () => {
    registerAccessibilityFocusTools();

    // With --debug off a debugOnly tool is unavailable, so it is absent from the
    // default listing and from getToolDefinitions but present when unavailable
    // tools are included. Removing the debugOnly flag would leak it to every
    // client.
    const defaultNames = ToolRegistry.getAllTools().map((t) => t.name);
    const allNames = ToolRegistry.getAllTools({ includeUnavailable: true }).map((t) => t.name);
    const advertisedNames = ToolRegistry.getToolDefinitions().map((t) => t.name);

    expect(allNames).toContain("accessibilityFocus");
    expect(defaultNames).not.toContain("accessibilityFocus");
    expect(advertisedNames).not.toContain("accessibilityFocus");
  });
});
