import { getDisplayName, specTypeSchemas } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, test } from "bun:test";
import catalog from "../../schemas/tool-definitions.json";
import {
  getConnectedStaticToolDefinitions,
  getStaticToolDefinitions,
} from "../../src/daemon/staticToolDefinitions";
import { registerAllTools } from "../../src/server/registerAllTools";
import { TOOL_ANNOTATIONS } from "../../src/server/toolAnnotations";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";

isolateEmptyToolRegistry();

describe("MCP tool annotations", () => {
  let definitions: ReturnType<typeof ToolRegistry.getToolDefinitions>;
  let registeredNames: string[];

  beforeAll(async () => {
    // Match the generator, including debug, plan, embedded-SDK and session tools.
    registerAllTools({ daemonMode: true });
    definitions = ToolRegistry.getToolDefinitions({
      includeUnavailable: true,
      suppressOutputSchema: false,
    });
    // Doctor is CLI-only and intentionally absent from the MCP static catalog.
    registerAllTools({ daemonMode: true, includeDoctor: true });
    registeredNames = ToolRegistry.getEveryRegisteredTool()
      .map((tool) => tool.name)
      .sort();
    // Pay the SDK's lazy validator initialization outside the unit-test budget.
    await specTypeSchemas.ToolAnnotations["~standard"].validate({});
  });

  test("classification covers all real registrations in both directions", () => {
    const annotatedNames = Object.keys(TOOL_ANNOTATIONS);
    expect({
      missing: registeredNames.filter((name) => !annotatedNames.includes(name)),
      extra: annotatedNames.filter((name) => !registeredNames.includes(name)).sort(),
    }).toEqual({ missing: [], extra: [] });
    expect(definitions.map((tool) => tool.name).sort()).toEqual(
      catalog.map((tool) => tool.name).sort(),
    );
  });

  test.each([
    ["observe", "Observe Screen", true, false],
    ["listDevices", "List Devices", true, false],
    ["uninstallApp", "Uninstall App", false, true],
    ["installApp", "Install App", false, true],
    ["changeLocalization", "Change Locale", false, true],
    ["explore", "Explore Screens", false, true],
    ["navigateTo", "Navigate to Screen", false, true],
    ["killDevice", "Kill Device", false, true],
    ["videoRecording", "Record Video", false, false],
    ["setPreference", "Set Preference", false, true],
    ["biometricAuth", "Simulate Biometrics", false, true],
  ] as const)(
    "live tools/list publishes %s metadata",
    (name, title, readOnlyHint, destructiveHint) => {
      const tool = definitions.find((definition) => definition.name === name);
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error(`Missing tool: ${name}`);
      }
      expect(tool.title).toBe(title);
      expect(tool.annotations?.readOnlyHint === true).toBe(readOnlyHint);
      if (readOnlyHint) {
        expect(tool.annotations).not.toHaveProperty("destructiveHint");
      } else {
        expect(tool.annotations?.destructiveHint).toBe(destructiveHint);
      }
      expect(getDisplayName(tool)).toBe(title);
    },
  );

  test("every catalog annotation validates against the SDK ToolAnnotations contract", async () => {
    for (const definition of definitions) {
      expect(definition.title, definition.name).toBeString();
      expect(definition.annotations, definition.name).toBeDefined();
      const validation = await specTypeSchemas.ToolAnnotations["~standard"].validate(
        definition.annotations,
      );
      expect(validation.issues, definition.name).toBeUndefined();
      expect(definition.annotations).toEqual(TOOL_ANNOTATIONS[definition.name].annotations);
    }
  });

  test.each([false, true])("static proxy preserves metadata (connected=%s)", (connected) => {
    const tools = connected
      ? getConnectedStaticToolDefinitions({ debug: true, embeddedSdk: true })
      : getStaticToolDefinitions();
    for (const tool of tools) {
      expect(tool, tool.name).toMatchObject(TOOL_ANNOTATIONS[tool.name]);
    }
    expect(tools.some((tool) => tool.name === "observe")).toBe(true);
  });

  test("read-only hints match unconditional registration classifications, including mixed tools", () => {
    // Both register()'s readOnly and registerDeviceAware()'s deviceReadOnly are
    // normalized to RegisteredTool.deviceReadOnly; function classifiers are mixed.
    // Host-write exemption: record mode overwrites a host baseline although the tool
    // is safe to run against a held device (deviceReadOnly).
    const hostWriters = new Set(["compareScreenshot"]);
    for (const tool of ToolRegistry.getEveryRegisteredTool()) {
      expect(TOOL_ANNOTATIONS[tool.name].annotations.readOnlyHint === true, tool.name).toBe(
        tool.deviceReadOnly === true && !hostWriters.has(tool.name),
      );
    }
  });

  test("input tools conservatively advertise destructive app actions", () => {
    for (const name of [
      "tapOn",
      "tapAt",
      "tapAny",
      "swipeOn",
      "swipeAt",
      "dragAndDrop",
      "dragPath",
      "multiTouch",
      "pinchOn",
      "pressButton",
      "keyboard",
    ]) {
      expect(TOOL_ANNOTATIONS[name].annotations, name).toEqual({ destructiveHint: true });
    }
    expect(TOOL_ANNOTATIONS.setPreference.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(TOOL_ANNOTATIONS.setActiveDevice.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("wire hints omit defaults and meaningless read-only fields, with explicit control destructiveness", () => {
    for (const { annotations } of Object.values(TOOL_ANNOTATIONS)) {
      expect(annotations).not.toHaveProperty("title");
      expect(annotations.readOnlyHint).not.toBe(false);
      expect(annotations.idempotentHint).not.toBe(false);
      expect(annotations.openWorldHint).not.toBe(true);
      if (annotations.readOnlyHint === true) {
        expect(annotations).not.toHaveProperty("destructiveHint");
        expect(annotations).not.toHaveProperty("idempotentHint");
      } else {
        expect(annotations.destructiveHint).toBeBoolean();
      }
    }
  });

  test("full tools/list catalog with output schemas adds about 1% metadata bytes", () => {
    expect(definitions.some((tool) => tool.outputSchema)).toBe(true);
    // The catalog sat at 0.997% with 250 bytes of headroom, so each small new tool
    // (about 90 metadata bytes) tips it past 1.00%; 1.1% leaves room for several.
    expect(metadataOverhead(definitions)).toBeLessThan(0.011);
  });

  test("cold proxy tools/list without output schemas has a documented metadata budget exception", () => {
    const coldProxyTools = getStaticToolDefinitions();
    expect(coldProxyTools.every((tool) => !("outputSchema" in tool))).toBe(true);
    // Without large output schemas, minimal metadata can exceed 1% of the payload;
    // preserve a 2% ceiling.
    const ratio = metadataOverhead(coldProxyTools);
    expect(ratio).toBeLessThan(0.02);
  });
});

function metadataOverhead(tools: readonly { title?: string; annotations?: unknown }[]): number {
  const withoutMetadata = tools.map(
    ({ title: _title, annotations: _annotations, ...tool }) => tool,
  );
  const oldBytes = Buffer.byteLength(JSON.stringify({ tools: withoutMetadata }));
  const newBytes = Buffer.byteLength(JSON.stringify({ tools }));
  return (newBytes - oldBytes) / oldBytes;
}
