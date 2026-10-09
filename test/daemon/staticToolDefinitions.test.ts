import { afterEach, describe, expect, test } from "bun:test";
import {
  getStaticToolDefinitions,
  getConnectedStaticToolDefinitions,
} from "../../src/daemon/staticToolDefinitions";
import committedDefinitions from "../../schemas/tool-definitions.json";

// Issue #5879 / review: the static cold-start surface mirrors the runtime
// `ToolRegistry.getToolDefinitions()` shape for the flag-independent fields
// (name, description, inputSchema, _meta) and deliberately omits outputSchema,
// which depends on daemon flag state the proxy cannot read cold.

describe("getStaticToolDefinitions", () => {
  const originalAlwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS;

  afterEach(() => {
    if (originalAlwaysLoad === undefined) {
      delete process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS;
    } else {
      process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS = originalAlwaysLoad;
    }
  });

  test("cold and connected static lists never emit an outputSchema key", () => {
    for (const tools of [
      getStaticToolDefinitions(),
      getConnectedStaticToolDefinitions(),
      getConnectedStaticToolDefinitions({ debug: true, embeddedSdk: true }),
    ]) {
      expect(tools.every((tool) => !Object.hasOwn(tool, "outputSchema"))).toBe(true);
    }
  });

  test("cold wire payload equals committed definitions with only the established omissions", () => {
    delete process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS;
    const expected = committedDefinitions.map((tool) => {
      const definition: Record<string, unknown> = { ...tool };
      delete definition.outputSchema;
      const meta: Record<string, unknown> = { ...tool._meta };
      delete meta["automobile/debugOnly"];
      delete meta["automobile/embeddedSdkOnly"];
      delete meta["automobile/planOnly"];
      if (Object.keys(meta).length) {
        definition._meta = meta;
      } else {
        delete definition._meta;
      }
      return definition;
    });
    expect(getStaticToolDefinitions()).toEqual(expected);
  });

  test("preserves _meta (the MCP Apps UI pointer) for tools that carry it", () => {
    const observe = getStaticToolDefinitions().find((tool) => tool.name === "observe");
    expect(observe).toBeDefined();
    expect(observe!._meta).toEqual({
      ui: { resourceUri: "ui://automobile/observe" },
      "automobile/deviceReadOnly": true,
    });
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
      "automobile/deviceReadOnly": true,
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

  test("#10971: device-read tools carry the read classification; control and mixed tools do not", () => {
    const readOnly = (name: string) =>
      getStaticToolDefinitions().find((tool) => tool.name === name)?._meta?.[
        "automobile/deviceReadOnly"
      ] === true;
    for (const name of ["observe", "snapshotOf", "listApps", "getDeviceState"]) {
      expect(readOnly(name)).toBe(true);
    }
    // sqlQuery is read-only only for some statements, so it keeps the session fence.
    for (const name of ["tapOn", "pressButton", "identifyInteractions", "sqlQuery"]) {
      expect(readOnly(name)).toBe(false);
    }
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
