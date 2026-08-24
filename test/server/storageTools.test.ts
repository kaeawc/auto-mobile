import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerStorageTools, validateTypeForPlatform } from "../../src/server/storageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { ActionableError } from "../../src/models";

describe("Storage Tools Registration", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
    serverConfig.setEmbeddedSdkEnabled(true);
  });

  afterEach(() => {
    (ToolRegistry as any).tools.clear();
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("registers all three storage write tools", () => {
    registerStorageTools();

    const toolNames = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("setKeyValue");
    expect(toolNames).toContain("removeKeyValue");
    expect(toolNames).toContain("clearKeyValueFile");
  });

  test("registers the DataStore read tools", () => {
    registerStorageTools();

    const toolNames = ToolRegistry.getToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("listDataStores");
    expect(toolNames).toContain("getDataStore");
  });

  describe("listDataStores schema", () => {
    test("accepts appId + adapterName", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("listDataStores");
      expect(tool).toBeDefined();

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          adapterName: "settings",
        }),
      ).not.toThrow();
    });

    test("requires adapterName", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("listDataStores");

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
        }),
      ).toThrow();
    });
  });

  describe("getDataStore schema", () => {
    test("accepts appId + adapterName + name", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("getDataStore");
      expect(tool).toBeDefined();

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          adapterName: "settings",
          name: "user_prefs",
        }),
      ).not.toThrow();
    });

    test("requires name (store name)", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("getDataStore");

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          adapterName: "settings",
        }),
      ).toThrow();
    });
  });

  describe("setKeyValue schema", () => {
    test("accepts valid arguments with name parameter", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");
      expect(tool).toBeDefined();

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
          key: "dark_mode",
          value: "true",
          type: "BOOLEAN",
        }),
      ).not.toThrow();
    });

    test("accepts legacy fileName alias", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          fileName: "user_prefs",
          key: "dark_mode",
          value: "true",
          type: "BOOLEAN",
        }),
      ).toMatchObject({
        fileName: "user_prefs",
      });
    });

    test("accepts null value", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
          key: "some_key",
          value: null,
          type: "STRING",
        }),
      ).not.toThrow();
    });

    test("rejects missing required fields", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      // Missing key
      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
          value: "true",
          type: "BOOLEAN",
        }),
      ).toThrow();

      // Missing appId
      expect(() =>
        tool!.schema.parse({
          platform: "android",
          name: "user_prefs",
          key: "dark_mode",
          value: "true",
          type: "BOOLEAN",
        }),
      ).toThrow();

      // Missing name
      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          key: "dark_mode",
          value: "true",
          type: "BOOLEAN",
        }),
      ).toThrow();
    });

    test("rejects invalid type", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
          key: "dark_mode",
          value: "true",
          type: "INVALID_TYPE",
        }),
      ).toThrow();
    });

    test("accepts all valid Android KeyValueType values", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      const validTypes = ["STRING", "INT", "LONG", "FLOAT", "BOOLEAN", "STRING_SET"];
      for (const type of validTypes) {
        expect(() =>
          tool!.schema.parse({
            platform: "android",
            appId: "com.example.app",
            name: "prefs",
            key: "k",
            value: "v",
            type,
          }),
        ).not.toThrow();
      }
    });

    test("accepts all valid iOS KeyValueType values", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      const validTypes = [
        "STRING",
        "INT",
        "DOUBLE",
        "BOOLEAN",
        "DATA",
        "DATE",
        "ARRAY",
        "DICTIONARY",
      ];
      for (const type of validTypes) {
        expect(() =>
          tool!.schema.parse({
            platform: "ios",
            appId: "com.example.app",
            name: "Standard",
            key: "k",
            value: "v",
            type,
          }),
        ).not.toThrow();
      }
    });

    test("accepts UNKNOWN type in schema (validation happens at runtime)", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(() =>
        tool!.schema.parse({
          platform: "ios",
          appId: "com.example.app",
          name: "Standard",
          key: "k",
          value: "v",
          type: "UNKNOWN",
        }),
      ).not.toThrow();
    });
  });

  describe("removeKeyValue schema", () => {
    test("accepts valid arguments", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("removeKeyValue");
      expect(tool).toBeDefined();

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
          key: "dark_mode",
        }),
      ).not.toThrow();
    });

    test("accepts legacy fileName alias", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("removeKeyValue");

      expect(
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          fileName: "user_prefs",
          key: "dark_mode",
        }),
      ).toMatchObject({
        fileName: "user_prefs",
      });
    });

    test("rejects missing required fields", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("removeKeyValue");

      // Missing key
      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
        }),
      ).toThrow();
    });
  });

  describe("clearKeyValueFile schema", () => {
    test("accepts valid arguments", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("clearKeyValueFile");
      expect(tool).toBeDefined();

      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "user_prefs",
        }),
      ).not.toThrow();
    });

    test("accepts legacy fileName alias", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("clearKeyValueFile");

      expect(
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          fileName: "user_prefs",
        }),
      ).toMatchObject({
        fileName: "user_prefs",
      });
    });

    test("rejects missing required fields", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("clearKeyValueFile");

      // Missing name
      expect(() =>
        tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
        }),
      ).toThrow();
    });
  });

  // The setKeyValue MCP-tool handler runs args.type through validateTypeForPlatform
  // before dispatch; the daemon `ide/setKeyValue` socket handler now reuses the same
  // guard (issue #5022). These pin the shared guidance both paths depend on.
  describe("validateTypeForPlatform (shared MCP + socket guard)", () => {
    test("rejects an Android-only type on iOS with actionable guidance", () => {
      expect(() => validateTypeForPlatform("ios", "STRING_SET")).toThrow(ActionableError);
      expect(() => validateTypeForPlatform("ios", "STRING_SET")).toThrow(
        /STRING_SET is Android-only/,
      );
      expect(() => validateTypeForPlatform("ios", "LONG")).toThrow(/LONG is Android-only/);
    });

    test("rejects an iOS-only type on Android with actionable guidance", () => {
      expect(() => validateTypeForPlatform("android", "DOUBLE")).toThrow(ActionableError);
      expect(() => validateTypeForPlatform("android", "DOUBLE")).toThrow(/DOUBLE is iOS-only/);
      expect(() => validateTypeForPlatform("android", "ARRAY")).toThrow(/ARRAY is iOS-only/);
    });

    test("rejects the read-only UNKNOWN type on either platform", () => {
      expect(() => validateTypeForPlatform("android", "UNKNOWN")).toThrow(
        /UNKNOWN type is read-only/,
      );
      expect(() => validateTypeForPlatform("ios", "UNKNOWN")).toThrow(/UNKNOWN type is read-only/);
    });

    test("accepts a shared type on both platforms", () => {
      expect(() => validateTypeForPlatform("android", "STRING")).not.toThrow();
      expect(() => validateTypeForPlatform("ios", "STRING")).not.toThrow();
      expect(() => validateTypeForPlatform("android", "STRING_SET")).not.toThrow();
      expect(() => validateTypeForPlatform("ios", "DOUBLE")).not.toThrow();
    });
  });
});
