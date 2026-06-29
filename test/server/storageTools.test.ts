import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerStorageTools } from "../../src/server/storageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";

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

    const toolNames = ToolRegistry.getToolDefinitions().map(t => t.name);
    expect(toolNames).toContain("setKeyValue");
    expect(toolNames).toContain("removeKeyValue");
    expect(toolNames).toContain("clearKeyValueFile");
  });

  describe("setKeyValue schema", () => {
    test("accepts valid arguments with name parameter", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");
      expect(tool).toBeDefined();

      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
        key: "dark_mode",
        value: "true",
        type: "BOOLEAN",
      })).not.toThrow();
    });

    test("accepts legacy fileName alias", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        fileName: "user_prefs",
        key: "dark_mode",
        value: "true",
        type: "BOOLEAN",
      })).toMatchObject({
        fileName: "user_prefs",
      });
    });

    test("accepts null value", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
        key: "some_key",
        value: null,
        type: "STRING",
      })).not.toThrow();
    });

    test("rejects missing required fields", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      // Missing key
      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
        value: "true",
        type: "BOOLEAN",
      })).toThrow();

      // Missing appId
      expect(() => tool!.schema.parse({
        platform: "android",
        name: "user_prefs",
        key: "dark_mode",
        value: "true",
        type: "BOOLEAN",
      })).toThrow();

      // Missing name
      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        key: "dark_mode",
        value: "true",
        type: "BOOLEAN",
      })).toThrow();
    });

    test("rejects invalid type", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
        key: "dark_mode",
        value: "true",
        type: "INVALID_TYPE",
      })).toThrow();
    });

    test("accepts all valid Android KeyValueType values", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      const validTypes = ["STRING", "INT", "LONG", "FLOAT", "BOOLEAN", "STRING_SET"];
      for (const type of validTypes) {
        expect(() => tool!.schema.parse({
          platform: "android",
          appId: "com.example.app",
          name: "prefs",
          key: "k",
          value: "v",
          type,
        })).not.toThrow();
      }
    });

    test("accepts all valid iOS KeyValueType values", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      const validTypes = ["STRING", "INT", "DOUBLE", "BOOLEAN", "DATA", "DATE", "ARRAY", "DICTIONARY"];
      for (const type of validTypes) {
        expect(() => tool!.schema.parse({
          platform: "ios",
          appId: "com.example.app",
          name: "Standard",
          key: "k",
          value: "v",
          type,
        })).not.toThrow();
      }
    });

    test("accepts UNKNOWN type in schema (validation happens at runtime)", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("setKeyValue");

      expect(() => tool!.schema.parse({
        platform: "ios",
        appId: "com.example.app",
        name: "Standard",
        key: "k",
        value: "v",
        type: "UNKNOWN",
      })).not.toThrow();
    });
  });

  describe("removeKeyValue schema", () => {
    test("accepts valid arguments", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("removeKeyValue");
      expect(tool).toBeDefined();

      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
        key: "dark_mode",
      })).not.toThrow();
    });

    test("accepts legacy fileName alias", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("removeKeyValue");

      expect(tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        fileName: "user_prefs",
        key: "dark_mode",
      })).toMatchObject({
        fileName: "user_prefs",
      });
    });

    test("rejects missing required fields", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("removeKeyValue");

      // Missing key
      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
      })).toThrow();
    });
  });

  describe("clearKeyValueFile schema", () => {
    test("accepts valid arguments", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("clearKeyValueFile");
      expect(tool).toBeDefined();

      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        name: "user_prefs",
      })).not.toThrow();
    });

    test("accepts legacy fileName alias", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("clearKeyValueFile");

      expect(tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        fileName: "user_prefs",
      })).toMatchObject({
        fileName: "user_prefs",
      });
    });

    test("rejects missing required fields", () => {
      registerStorageTools();
      const tool = ToolRegistry.getTool("clearKeyValueFile");

      // Missing name
      expect(() => tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
      })).toThrow();
    });
  });
});
