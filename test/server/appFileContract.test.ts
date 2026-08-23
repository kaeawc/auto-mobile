import { afterEach, describe, expect, test } from "bun:test";
import {
  APP_FILE_RESOURCE_TEMPLATES,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
  parseAppFileResourceParams,
  putAppFileSchema,
} from "../../src/server/appFileContract";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

describe("App file resource contract", () => {
  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  test("builds stable URIs with encoded app IDs and nested file paths", () => {
    expect(
      buildAppFileResourceUri({
        deviceId: "device 1",
        appId: "com.example.app",
        container: "documents",
        path: "fixtures/onboarding/welcome image.png",
      }),
    ).toBe(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
    );
  });

  test("parses decoded template params back to contract fields", () => {
    expect(
      parseAppFileResourceParams({
        deviceId: "device%201",
        appId: "com.example.app",
        container: "documents",
        path: "fixtures/onboarding/welcome%20image.png",
      }),
    ).toEqual({
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
      async (params) => ({
        uri: buildAppFileResourceUri(parseAppFileResourceParams(params)),
        mimeType: "application/json",
        text: JSON.stringify(parseAppFileResourceParams(params)),
      }),
    );

    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/device%201/apps/com.example.app/files/documents/fixtures/onboarding/welcome%20image.png",
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

describe("putAppFileSchema contentBase64 guard (#4183 A4)", () => {
  const base = {
    appId: "com.example.app",
    container: "documents" as const,
    destinationPath: "notes/hello.txt",
  };
  const parseWithBase64 = (contentBase64: string) =>
    putAppFileSchema.safeParse({ ...base, contentBase64 });

  // Table is the spec. Rows 6 ("====") and 7 ("") are the live bug: they
  // round-trip as "valid" base64 but decode to zero bytes, writing an empty
  // file to the device.
  test.each([
    ["aGVsbG8=", true], // "hello"
    ["aGVsbG8", true], // canonical unpadded "hello"
    ["QQ==", true], // "A"
    ["QQ", true], // canonical unpadded "A"
    ["AAAA", true], // 3 zero bytes (non-empty)
    ["QUJD", true], // "ABC"
    ["not valid base64!!", false],
    ["QQ===", false],
    ["AAAA==", false],
    ["====", false],
    ["", false],
  ])("contentBase64 %p accepted=%p", (payload, accepted) => {
    expect(parseWithBase64(payload).success).toBe(accepted);
  });
});

describe("normalizeAppFileRelativePath container guard (#4183 P5/P16)", () => {
  // Table is the spec. Container-escape attempts and empty segments must throw;
  // benign nested/backslash paths normalize. A leading slash THROWS (it is an
  // absolute path, not a container-relative one) — critic-corrected row.
  test.each([
    ["a/b.txt", "a/b.txt"],
    ["./a/b.txt", "a/b.txt"],
    ["a\\b.txt", "a/b.txt"],
  ])("normalizes %p to %p", (input, expected) => {
    expect(normalizeAppFileRelativePath(input)).toBe(expected);
  });

  test.each([[""], ["/a/b.txt"], ["../secret"], ["a/../b"], ["a/./b"], ["a//b"], ["."], [".."]])(
    "rejects unsafe path %p",
    (input) => {
      expect(() => normalizeAppFileRelativePath(input)).toThrow(/non-empty relative path/);
    },
  );
});
