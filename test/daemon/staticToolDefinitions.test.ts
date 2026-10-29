import { anyDeviceReadOnlyArgShapeMatches } from "../../src/daemon/deviceReadOnlyArgShapes";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerPrototypeTools } from "../../src/server/prototypeTools";
import { registerAccessibilityTools } from "../../src/server/accessibilityTools";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  getStaticToolDefinitions,
  getConnectedStaticToolDefinitions,
  staticToolDeclaresDeviceResourceBudget,
  staticToolDeclaresInput,
} from "../../src/daemon/staticToolDefinitions";
import type { ProxiedToolDefinition } from "../../src/daemon/daemonMcpProxy";
import committedDefinitions from "../../schemas/tool-definitions.json";

// Issue #5879 / review: the static cold-start surface mirrors the runtime
// `ToolRegistry.getToolDefinitions()` shape for the flag-independent fields
// (name, description, inputSchema, _meta) and deliberately omits outputSchema,
// which depends on daemon flag state the proxy cannot read cold.

isolateToolRegistry();

describe("getStaticToolDefinitions", () => {
  beforeAll(() => {
    registerInteractionTools();
    registerPrototypeTools();
    registerAccessibilityTools();
    registerUtilityTools();
  });
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
    const expected = committedDefinitions.map((tool): ProxiedToolDefinition => {
      const definition: ProxiedToolDefinition = { ...tool };
      delete definition.outputSchema;
      const meta: Record<string, unknown> = { ...tool._meta };
      delete meta["automobile/debugOnly"];
      delete meta["automobile/embeddedSdkOnly"];
      delete meta["automobile/planOnly"];
      delete meta["automobile/deviceResourceBudget"];
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
    const tapOn = tools.find((tool) => tool.name === "tapOn");
    expect(tapOn!._meta).toBeUndefined();
  });

  test("#10971: device-read tools carry the read classification; control and mixed tools do not", () => {
    const readOnly = (name: string) =>
      getStaticToolDefinitions().find((tool) => tool.name === name)?._meta?.[
        "automobile/deviceReadOnly"
      ] === true;
    // Pure reads, including the owner-listed ones (#10965).
    for (const name of [
      "observe",
      "snapshotOf",
      "listApps",
      "getDeviceState",
      "hitTest",
      "identifyInteractions",
      "getAppPermissions",
      "getDeepLinks",
    ]) {
      expect(readOnly(name)).toBe(true);
      expect(
        getStaticToolDefinitions().find((tool) => tool.name === name)?._meta?.[
          "automobile/deviceReadOnlyArgs"
        ],
      ).toBeUndefined();
    }
    // Control and mixed tools never advertise the wholly read-only boolean.
    for (const name of [
      "tapOn",
      "pressButton",
      "sqlQuery",
      "keyboard",
      "clipboard",
      "displayConfig",
      "accessibility",
      "prototype",
    ]) {
      expect(readOnly(name)).toBe(false);
    }
  });

  test("mixed tools advertise only their declarative read argument shapes", () => {
    const shapes = {
      clipboard: [{ argument: "action", values: ["get"] }],
      keyboard: [{ argument: "action", values: ["detect", "listImes", "listProfiles"] }],
      prototype: [
        {
          argument: "action",
          values: [
            "status",
            "inspect",
            "listSaved",
            "screenMap",
            "testSessionBegin",
            "testSessionEnd",
            "testSessionReport",
            "defineBackend",
            "clearBackend",
            "backendLog",
          ],
        },
      ],
      accessibility: [{ absentArguments: ["talkback", "voiceover"] }],
      displayConfig: [
        {
          absentArguments: [
            "reset",
            "fontScale",
            "contentSize",
            "density",
            "theme",
            "size",
            "navigationMode",
            "displayCutout",
            "increaseContrast",
            "reduceMotion",
            "boldText",
            "colorInversion",
            "colorCorrection",
            "magnification",
            "magnificationScale",
            "extraDim",
          ],
        },
      ],
    };
    for (const [name, expected] of Object.entries(shapes)) {
      const meta = getStaticToolDefinitions().find((tool) => tool.name === name)?._meta;
      expect(meta?.["automobile/deviceReadOnlyArgs"]).toEqual(expected);
      expect(meta?.["automobile/deviceReadOnly"]).toBeUndefined();
    }
    expect(
      getStaticToolDefinitions().find((tool) => tool.name === "sqlQuery")?._meta?.[
        "automobile/deviceReadOnlyArgs"
      ],
    ).toBeUndefined();
  });

  test("every advertised shape is a subset of the registered per-call classifier", () => {
    const registered = ToolRegistry.getAllTools({ includeUnavailable: true });
    let advertised = 0;
    for (const tool of registered) {
      for (const shape of tool.deviceReadOnlyArgs ?? []) {
        advertised++;
        const representatives =
          "argument" in shape ? shape.values.map((value) => ({ [shape.argument]: value })) : [{}];
        expect(representatives.length).toBeGreaterThan(0);
        for (const args of representatives) {
          expect(anyDeviceReadOnlyArgShapeMatches([shape], args)).toBe(true);
          expect(tool.isDeviceReadOnlyCall?.(args)).toBe(true);
        }
      }
    }
    expect(advertised).toBe(5);
    for (const [name, args] of [
      ["clipboard", { action: "set" }],
      ["keyboard", { action: "open" }],
      ["prototype", { action: "show" }],
      ["accessibility", { talkback: true }],
      ["displayConfig", { fontScale: 1.2 }],
    ] as const) {
      const tool = registered.find((candidate) => candidate.name === name)!;
      expect(anyDeviceReadOnlyArgShapeMatches(tool.deviceReadOnlyArgs, args)).toBe(false);
      expect(tool.isDeviceReadOnlyCall?.(args)).toBe(false);
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

describe("staticToolDeclaresInput", () => {
  test.each(["killDevice", "deleteDevice"])("%s declares a force input", (tool) => {
    expect(staticToolDeclaresInput(tool, "force")).toBe(true);
  });

  test("a tool without the property, an unknown property and an unknown tool all read false", () => {
    expect(staticToolDeclaresInput("tapOn", "force")).toBe(false);
    expect(staticToolDeclaresInput("killDevice", "noSuchInput")).toBe(false);
    expect(staticToolDeclaresInput("noSuchTool", "force")).toBe(false);
  });
});

describe("staticToolDeclaresDeviceResourceBudget (#15672)", () => {
  test("the device-resource tools declare the budget trait in the committed definitions", () => {
    expect(staticToolDeclaresDeviceResourceBudget("setDeviceResources")).toBe(true);
    expect(staticToolDeclaresDeviceResourceBudget("reconcileDeviceResources")).toBe(true);
  });

  test("other tools, including those with a timeoutMs input, do not declare it", () => {
    expect(staticToolDeclaresDeviceResourceBudget("startDevice")).toBe(false);
    expect(staticToolDeclaresDeviceResourceBudget("provisionDevice")).toBe(false);
    expect(staticToolDeclaresDeviceResourceBudget("tapOn")).toBe(false);
    expect(staticToolDeclaresDeviceResourceBudget("noSuchTool")).toBe(false);
  });

  test("the trait key is internal and never leaves the cold wire payload", () => {
    for (const tools of [getStaticToolDefinitions(), getConnectedStaticToolDefinitions()]) {
      for (const tool of tools) {
        expect(Object.hasOwn(tool._meta ?? {}, "automobile/deviceResourceBudget")).toBe(false);
      }
    }
  });
});
