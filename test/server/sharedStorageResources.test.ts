import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerSharedStorageResources } from "../../src/server/sharedStorageResources";
import type { SharedStorageReadService } from "../../src/server/sharedStorageReadService";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

const fakeService: SharedStorageReadService = {
  list: async (request) => ({
    deviceId: request.deviceId,
    platform: "android",
    namespace: request.namespace,
    userId: 0,
    userSource: "primary",
    downloadsDirectory: `/storage/emulated/0/Download/${request.namespace}`,
    observation: "complete",
    files: [
      {
        path: "docs/read me.txt",
        name: "read me.txt",
        byteCount: 7,
        mimeType: "text/plain",
        sha256: "1111",
        lastModified: "2023-07-22T06:13:20.000Z",
        resourceUri: `automobile:devices/${request.deviceId}/downloads/${request.namespace}/docs/read%20me.txt`,
      },
    ],
  }),
  read: async (request) => ({
    deviceId: request.deviceId,
    platform: "android",
    namespace: request.namespace,
    path: request.path,
    userId: 0,
    observation: "complete",
    byteCount: 3,
    mimeType: "application/octet-stream",
    sha256: "2222",
    blob: "AAH/",
    resourceUri: `automobile:devices/${request.deviceId}/downloads/${request.namespace}/${request.path}`,
  }),
};

describe("Shared-storage read resources", () => {
  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  test("registers namespace-list and file-read templates", () => {
    registerSharedStorageResources(fakeService);
    const templates = ResourceRegistry.getTemplateDefinitions().map((t) => t.uriTemplate);
    expect(templates).toContain("automobile:devices/{deviceId}/downloads/{namespace}");
    expect(templates).toContain("automobile:devices/{deviceId}/downloads/{namespace}/{path}");
  });

  test("lists a namespace as JSON with verification metadata", async () => {
    registerSharedStorageResources(fakeService);
    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/emulator-5554/downloads/run-42",
    );
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.mimeType).toBe("application/json");
    const payload = JSON.parse(content.text!);
    expect(payload).toMatchObject({
      deviceId: "emulator-5554",
      platform: "android",
      namespace: "run-42",
      observation: "complete",
    });
    expect(payload.files[0]).toMatchObject({
      path: "docs/read me.txt",
      byteCount: 7,
      mimeType: "text/plain",
      sha256: "1111",
      resourceUri: "automobile:devices/emulator-5554/downloads/run-42/docs/read%20me.txt",
    });
  });

  test("reads a binary file as a lossless MCP blob", async () => {
    registerSharedStorageResources(fakeService);
    const uri = "automobile:devices/emulator-5554/downloads/run-42/media/photo.png";
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    expect(content.uri).toBe(uri);
    expect(content.mimeType).toBe("application/octet-stream");
    expect(content.blob).toBe("AAH/");
    expect(content.text).toBeUndefined();
  });

  test("reads a UTF-8 file as MCP text content", async () => {
    registerSharedStorageResources({
      ...fakeService,
      read: async (request) => ({
        deviceId: request.deviceId,
        platform: "android",
        namespace: request.namespace,
        path: request.path,
        userId: 0,
        observation: "complete",
        byteCount: 5,
        mimeType: "text/plain",
        sha256: "3333",
        text: "hello",
        resourceUri: `automobile:devices/${request.deviceId}/downloads/${request.namespace}/${request.path}`,
      }),
    });
    const uri = "automobile:devices/emulator-5554/downloads/run-42/notes/hi.txt";
    const match = ResourceRegistry.matchTemplate(uri);
    const content = await match!.template.handler(match!.params);
    expect(content.mimeType).toBe("text/plain");
    expect(content.text).toBe("hello");
    expect(content.blob).toBeUndefined();
  });

  test("returns a typed JSON envelope when a file read is not complete", async () => {
    registerSharedStorageResources({
      ...fakeService,
      read: async (request) => ({
        deviceId: request.deviceId,
        platform: "android",
        namespace: request.namespace,
        path: request.path,
        observation: "missing",
        reason: "file not found",
        resourceUri: `automobile:devices/${request.deviceId}/downloads/${request.namespace}/${request.path}`,
      }),
    });
    const uri = "automobile:devices/emulator-5554/downloads/run-42/notes/gone.txt";
    const match = ResourceRegistry.matchTemplate(uri);
    const content = await match!.template.handler(match!.params);
    expect(content.mimeType).toBe("application/json");
    const payload = JSON.parse(content.text!);
    expect(payload.observation).toBe("missing");
    expect(content.blob).toBeUndefined();
  });

  test("rejects a file URI that traverses out of the namespace", async () => {
    registerSharedStorageResources(fakeService);
    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/emulator-5554/downloads/run-42/../../etc/hosts",
    );
    // The traversal URI must not resolve to a readable file.
    if (match) {
      await expect(match.template.handler(match.params)).rejects.toThrow();
    }
  });
});
