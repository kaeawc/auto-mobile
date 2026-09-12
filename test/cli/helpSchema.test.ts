import { sendKeysSchema } from "../../src/server/interactionTools";

import { getDeviceStateSchema } from "../../src/server/utilityTools";

import { runCliCommand, parseCliArgs, type CliOutput } from "../../src/cli";
import { ToolRegistry } from "../../src/server/toolRegistry";

import { z } from "zod/v4";

import { describe, expect, test } from "bun:test";
import { getCliHelpParameterInfo, getCliHelpSchemaShape } from "../../src/cli";
import { launchAppSchema } from "../../src/server/appTools";
import { waitForSchema } from "../../src/server/observeTools";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";

describe("getCliHelpSchemaShape", () => {
  test("unwraps aliased preprocess schemas for CLI parameter help", () => {
    const shape = getCliHelpSchemaShape(launchAppSchema);

    expect(shape).toBeDefined();
    expect(shape?.appId).toBeDefined();
    expect(shape?.clearAppData).toBeDefined();
    expect(shape?.coldBoot).toBeDefined();

    expect(getCliHelpParameterInfo(shape?.appId)).toMatchObject({
      isOptional: false,
      typeName: "string",
    });
    expect(getCliHelpParameterInfo(shape?.clearAppData)).toMatchObject({
      isOptional: true,
      typeName: "boolean",
      description: "Clear app data before launch (default false)",
    });
  });
});

describe("structured CLI parameter help", () => {
  test("renders parameter maps with their accepted value types", () => {
    expect(getCliHelpParameterInfo(z.record(z.string(), z.any())).typeName).toBe(
      "JSON { [key: string]: any }",
    );
    expect(getCliHelpParameterInfo(z.record(z.string(), z.number())).typeName).toBe(
      "JSON { [key: string]: number }",
    );
  });
  test("preserves legacy observe predicate intersections", () => {
    const type = getCliHelpParameterInfo(waitForSchema).typeName;
    expect(type).toContain('"activeWindow"');
    expect(type).toContain(" & ");
    expect(type).not.toContain("unknown");
  });
  test("renders selector alternatives and their nested keys", () => {
    const info = getCliHelpParameterInfo(
      z.union([z.object({ text: z.string() }), z.object({ elementId: z.string() })]),
    );
    expect(info.typeName).toContain("text");
    expect(info.typeName).toContain("elementId");
    expect(info.typeName).toContain("JSON");
  });
  test("renders literal alternatives instead of union", () => {
    expect(getCliHelpParameterInfo(z.union([z.literal("first"), z.literal("last")])).typeName).toBe(
      '"first" | "last"',
    );
  });
  test("renders optional nested objects and array items", () => {
    const info = getCliHelpParameterInfo(
      z.object({ texts: z.array(z.string()), exact: z.boolean().optional() }).optional(),
    );
    expect(info.isOptional).toBe(true);
    expect(info.typeName).toContain('"texts": (string)[]');
    expect(info.typeName).toContain('"exact"?: boolean');
  });
});

class FakeCliOutput implements CliOutput {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  log(message: string): void {
    this.lines.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

test("tool help exposes real selector keys and a schema-valid example", async () => {
  const fakeOutput = new FakeCliOutput();
  await runCliCommand(["help"], undefined, fakeOutput);
  expect(fakeOutput.lines.join("\n")).toContain(`tapOn --selector '{"text":"Submit"}'`);
  const parsed = parseCliArgs(["tapOn", "--selector", '{"text":"Submit"}']);
  expect(ToolRegistry.getTool("tapOn")?.schema.safeParse(parsed.params).success).toBe(true);
  fakeOutput.lines.length = 0;
  await runCliCommand(["help", "tapOn"], undefined, fakeOutput);
  const output = fakeOutput.lines.join("\n");
  for (const key of ["elementId", "testTag", "text", "accessibilityLink", "textAny"]) {
    expect(output).toContain(`"${key}"`);
  }
  expect(output).toContain('"tap" | "doubleTap" | "longPress" | "focus"');
  expect(output).not.toContain("Type: union");
  expect(output).not.toContain("Could not parse");
  expect(fakeOutput.errors).toEqual([]);
});

test("nested criticalSection schema renders the required per-step parameter map", () => {
  registerCriticalSectionTools();
  const shape = getCliHelpSchemaShape(ToolRegistry.getToolForPlan("criticalSection")?.schema);
  expect(getCliHelpParameterInfo(shape?.steps).typeName).toContain(
    '"params": JSON { [key: string]: any }',
  );
});

test("help output and errors stay isolated between callers", async () => {
  const known = new FakeCliOutput();
  const unknown = new FakeCliOutput();
  await Promise.all([
    runCliCommand(["help", "tapOn"], undefined, known),
    runCliCommand(["help", "missing-tool"], undefined, unknown),
  ]);
  expect(known.errors).toEqual([]);
  expect(known.lines.join("\n")).toContain("Tool: tapOn");
  expect(unknown.errors).toEqual(["Unknown tool: missing-tool"]);
  expect(unknown.lines.join("\n")).not.toContain("Tool: tapOn");
});

test("array choices stay grouped inside the JSON array type", () => {
  const shape = getCliHelpSchemaShape(getDeviceStateSchema);
  expect(getCliHelpParameterInfo(shape?.include).typeName).toBe(
    '("doNotDisturb" | "biometrics" | "networkCondition")[] (JSON)',
  );
});

test("defaulted nested command fields are optional inputs", () => {
  const shape = getCliHelpSchemaShape(sendKeysSchema);
  const info = getCliHelpParameterInfo(shape?.commands);
  expect(info.typeName).toContain('"operation"?:');
  expect(info.typeName).toContain('"mode"?:');
  expect(sendKeysSchema.safeParse({ commands: [{ action: "type", text: "x" }] }).success).toBe(
    true,
  );
});
