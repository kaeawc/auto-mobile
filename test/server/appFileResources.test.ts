import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerAppFileResources } from "../../src/server/appFileResources";
import type { AppFileService } from "../../src/server/appFileService";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ActionableError } from "../../src/models/ActionableError";

describe("App file resources", () => {
  const fakeService: AppFileService = {
    putFile: async () => {
      throw new Error("not used");
    },
    listFiles: async (request) => ({
      deviceId: request.deviceId,
      platform: "ios",
      appId: request.appId,
      container: request.container,
      files: [
        {
          path: "fixtures/onboarding/welcome image.png",
          byteCount: 4,
          resourceUri:
            "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
        },
      ],
    }),
    readFile: async (request) => ({
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
    expect(templates.map((template) => template.uriTemplate)).toContain(
      "automobile:devices/{deviceId}/apps/{appId}/files/{container}{?userId}",
    );
    expect(templates.map((template) => template.uriTemplate)).toContain(
      "automobile:devices/{deviceId}/apps/{appId}/files/{container}/{path}{?userId}",
    );
  });

  test("lists app container files as JSON with resource URIs", async () => {
    registerAppFileResources(fakeService);

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/device%201/apps/com.example.app/files/documents",
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
      resourceUri:
        "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
    });
  });

  test("reads binary app files as lossless MCP blobs", async () => {
    registerAppFileResources(fakeService);

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
    );
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.uri).toBe(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
    );
    expect(content.mimeType).toBe("application/octet-stream");
    expect(content.blob).toBe("AAEC/w==");
    expect(content.text).toBeUndefined();
  });

  test("reads UTF-8 app files as MCP text content", async () => {
    registerAppFileResources({
      ...fakeService,
      readFile: async (request) => ({
        deviceId: request.deviceId,
        platform: "android",
        appId: request.appId,
        container: request.container,
        path: request.path,
        byteCount: 17,
        mimeType: "text/plain; charset=utf-8",
        text: '{"enabled":true}\n',
      }),
    });

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/config/settings.json",
    );
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.uri).toBe(
      "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/config/settings.json",
    );
    expect(content.mimeType).toBe("text/plain; charset=utf-8");
    expect(content.text).toBe('{"enabled":true}\n');
    expect(content.blob).toBeUndefined();
  });
  test.each([
    ["list, deviceId", "automobile:devices/dev%/apps/com.example.app/files/documents"],
    ["list, appId", "automobile:devices/device/apps/com.example%zz/files/documents"],
    ["list, container", "automobile:devices/device/apps/com.example.app/files/docu%E0%A4"],
    ["read, path", "automobile:devices/device/apps/com.example.app/files/documents/a%.txt"],
  ])(
    "rejects a malformed percent-escape in %s with a structured error, not a URIError (#10117)",
    async (_label, uri) => {
      registerAppFileResources(fakeService);
      const match = ResourceRegistry.matchTemplate(uri);
      expect(match).toBeDefined();

      const error = await match!.template.handler(match!.params).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ActionableError);
      expect(error).not.toBeInstanceOf(URIError);
      expect((error as Error).message).toBe(
        "Malformed resource URI: a path segment is not valid percent-encoding.",
      );
    },
  );

  test.each(["list", "read"])("rejects unsupported query keys in %s handler", async (operation) => {
    registerAppFileResources(fakeService);
    const base = `automobile:devices/device/apps/com.example.app/files/documents${operation === "read" ? "/welcome.txt" : ""}`;
    for (const [query, key] of [
      ["userID=10", "userID"],
      ["user=10", "user"],
      ["userId=10&foo=1", "foo"],
      ["deviceId=other", "deviceId"],
      ["appId=other", "appId"],
      ["container=cache", "container"],
      ["path=other.txt", "path"],
    ]) {
      const match = ResourceRegistry.matchTemplate(`${base}?${query}`);
      expect(match).toBeDefined();
      await expect(match!.template.handler(match!.params)).rejects.toThrow(
        `App file resource does not accept query parameter "${key}"; the only supported query parameter is "userId".`,
      );
    }
  });

  test.each(["list", "read"])("registry rejects repeated userId for %s template", (operation) => {
    registerAppFileResources(fakeService);
    const uri = `automobile:devices/device/apps/com.example.app/files/documents${operation === "read" ? "/welcome.txt" : ""}?userId=1&userId=2`;
    expect(ResourceRegistry.matchTemplate(uri)).toBeUndefined();
  });

  test.each([
    ["list", undefined],
    ["list", 0],
    ["list", 10],
    ["read", undefined],
    ["read", 0],
    ["read", 10],
  ])("passes %p handler userId %p", async (operation, userId) => {
    const calls: Array<number | undefined> = [];
    registerAppFileResources({
      ...fakeService,
      listFiles: async (request) => {
        calls.push(request.userId);
        return fakeService.listFiles(request);
      },
      readFile: async (request) => {
        calls.push(request.userId);
        return fakeService.readFile(request);
      },
    });
    const uri = `automobile:devices/device/apps/com.example.app/files/documents${operation === "read" ? "/welcome.txt" : ""}${userId === undefined ? "" : `?userId=${userId}`}`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const content = await match!.template.handler(match!.params);
    expect(calls).toEqual([userId]);
    expect(content.uri).toBe(uri);
  });
});
