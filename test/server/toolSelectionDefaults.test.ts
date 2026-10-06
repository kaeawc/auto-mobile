import { afterEach, describe, expect, test } from "bun:test";
import {
  configureToolSelectionCliDefaults,
  validateConfiguredToolSelectionDefaults,
} from "../../src/features/toolSelection/SessionToolSelectionService";
import { registerMcpTools } from "../../src/server";
import definitions from "../../schemas/tool-definitions.json";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("tool selection default declarations", () => {
  afterEach(() => {
    configureToolSelectionCliDefaults([], []);
    ToolRegistry.clearTools();
  });

  test("every production tool declares its built-in selection default", () => {
    ToolRegistry.clearTools();
    registerMcpTools(false);
    expect(ToolRegistry.getToolsMissingDeclaredDefault()).toEqual([]);
    for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
      expect(ToolRegistry.getRegisteredTool(name)).toBeUndefined();
      expect(ToolRegistry.getToolDefinitions().some((tool) => tool.name === name)).toBe(false);
    }
  });

  test("CLI registration and generated definitions omit removed shared-storage tools", () => {
    ToolRegistry.clearTools();
    initializeCliTools();
    for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
      expect(ToolRegistry.getRegisteredTool(name)).toBeUndefined();
      expect(definitions.some((tool) => tool.name === name)).toBe(false);
    }
    expect(definitions.some((tool) => tool.name === "putAppFile")).toBe(true);
    expect(definitions.some((tool) => tool.name === "stageSessionDownloads")).toBe(true);
  });

  test("tool registration rejects unknown startup defaults before creating a server", () => {
    configureToolSelectionCliDefaults(["typo"], []);

    expect(() => registerMcpTools(false)).toThrow(
      "Tool 'typo' is not a session-configurable tool name; CLI startup defaults (--enable-tool/--disable-tool) accept session-configurable tools only (see the automobile:tools resource).",
    );
  });

  test("daemon startup validates inherited shared tool defaults", () => {
    configureToolSelectionCliDefaults([], []);

    expect(() =>
      validateConfiguredToolSelectionDefaults(new Set(["observe"]), {
        AUTOMOBILE_ENABLED_TOOLS: "not-a-tool",
      }),
    ).toThrow(
      "Tool 'not-a-tool' is not a session-configurable tool name; AUTOMOBILE_ENABLED_TOOLS/AUTOMOBILE_DISABLED_TOOLS accept session-configurable tools only (see the automobile:tools resource).",
    );
  });
});
