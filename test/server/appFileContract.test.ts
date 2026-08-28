import { afterEach, describe, expect, test } from "bun:test";
import {
  APP_FILE_RESOURCE_TEMPLATES,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
  normalizePutAppFileTarget,
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
    target: { domain: "app_containers" as const, appId: "com.example.app", container: "documents" as const },
    files: [{ destinationPath: "notes/hello.txt" }],
  };
  const parseWithBase64 = (contentBase64: string) =>
    putAppFileSchema.safeParse({ ...base, files: [{ ...base.files[0], contentBase64 }] });

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

describe("putAppFile canonical target contract (#5803)", () => {
  const textFile = { destinationPath: "fixtures/welcome.txt", contentText: "hello" };

  test.each([
    { target: { domain: "app_containers", appId: "com.example.app", container: "documents" }, files: [textFile] },
    { target: { domain: "user_files", namespace: "run-42", reset: true }, files: [textFile] },
    { target: { domain: "media_library" }, files: [textFile] },
  ])("accepts target branch %#", (args) => {
    expect(putAppFileSchema.safeParse(args).success).toBe(true);
  });

  test("normalizes the legacy single-file app-container shape into the canonical batch", () => {
    expect(
      putAppFileSchema.parse({
        appId: "com.example.app",
        container: "documents",
        destinationPath: "./fixtures/welcome.txt",
        contentText: "hello",
      }),
    ).toMatchObject({
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ destinationPath: "./fixtures/welcome.txt", contentText: "hello" }],
    });
  });

  test("keeps established app ID aliases on the legacy compatibility path", () => {
    expect(
      putAppFileSchema.parse({
        bundleId: "com.example.app",
        container: "documents",
        destinationPath: "fixture.txt",
        contentText: "hello",
      }),
    ).toMatchObject({
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ destinationPath: "fixture.txt", contentText: "hello" }],
    });
  });

  test("keeps established app ID aliases in canonical app-container targets", () => {
    expect(
      putAppFileSchema.parse({
        target: { domain: "app_containers", bundleId: "com.example.app", container: "documents" },
        files: [textFile],
      }),
    ).toMatchObject({
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
    });
  });

  test("does not let canonical callers select legacy response semantics", () => {
    expect(
      putAppFileSchema.safeParse({
        target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
        files: [textFile],
        legacySingleFile: true,
      }).success,
    ).toBe(false);
  });

  test.each([
    { target: { domain: "app_containers", appId: "com.example.app", container: "documents", namespace: "nope" }, files: [textFile] },
    { target: { domain: "user_files", namespace: "../escape", appId: "com.example.app" }, files: [textFile] },
    { target: { domain: "media_library", namespace: "nope" }, files: [textFile] },
    { target: { domain: "app_containers", appId: "com.example.app", container: "documents" }, files: [] },
    { target: { domain: "app_containers", appId: "com.example.app", container: "documents" }, files: [{ ...textFile, sourcePath: "/tmp/file" }] },
    { target: { domain: "app_containers", appId: "com.example.app", container: "documents" }, files: [{ ...textFile, destinationPath: "../escape" }] },
  ])("rejects invalid target or file input %#", (args) => {
    expect(putAppFileSchema.safeParse(args).success).toBe(false);
  });

  test("normalizes each target before provider selection", () => {
    expect(
      normalizePutAppFileTarget({ domain: "user_files", namespace: " run-42 ", reset: true }),
    ).toEqual({ domain: "user_files", namespace: "run-42", reset: true });
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
