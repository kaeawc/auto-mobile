import { afterEach, describe, expect, test } from "bun:test";
import {
  APP_FILE_RESOURCE_TEMPLATES,
  buildAppFileResourceUri,
  parseAppFileResourceParams,
} from "../../src/server/appFileContract";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

describe("App file resource contract", () => {
  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  test("builds stable URIs with encoded app IDs and nested file paths", () => {
    expect(buildAppFileResourceUri({
      deviceId: "device 1",
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/onboarding/welcome image.png",
    })).toBe(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png"
    );
  });

  test("parses decoded template params back to contract fields", () => {
    expect(parseAppFileResourceParams({
      deviceId: "device%201",
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/onboarding/welcome%20image.png",
    })).toEqual({
      deviceId: "device 1",
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/onboarding/welcome image.png",
    });
  });

  test("resource registry matches nested path template segments", async () => {
    ResourceRegistry.registerTemplate(
      APP_FILE_RESOURCE_TEMPLATES.FILE,
      "App File",
      "Read app file",
      "application/octet-stream",
      async params => ({
        uri: buildAppFileResourceUri(parseAppFileResourceParams(params)),
        mimeType: "application/json",
        text: JSON.stringify(parseAppFileResourceParams(params)),
      })
    );

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png"
    );

    expect(match).toBeDefined();
    expect(parseAppFileResourceParams(match!.params)).toEqual({
      deviceId: "device 1",
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/onboarding/welcome image.png",
    });
  });
});
