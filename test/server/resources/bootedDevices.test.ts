import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";

describe("MCP Booted Device Resources", () => {
  let fixture: McpTestFixture;

  beforeEach(async () => {
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
    }
  });

  describe("Resource Listing", () => {
    test("should include booted devices resource in list", async function() {
      const { client } = fixture.getContext();

      const { z } = await import("zod");
      const listResourcesResponseSchema = z.object({
        resources: z.array(z.object({
          uri: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional()
        }))
      });

      const result = await client.request({
        method: "resources/list",
        params: {}
      }, listResourcesResponseSchema);

      // Verify booted devices resource is present
      const bootedDevicesResource = result.resources.find(
        (r: any) => r.uri === "automobile://devices/booted"
      );
      expect(bootedDevicesResource).toBeDefined();
      expect(bootedDevicesResource?.name).toBe("Booted Devices");
      expect(bootedDevicesResource?.mimeType).toBe("application/json");
    });

    test("should include booted devices template in resource templates list", async function() {
      const { client } = fixture.getContext();

      const { z } = await import("zod");
      const listResourceTemplatesResponseSchema = z.object({
        resourceTemplates: z.array(z.object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional()
        }))
      });

      const result = await client.request({
        method: "resources/templates/list",
        params: {}
      }, listResourceTemplatesResponseSchema);

      // Verify booted devices template is present
      const bootedDevicesTemplate = result.resourceTemplates.find(
        (t: any) => t.uriTemplate === "automobile://devices/booted/{platform}"
      );
      expect(bootedDevicesTemplate).toBeDefined();
      expect(bootedDevicesTemplate?.name).toBe("Platform-specific Booted Devices");
      expect(bootedDevicesTemplate?.mimeType).toBe("application/json");
    });
  });

  describe("Resource Reading", () => {
    test("should return all booted devices resource", async function() {
      const { client } = fixture.getContext();

      const { z } = await import("zod");
      const readResourceResponseSchema = z.object({
        contents: z.array(z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional()
        }))
      });

      const result = await client.request({
        method: "resources/read",
        params: {
          uri: "automobile://devices/booted"
        }
      }, readResourceResponseSchema);

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile://devices/booted");
      expect(content.mimeType).toBe("application/json");
      expect(content.text).toBeDefined();

      // Parse and verify content structure
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("totalCount");
      expect(data).toHaveProperty("androidCount");
      expect(data).toHaveProperty("iosCount");
      expect(data).toHaveProperty("lastUpdated");
      expect(data).toHaveProperty("devices");
      expect(Array.isArray(data.devices)).toBe(true);

      // Verify lastUpdated is a valid ISO 8601 date
      expect(() => new Date(data.lastUpdated)).not.toThrow();

      // Verify counts match
      expect(data.totalCount).toBe(data.devices.length);
      expect(data.totalCount).toBe(data.androidCount + data.iosCount);
    });

    test("should return android-specific booted devices via template", async function() {
      const { client } = fixture.getContext();

      const { z } = await import("zod");
      const readResourceResponseSchema = z.object({
        contents: z.array(z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional()
        }))
      });

      const result = await client.request({
        method: "resources/read",
        params: {
          uri: "automobile://devices/booted/android"
        }
      }, readResourceResponseSchema);

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile://devices/booted/android");
      expect(content.mimeType).toBe("application/json");

      // Parse and verify content
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("totalCount");
      expect(data).toHaveProperty("androidCount");
      expect(data).toHaveProperty("iosCount");
      expect(data.iosCount).toBe(0); // Should only contain Android

      // Verify all devices are Android
      for (const device of data.devices) {
        expect(device.platform).toBe("android");
      }
    });

    test("should return ios-specific booted devices via template", async function() {
      const { client } = fixture.getContext();

      const { z } = await import("zod");
      const readResourceResponseSchema = z.object({
        contents: z.array(z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional()
        }))
      });

      const result = await client.request({
        method: "resources/read",
        params: {
          uri: "automobile://devices/booted/ios"
        }
      }, readResourceResponseSchema);

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile://devices/booted/ios");
      expect(content.mimeType).toBe("application/json");

      // Parse and verify content
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("totalCount");
      expect(data).toHaveProperty("androidCount");
      expect(data).toHaveProperty("iosCount");
      expect(data.androidCount).toBe(0); // Should only contain iOS

      // Verify all devices are iOS
      for (const device of data.devices) {
        expect(device.platform).toBe("ios");
      }
    });

    test("should return error for invalid platform", async function() {
      const { client } = fixture.getContext();

      const { z } = await import("zod");
      const readResourceResponseSchema = z.object({
        contents: z.array(z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional()
        }))
      });

      const result = await client.request({
        method: "resources/read",
        params: {
          uri: "automobile://devices/booted/invalid"
        }
      }, readResourceResponseSchema);

      // Verify error response
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("error");
      expect(data.error).toContain("Invalid platform");
    });
  });
});

describe("ResourceRegistry Template Matching", () => {
  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  test("should match simple template with single parameter", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async params => ({
        uri: `test://items/${params.id}`,
        mimeType: "application/json",
        text: JSON.stringify({ id: params.id })
      })
    );

    const match = ResourceRegistry.matchTemplate("test://items/123");
    expect(match).toBeDefined();
    expect(match!.params).toEqual({ id: "123" });
    expect(match!.template.uriTemplate).toBe("test://items/{id}");
  });

  test("should match template with multiple parameters", () => {
    ResourceRegistry.registerTemplate(
      "test://users/{userId}/posts/{postId}",
      "User Post",
      "A user's post",
      "application/json",
      async params => ({
        uri: `test://users/${params.userId}/posts/${params.postId}`,
        mimeType: "application/json",
        text: JSON.stringify(params)
      })
    );

    const match = ResourceRegistry.matchTemplate("test://users/user-123/posts/post-456");
    expect(match).toBeDefined();
    expect(match!.params).toEqual({ userId: "user-123", postId: "post-456" });
  });

  test("should not match non-matching URIs", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async params => ({
        uri: `test://items/${params.id}`,
        mimeType: "application/json",
        text: "{}"
      })
    );

    expect(ResourceRegistry.matchTemplate("test://other/123")).toBeUndefined();
    expect(ResourceRegistry.matchTemplate("test://items/")).toBeUndefined();
    expect(ResourceRegistry.matchTemplate("test://items")).toBeUndefined();
  });

  test("should prefer exact resource match over template", () => {
    // Register both exact resource and template
    ResourceRegistry.register(
      "test://items/special",
      "Special Item",
      "A special item",
      "application/json",
      async () => ({
        uri: "test://items/special",
        mimeType: "application/json",
        text: JSON.stringify({ type: "exact" })
      })
    );

    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Generic Item",
      "A generic item",
      "application/json",
      async params => ({
        uri: `test://items/${params.id}`,
        mimeType: "application/json",
        text: JSON.stringify({ type: "template", id: params.id })
      })
    );

    // Exact match should be found
    const exactResource = ResourceRegistry.getResource("test://items/special");
    expect(exactResource).toBeDefined();
    expect(exactResource!.name).toBe("Special Item");

    // Template should still match other URIs
    const templateMatch = ResourceRegistry.matchTemplate("test://items/other");
    expect(templateMatch).toBeDefined();
    expect(templateMatch!.params.id).toBe("other");
  });

  test("should return template definitions in correct format", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async () => ({
        uri: "test://items/1",
        mimeType: "application/json",
        text: "{}"
      })
    );

    const definitions = ResourceRegistry.getTemplateDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toEqual({
      uriTemplate: "test://items/{id}",
      name: "Test Item",
      description: "Test item description",
      mimeType: "application/json"
    });
  });
});
