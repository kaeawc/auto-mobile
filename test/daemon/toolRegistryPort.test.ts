import { describe, expect, test } from "bun:test";
import { daemonToolRegistry } from "../../src/daemon/toolRegistryPort";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("daemon tool registry port", () => {
  test("the server tool registry installs itself when it loads", () => {
    expect(daemonToolRegistry().isUserConfigurableTool("observe")).toBe(
      ToolRegistry.isUserConfigurableTool("observe"),
    );
  });
});
