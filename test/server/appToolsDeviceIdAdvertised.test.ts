import { beforeAll, describe, expect, test } from "bun:test";
import { registerAppTools } from "../../src/server/appTools";
import { deviceLabelHint } from "../../src/server/pipeline/deviceLabelHint";
import { ToolDefinitionSchemaCache } from "../../src/server/toolDefinitionSchemaCache";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { addDeviceTargetingToSchema, DEVICE_ID_DESCRIPTION } from "../../src/utils/schemaHelpers";
import { z } from "zod/v4";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

// #17954: with several devices booted a direct app-management call must be able to pick one by
// id, so these tools advertise the deviceId field every device-targeted schema already accepts.
const APP_MANAGEMENT_TOOLS = [
  "installApp",
  "launchApp",
  "terminateApp",
  "crashApp",
  "appLifecycle",
  "uninstallApp",
  "listApps",
  "setAppPermissions",
  "getAppPermissions",
  "inspectPackageSigning",
  "resetKeychain",
];

function advertisedProperties(name: string): Record<string, unknown> {
  const tool = ToolRegistry.getTool(name);
  if (!tool) {
    throw new Error(`${name} is not registered`);
  }
  const { inputSchema } = new ToolDefinitionSchemaCache().get(tool, false, false);
  return (inputSchema.properties ?? {}) as Record<string, unknown>;
}

describe("app-management tools advertise deviceId (#17954)", () => {
  beforeAll(() => {
    registerAppTools();
    ToolRegistry.registerDeviceAware(
      "untraitedDeviceTool",
      "A device-targeted tool without the trait",
      addDeviceTargetingToSchema(z.object({})),
      async () => ({ content: [] }),
    );
  });

  test.each(APP_MANAGEMENT_TOOLS)("%s advertises a described deviceId", (name) => {
    expect(ToolRegistry.getTool(name)?.advertisesDeviceId).toBe(true);
    expect(advertisedProperties(name).deviceId).toEqual({
      type: "string",
      description: DEVICE_ID_DESCRIPTION,
    });
  });

  test("a device-targeted tool without the trait still hides the injected deviceId", () => {
    expect(advertisedProperties("untraitedDeviceTool")).not.toHaveProperty("deviceId");
  });

  test("installApp and launchApp accept a deviceId argument", () => {
    const install = ToolRegistry.getTool("installApp")!.schema;
    const launch = ToolRegistry.getTool("launchApp")!.schema;
    expect(
      install.safeParse({ artifactPath: "/tmp/app.apk", deviceId: "emulator-5558" }).success,
    ).toBe(true);
    expect(
      launch.safeParse({ appId: "dev.dogfood.notes", deviceId: "emulator-5558" }).success,
    ).toBe(true);
  });
});

describe("device label refusal hint (#17954)", () => {
  test("says device is a plan label and points at deviceId", () => {
    const hint = deviceLabelHint("emulator-5558");
    expect(hint).toContain("`device` is an executePlan device label");
    expect(hint).toContain("deviceId: 'emulator-5558'");
  });
});
