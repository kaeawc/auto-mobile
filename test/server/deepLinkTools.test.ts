import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import {
  createGetDeepLinksHandler,
  registerDeepLinkTools,
  type GetDeepLinksExecutor,
} from "../../src/server/deepLinkTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, DeepLinkResult } from "../../src/models";

const emptyDeepLinks = {
  schemes: [],
  hosts: [],
  intentFilters: [],
  supportedMimeTypes: [],
};

async function invokeHandler(result: DeepLinkResult) {
  const executor: GetDeepLinksExecutor = { execute: async () => result };
  const handler = createGetDeepLinksHandler(() => executor);
  const response = await handler({} as BootedDevice, { appId: result.appId });
  const content = response.content[0];
  if (!content || content.type !== "text") {
    throw new Error("Expected a text tool response");
  }
  return { response, payload: JSON.parse(content.text) as Record<string, unknown> };
}

describe("Deep Link Tools Registration", function () {
  beforeEach(() => {
    // Clear the tool registry before each test
    (ToolRegistry as any).tools.clear();
  });

  afterEach(() => {
    // Clean up after each test
    (ToolRegistry as any).tools.clear();
  });

  describe("registerDeepLinkTools", () => {
    test("should register all deep link tools", () => {
      registerDeepLinkTools();

      const registeredTools = ToolRegistry.getToolDefinitions();
      const toolNames = registeredTools.map((tool) => tool.name);

      expect(toolNames).toContain("getDeepLinks");
    });

    test("should register getDeepLinks tool with correct schema", () => {
      registerDeepLinkTools();

      const tool = ToolRegistry.getTool("getDeepLinks");
      expect(tool).toBeDefined();
      expect(tool!.description).toContain("Query app deep links");
      expect(tool!.supportsProgress).toBe(false);

      // Test schema validation
      const validArgs = { appId: "com.example.app", platform: "android" };
      expect(() => tool!.schema.parse(validArgs)).not.toThrow();

      const invalidArgs = { appId: 123, platform: "android" };
      expect(() => tool!.schema.parse(invalidArgs)).toThrow();
    });
  });

  describe("Tool Handlers", function () {
    beforeEach(() => {
      registerDeepLinkTools();
    });

    describe("getDeepLinks handler", () => {
      test("reports a discovery failure as an error", async () => {
        const error = "Package not installed; use listApps to find installed packages";
        const { response, payload } = await invokeHandler({
          success: false,
          appId: "com.example.missing",
          deepLinks: emptyDeepLinks,
          error,
        });

        expect(payload).toEqual({
          message: error,
          success: false,
          appId: "com.example.missing",
          schemes: [],
          hosts: [],
          intentFilters: [],
          supportedMimeTypes: [],
          error,
        });
        expect(payload.message).not.toContain("Discovered");
        expect(response).toHaveProperty("isError", true);
      });

      test("preserves the success response when links are found", async () => {
        const result: DeepLinkResult = {
          success: true,
          appId: "com.example.app",
          deepLinks: {
            schemes: ["example"],
            hosts: ["example.com"],
            intentFilters: [],
            supportedMimeTypes: ["text/plain"],
          },
          note: "Found app links",
          rawOutput: "package dump",
        };
        const { response, payload } = await invokeHandler(result);

        expect(payload).toEqual({
          message: "Discovered deep links for app com.example.app",
          success: true,
          appId: "com.example.app",
          schemes: ["example"],
          hosts: ["example.com"],
          intentFilters: [],
          supportedMimeTypes: ["text/plain"],
          note: "Found app links",
          rawOutput: "package dump",
        });
        expect(response).not.toHaveProperty("isError");
      });

      test("keeps the success wording when no links are configured", async () => {
        const { response, payload } = await invokeHandler({
          success: true,
          appId: "com.example.no-links",
          deepLinks: emptyDeepLinks,
        });

        expect(payload).toEqual({
          message: "Discovered deep links for app com.example.no-links",
          success: true,
          appId: "com.example.no-links",
          schemes: [],
          hosts: [],
          intentFilters: [],
          supportedMimeTypes: [],
        });
        expect(response).not.toHaveProperty("isError");
      });

      test("should validate app ID parameter and fail gracefully", async function () {
        const tool = ToolRegistry.getTool("getDeepLinks");
        expect(tool).toBeDefined();

        // Test that the schema validates correctly
        const validInput = { appId: "com.example.app" };
        const parsed = tool!.schema.parse(validInput);
        expect(parsed.appId).toBe("com.example.app");
      });

      test("should validate app ID parameter", () => {
        const tool = ToolRegistry.getTool("getDeepLinks");
        expect(tool).toBeDefined();

        // Should throw on invalid schema
        expect(() => tool!.schema.parse({ appId: null, platform: "android" })).toThrow();
        expect(() => tool!.schema.parse({})).toThrow();
      });
    });
  });

  describe("Error Handling", function () {
    beforeEach(() => {
      registerDeepLinkTools();
    });

    test("should reject missing appId in schema", async function () {
      const tool = ToolRegistry.getTool("getDeepLinks");
      expect(tool).toBeDefined();

      // Missing appId should fail validation
      expect(() => tool!.schema.parse({})).toThrow();
    });
  });

  describe("Schema Definitions", () => {
    test("should export schema objects", () => {
      const schemas = require("../../src/server/deepLinkTools");

      expect(schemas.getDeepLinksSchema).toBeDefined();
    });

    test("should have correct TypeScript interfaces", () => {
      const interfaces = require("../../src/server/deepLinkTools");

      // These should exist as type definitions (compile-time check)
      expect(interfaces.GetDeepLinksArgs).toBeUndefined(); // Interfaces don't exist at runtime
    });
  });
});
