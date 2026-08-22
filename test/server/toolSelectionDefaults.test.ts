import { afterEach, describe, expect, test } from "bun:test";
import { configureToolSelectionCliDefaults } from "../../src/features/toolSelection/SessionToolSelectionService";
import { createMcpServer, registerMcpTools } from "../../src/server";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("tool selection default declarations", () => {
  afterEach(() => {
    configureToolSelectionCliDefaults([], []);
    ToolRegistry.clearTools();
  });

  test("every production tool declares its built-in selection default", () => {
    ToolRegistry.clearTools();
    createMcpServer();
    expect(ToolRegistry.getToolsMissingDeclaredDefault()).toEqual([]);
  });

  test("tool registration rejects unknown startup defaults before creating a server", () => {
    configureToolSelectionCliDefaults(["typo"], []);

    expect(() => registerMcpTools(false)).toThrow(
      "Unknown tool name 'typo' in AutoMobile tool defaults.",
    );
  });
});
