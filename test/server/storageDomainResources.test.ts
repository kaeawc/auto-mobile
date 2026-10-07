import { afterEach, describe, expect, test } from "bun:test";
import { registerAppFileResources } from "../../src/server/appFileResources";
import { registerSharedStorageResources } from "../../src/server/sharedStorageResources";
import { registerStorageResources } from "../../src/server/storageResources";
import { registerStorageCapabilityResources } from "../../src/server/storageCapabilityResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import {
  buildCanonicalAppFileResourceUri,
  type AppFileListRequest,
  type AppFileReadRequest,
} from "../../src/server/appFileContract";
import { buildCanonicalUserFilesResourceUri } from "../../src/server/sharedStorageResourceContract";
import type { AppFileService } from "../../src/server/appFileService";
import type {
  SharedStorageReadService,
  ListSharedStorageRequest,
  ReadSharedStorageRequest,
} from "../../src/server/sharedStorageReadService";

const calls: Array<
  AppFileListRequest | AppFileReadRequest | ListSharedStorageRequest | ReadSharedStorageRequest
> = [];
const appService: AppFileService = {
  putFile: async () => {
    throw new Error("unused");
  },
  listFiles: async (request) => {
    calls.push(request);
    return { ...request, platform: "android", files: [] };
  },
  readFile: async (request) => {
    calls.push(request);
    return { ...request, platform: "android", byteCount: 2, mimeType: "text/plain", text: "hi" };
  },
};
const sharedService: SharedStorageReadService = {
  list: async (request) => {
    calls.push(request);
    return { ...request, platform: "android", observation: "complete", files: [] };
  },
  read: async (request) => {
    calls.push(request);
    return {
      ...request,
      platform: "android",
      observation: "complete",
      resourceUri: "alias",
      mimeType: "application/octet-stream",
      blob: "AAH/",
    };
  },
};
async function read(uri: string) {
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  return match!.template.handler(match!.params);
}
function register() {
  calls.length = 0;
  registerAppFileResources(appService);
  registerSharedStorageResources(sharedService);
}
afterEach(() => {
  ResourceRegistry.clearResources();
  calls.length = 0;
});

describe("storage-domain URI compatibility", () => {
  test.each([
    [
      "apps/com.example/files/documents?userId=10",
      "storage-domains/app_containers/com.example/documents?userId=10",
      { deviceId: "device 1", appId: "com.example", container: "documents", userId: 10 },
    ],
    [
      "apps/com.example/files/documents/dir/file%20name.txt?userId=0",
      "storage-domains/app_containers/com.example/documents/dir/file%20name.txt?userId=0",
      {
        deviceId: "device 1",
        appId: "com.example",
        container: "documents",
        userId: 0,
        path: "dir/file name.txt",
      },
    ],
    [
      "downloads/%20run-42%20",
      "storage-domains/user_files/%20run-42%20",
      { deviceId: "device 1", namespace: "run-42", domain: "user_files" },
    ],
    [
      "downloads/run-42/dir/file%20name.txt",
      "storage-domains/user_files/run-42/dir/file%20name.txt",
      {
        deviceId: "device 1",
        namespace: "run-42",
        domain: "user_files",
        path: "dir/file name.txt",
      },
    ],
  ])("%s and canonical %s delegate identically", async (alias, canonical, request) => {
    register();
    const prefix = "automobile:devices/device%201/";
    const aliasContent = await read(prefix + alias);
    const canonicalContent = await read(prefix + canonical);
    expect(canonicalContent.text).toBe(aliasContent.text);
    expect(canonicalContent.blob).toBe(aliasContent.blob);
    expect(canonicalContent.mimeType).toBe(aliasContent.mimeType);
    expect(calls).toEqual([request, request]);
    expect(canonicalContent.uri).toContain("/storage-domains/");
  });

  test.each([
    [
      "apps/app/files/bad",
      "storage-domains/app_containers/app/bad",
      "Unsupported app file container",
    ],
    [
      "apps/app/files/documents/%2E%2E/secret",
      "storage-domains/app_containers/app/documents/%2E%2E/secret",
      "destinationPath",
    ],
    ["downloads/%2E%2E", "storage-domains/user_files/%2E%2E", "namespace"],
    [
      "downloads/run/%2E%2E/secret",
      "storage-domains/user_files/run/%2E%2E/secret",
      "destinationPath",
    ],
    [
      "apps/app/files/documents?userId=-1",
      "storage-domains/app_containers/app/documents?userId=-1",
      "userId",
    ],
    [
      "apps/app/files/documents?userID=1",
      "storage-domains/app_containers/app/documents?userID=1",
      "only supported query parameter",
    ],
  ])("alias %s and canonical %s reject invalid requests", async (alias, canonical, message) => {
    register();
    for (const suffix of [alias, canonical]) {
      await expect(read(`automobile:devices/device/${suffix}`)).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);
  });

  test("canonical app query duplicate rejection and percent decoding match aliases", async () => {
    register();
    const uri = buildCanonicalAppFileResourceUri({
      deviceId: "device%1",
      appId: "app%1",
      container: "documents",
      path: "name%20.txt",
      userId: 10,
    });
    await read(uri);
    expect(calls[0]).toMatchObject({
      deviceId: "device%1",
      appId: "app%1",
      path: "name%20.txt",
      userId: 10,
    });
    expect(ResourceRegistry.matchTemplate(uri + "&userId=20")).toBeUndefined();
    expect(
      buildCanonicalUserFilesResourceUri({
        deviceId: "device 1",
        namespace: " run ",
        path: "dir/file name.txt",
      }),
    ).toBe("automobile:devices/device%201/storage-domains/user_files/run/dir/file%20name.txt");
  });

  test.each([true, false])(
    "canonical resources and sibling storage templates do not shadow each other (siblings first %s)",
    async (siblingsFirst) => {
      const siblings = () => {
        registerStorageResources();
        registerStorageCapabilityResources();
      };
      if (siblingsFirst) {
        siblings();
      }
      register();
      if (!siblingsFirst) {
        siblings();
      }
      const prefix = "automobile:devices/device/";
      for (const [suffix, template] of [
        ["storage/capabilities", "automobile:devices/{deviceId}/storage/capabilities{?appId}"],
        ["storage/app/files", "automobile:devices/{deviceId}/storage/{packageName}/files"],
        [
          "storage/app/preferences/entries",
          "automobile:devices/{deviceId}/storage/{packageName}/{fileName}/entries",
        ],
      ]) {
        expect(ResourceRegistry.matchTemplate(prefix + suffix)?.template.uriTemplate).toBe(
          template,
        );
      }
      await read(prefix + "storage-domains/app_containers/app/documents");
      await read(prefix + "storage-domains/app_containers/app/documents/file.txt");
      await read(prefix + "storage-domains/user_files/run");
      await read(prefix + "storage-domains/user_files/run/file.txt");
      expect(calls).toHaveLength(4);
    },
  );
});
