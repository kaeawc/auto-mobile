import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerAppFileResources } from "../../src/server/appFileResources";
import type { AppFileService } from "../../src/server/appFileService";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

describe("App file resources", () => {
  const fakeService: AppFileService = {
    putFile: async () => {
      throw new Error("not used");
    },
    listFiles: async request => ({
      deviceId: request.deviceId,
      platform: "ios",
      appId: request.appId,
      container: request.container,
      files: [
        {
          path: "fixtures/onboarding/welcome image.png",
          byteCount: 4,
          resourceUri: "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
        },
      ],
    }),
    readFile: async request => ({
      deviceId: request.deviceId,
      platform: "ios",
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: 4,
      mimeType: "application/octet-stream",
      blob: "AAEC/w==",
    }),
  };

  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  test("registers list and read resource templates", () => {
    registerAppFileResources(fakeService);

    const templates = ResourceRegistry.getTemplateDefinitions();
    expect(templates.map(template => template.uriTemplate)).toContain(
      "automobile:devices/{deviceId}/apps/{appId}/files/{container}"
    );
    expect(templates.map(template => template.uriTemplate)).toContain(
      "automobile:devices/{deviceId}/apps/{appId}/files/{container}/{path}"
    );
  });

  test("lists app container files as JSON with resource URIs", async () => {
    registerAppFileResources(fakeService);

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/device%201/apps/com.example.app/files/documents"
    );
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.mimeType).toBe("application/json");
    const payload = JSON.parse(content.text!);
    expect(payload).toMatchObject({
      deviceId: "device 1",
      platform: "ios",
      appId: "com.example.app",
      container: "documents",
    });
    expect(payload.files[0]).toMatchObject({
      path: "fixtures/onboarding/welcome image.png",
      byteCount: 4,
      resourceUri: "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
    });
  });

  test("reads binary app files as lossless MCP blobs", async () => {
    registerAppFileResources(fakeService);

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png"
    );
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.uri).toBe(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png"
    );
    expect(content.mimeType).toBe("application/octet-stream");
    expect(content.blob).toBe("AAEC/w==");
    expect(content.text).toBeUndefined();
  });

  test("reads UTF-8 app files as MCP text content", async () => {
    registerAppFileResources({
      ...fakeService,
      readFile: async request => ({
        deviceId: request.deviceId,
        platform: "android",
        appId: request.appId,
        container: request.container,
        path: request.path,
        byteCount: 17,
        mimeType: "text/plain; charset=utf-8",
        text: "{\"enabled\":true}\n",
      }),
    });

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/config/settings.json"
    );
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.uri).toBe(
      "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/config/settings.json"
    );
    expect(content.mimeType).toBe("text/plain; charset=utf-8");
    expect(content.text).toBe("{\"enabled\":true}\n");
    expect(content.blob).toBeUndefined();
  });
});
