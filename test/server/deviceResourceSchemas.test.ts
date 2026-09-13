import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerDeviceTools } from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("device resource advertised constraints", () => {
  const validators = new Map<string, ValidateFunction>();
  const device = {
    platform: "ios",
    name: "Phone",
    spec: {
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    },
  };
  beforeAll(() => {
    registerDeviceTools();
    const artifact: Array<{ name: string; inputSchema: object }> = JSON.parse(
      readFileSync(new URL("../../schemas/tool-definitions.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    for (const [source, definitions] of [
      ["live", ToolRegistry.getToolDefinitions({ includeUnavailable: true })],
      ["artifact", artifact],
    ] as const) {
      for (const name of ["setDeviceResources", "provisionDevice"]) {
        const definition = definitions.find((entry) => entry.name === name)!;
        validators.set(`${source}/${name}`, ajv.compile(definition.inputSchema));
      }
    }
  });

  test.each(["live", "artifact"])("%s schemas reject empty resource maps", (source) => {
    const set = validators.get(`${source}/setDeviceResources`)!;
    const provision = validators.get(`${source}/provisionDevice`)!;
    expect(set({ resources: {} })).toBe(false);
    expect(provision({ operationId: "test", device, resources: {} })).toBe(false);
    expect(set({ resources: { widgets: "enabled" } })).toBe(true);
    expect(provision({ operationId: "test", device, resources: { widgets: "enabled" } })).toBe(
      true,
    );
  });

  test.each(["live", "artifact"])("%s schema accepts restoration alone", (source) => {
    const validate = validators.get(`${source}/setDeviceResources`)!;
    const restore = {
      deviceId: "emulator-5580",
      bootId: "11111111-1111-4111-8111-111111111111",
      userId: 0,
      entries: [
        { resource: "animations", kind: "global", target: "animator_duration_scale", value: null },
      ],
    };
    expect(validate({ restore })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ restore, resources: { animations: "disabled" } })).toBe(false);
  });

  test.each(["live", "artifact"])(
    "%s schema requires booting when configuring resources",
    (source) => {
      const validate = validators.get(`${source}/provisionDevice`)!;
      const args = { operationId: "test", device, resources: { widgets: "enabled" } };
      expect(validate({ ...args, boot: false })).toBe(false);
      expect(validate({ ...args, boot: true })).toBe(true);
      expect(validate(args)).toBe(true);
      expect(validate({ operationId: "test", device, boot: false })).toBe(true);
    },
  );
});

test("restoration and desired resource configuration are mutually exclusive", async () => {
  const { setDeviceResourcesSchema } = await import("../../src/server/deviceResourceSchemas");
  const restore = {
    deviceId: "emulator-5580",
    bootId: "11111111-1111-4111-8111-111111111111",
    userId: 0,
    entries: [
      { resource: "animations", kind: "global", target: "animator_duration_scale", value: null },
    ],
  };
  expect(setDeviceResourcesSchema.safeParse({ restore }).success).toBe(true);
  expect(setDeviceResourcesSchema.safeParse({}).success).toBe(false);
  expect(
    setDeviceResourcesSchema.safeParse({ restore, resources: { animations: "enabled" } }).success,
  ).toBe(false);
});
