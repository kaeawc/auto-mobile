import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";

describe("MCP Device Image Resources", () => {
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
    test("should include device images resource in list", async function() {
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

      // Verify device images resource is present
      const deviceImagesResource = result.resources.find(
        (r: any) => r.uri === "automobile://devices/images"
      );
      expect(deviceImagesResource).toBeDefined();
      expect(deviceImagesResource?.name).toBe("Device Images");
      expect(deviceImagesResource?.mimeType).toBe("application/json");
    });

    test("should include device images template in resource templates list", async function() {
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

      // Verify device images template is present
      const deviceImagesTemplate = result.resourceTemplates.find(
        (t: any) => t.uriTemplate === "automobile://devices/images/{platform}"
      );
      expect(deviceImagesTemplate).toBeDefined();
      expect(deviceImagesTemplate?.name).toBe("Platform-specific Device Images");
      expect(deviceImagesTemplate?.mimeType).toBe("application/json");
    });
  });

  describe("Resource Reading", () => {
    test("should return all device images resource", async function() {
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
          uri: "automobile://devices/images"
        }
      }, readResourceResponseSchema);

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile://devices/images");
      expect(content.mimeType).toBe("application/json");
      expect(content.text).toBeDefined();

      // Parse and verify content structure
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("totalCount");
      expect(data).toHaveProperty("androidCount");
      expect(data).toHaveProperty("iosCount");
      expect(data).toHaveProperty("lastUpdated");
      expect(data).toHaveProperty("images");
      expect(Array.isArray(data.images)).toBe(true);

      // Verify lastUpdated is a valid ISO 8601 date
      expect(() => new Date(data.lastUpdated)).not.toThrow();

      // Verify counts match
      expect(data.totalCount).toBe(data.images.length);
      expect(data.totalCount).toBe(data.androidCount + data.iosCount);
    });

    test("should return android-specific device images via template", async function() {
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
          uri: "automobile://devices/images/android"
        }
      }, readResourceResponseSchema);

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile://devices/images/android");
      expect(content.mimeType).toBe("application/json");

      // Parse and verify content
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("totalCount");
      expect(data).toHaveProperty("androidCount");
      expect(data).toHaveProperty("iosCount");
      expect(data.iosCount).toBe(0); // Should only contain Android

      // Verify all images are Android
      for (const image of data.images) {
        expect(image.platform).toBe("android");
      }
    });

    test("should return ios-specific device images via template", async function() {
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
          uri: "automobile://devices/images/ios"
        }
      }, readResourceResponseSchema);

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile://devices/images/ios");
      expect(content.mimeType).toBe("application/json");

      // Parse and verify content
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("totalCount");
      expect(data).toHaveProperty("androidCount");
      expect(data).toHaveProperty("iosCount");
      expect(data.androidCount).toBe(0); // Should only contain iOS

      // Verify all images are iOS
      for (const image of data.images) {
        expect(image.platform).toBe("ios");
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
          uri: "automobile://devices/images/invalid"
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
