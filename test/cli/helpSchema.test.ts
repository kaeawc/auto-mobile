import { sendKeysSchema } from "../../src/server/interactionTools";

import { getDeviceStateSchema } from "../../src/server/utilityTools";

import { runCliCommand, parseCliArgs } from "../../src/cli";
import { ToolRegistry } from "../../src/server/toolRegistry";

import { z } from "zod/v4";

import { describe, expect, test } from "bun:test";
import { getCliHelpParameterInfo, getCliHelpSchemaShape } from "../../src/cli";
import { launchAppSchema } from "../../src/server/appTools";

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

test("tool help exposes real selector keys and a schema-valid example", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    await runCliCommand(["help"]);
    expect(lines.join("\n")).toContain(`tapOn --selector '{"text":"Submit"}'`);
    const parsed = parseCliArgs(["tapOn", "--selector", '{"text":"Submit"}']);
    expect(ToolRegistry.getTool("tapOn")?.schema.safeParse(parsed.params).success).toBe(true);
    lines.length = 0;
    await runCliCommand(["help", "tapOn"]);
    const output = lines.join("\n");
    for (const key of ["elementId", "testTag", "text", "accessibilityLink", "textAny"]) {
      expect(output).toContain(`"${key}"`);
    }
    expect(output).toContain('"tap" | "doubleTap" | "longPress" | "focus"');
    expect(output).not.toContain("Type: union");
    expect(output).not.toContain("Could not parse");
  } finally {
    console.log = originalLog;
  }
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
