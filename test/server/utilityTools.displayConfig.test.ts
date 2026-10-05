import { DisplayConfig } from "../../src/features/utility/DisplayConfig";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { installFakeDeviceToolProviders } from "../helpers/hermeticDeviceTools";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  changeLocalizationSchema,
  displayConfigSchema,
  registerUtilityTools,
} from "../../src/server/utilityTools";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";

isolateToolRegistry();

test("calendar identifiers accept ICU keywords and reject shell syntax", () => {
  expect(changeLocalizationSchema.safeParse({ calendarSystem: "gregory" }).success).toBe(true);
  expect(changeLocalizationSchema.safeParse({ calendarSystem: "islamic-civil" }).success).toBe(
    true,
  );
  expect(
    changeLocalizationSchema.safeParse({ calendarSystem: "gregorian; touch /data/local/tmp/pwn" })
      .success,
  ).toBe(false);
});

let restoreDeviceToolProviders: () => void;
beforeEach(() => {
  restoreDeviceToolProviders = installFakeDeviceToolProviders();
});
afterEach(() => {
  restoreDeviceToolProviders();
});

describe("displayConfigSchema", () => {
  test("rejects reset combined with an explicit field before the handler runs", () => {
    const parsed = displayConfigSchema.safeParse({ reset: true, theme: "dark" });

    expect(parsed.success).toBe(false);
  });

  test("allows reset:false with an explicit field", () => {
    const parsed = displayConfigSchema.safeParse({ reset: false, fontScale: 1.2 });

    expect(parsed.success).toBe(true);
  });

  test("accepts the restorable default font-scale token", () => {
    const parsed = displayConfigSchema.safeParse({ fontScale: "default" });

    expect(parsed.success).toBe(true);
  });

  test("rejects densities below Android's wm density minimum", () => {
    expect(displayConfigSchema.safeParse({ density: 71 }).success).toBe(false);
    expect(displayConfigSchema.safeParse({ density: 72 }).success).toBe(true);
  });

  // The advertised JSON Schema must repeat the reset-exclusivity refinement
  // (issue #6303 review: "Encode reset exclusivity in the public schema"), so
  // a generated tool client can reject an invalid request before dispatch,
  // not only after the zod runtime refinement runs it through the handler.
  describe("advertised JSON schema", () => {
    let tool: ReturnType<typeof ToolRegistry.getToolDefinitions>[number] | undefined;
    let validate: ReturnType<Ajv2020["compile"]>;
    beforeAll(() => {
      const restoreStartupProviders = installFakeDeviceToolProviders();
      try {
        createMcpServer();
        tool = ToolRegistry.getToolDefinitions().find((t) => t.name === "displayConfig");
        const ajv = new Ajv2020({ strict: false });
        validate = ajv.compile(tool!.inputSchema as object);
      } finally {
        restoreStartupProviders();
      }
    });

    test("the tool is advertised", () => {
      expect(tool).toBeDefined();
    });

    test("does not publish a top-level allOf/anyOf/oneOf", () => {
      const schema = tool!.inputSchema as Record<string, unknown>;
      expect(schema.allOf).toBeUndefined();
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
    });

    test("leaves reset combination validation to runtime", () => {
      expect(validate({ reset: true, theme: "dark" })).toBe(true);
      expect(validate({ reset: true, fontScale: 1.2 })).toBe(true);
      expect(validate({ reset: true, density: 480 })).toBe(true);
    });

    test("accepts reset alone and an explicit field alone", () => {
      expect(validate({ reset: true })).toBe(true);
      expect(validate({ theme: "dark" })).toBe(true);
    });
  });
});

describe("displayConfig handler", () => {
  const device = { deviceId: "fake-device", platform: "android" as const, name: "Fake" };
  const result = {
    success: true,
    deviceId: device.deviceId,
    platform: device.platform,
    supported: { fontScale: true, density: true, theme: true },
    current: { fontScale: 1, density: 320, theme: "light" as const },
  };
  test.each([{}, { reset: false }])("reads configuration without a set field: %j", async (args) => {
    const get = spyOn(DisplayConfig.prototype, "getConfig").mockResolvedValue(result);
    const set = spyOn(DisplayConfig.prototype, "setConfig").mockResolvedValue(result);
    try {
      registerUtilityTools();
      const response = await ToolRegistry.getTool("displayConfig")!.deviceAwareHandler!(
        device,
        args,
      );
      expect(JSON.parse(response.content[0].text!)).toMatchObject(result);
      expect(get).toHaveBeenCalledTimes(1);
      expect(set).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
  test.each([
    { reset: true },
    { reset: false, fontScale: 1.2, density: 480, theme: "dark" as const },
  ])("projects set fields: %j", async (args) => {
    const get = spyOn(DisplayConfig.prototype, "getConfig").mockResolvedValue(result);
    const set = spyOn(DisplayConfig.prototype, "setConfig").mockResolvedValue(result);
    try {
      registerUtilityTools();
      const response = await ToolRegistry.getTool("displayConfig")!.deviceAwareHandler!(
        device,
        args,
      );
      expect(JSON.parse(response.content[0].text!)).toMatchObject(result);
      expect(set).toHaveBeenCalledWith(args);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
