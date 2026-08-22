import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../../src/server";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("tool selection default declarations", () => {
  test("every production tool declares its built-in selection default", () => {
    ToolRegistry.clearTools();
    createMcpServer();
    expect(ToolRegistry.getToolsMissingDeclaredDefault()).toEqual([]);
  });
});
