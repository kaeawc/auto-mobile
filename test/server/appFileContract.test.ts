import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

describe("App file resource userId", () => {
  afterEach(() => ResourceRegistry.clearResources());
  test.each(["userID", "user", "foo"])("rejects unsupported query key %s directly", (key) => {
    expect(() =>
      parseAppFileResourceParams({
        deviceId: "device",
        appId: "com.example.app",
        container: "documents",
        userId: "10",
        [key]: "1",
      }),
    ).toThrow(
      `App file resource does not accept query parameter "${key}"; the only supported query parameter is "userId".`,
    );
  });
  test.each([undefined, 0, 10, Number.MAX_SAFE_INTEGER])(
    "round trips userId %p on both templates",
    (userId) => {
      for (const path of [undefined, "fixtures/welcome image.txt"]) {
        const parts = {
          deviceId: "device 1",
          appId: "com.example.app",
          container: "documents" as const,
          path,
          userId,
        };
        const uri = buildAppFileResourceUri(parts);
        ResourceRegistry.registerTemplate(
          path === undefined
            ? APP_FILE_RESOURCE_TEMPLATES.CONTAINER
            : APP_FILE_RESOURCE_TEMPLATES.FILE,
          "Files",
          "Files",
          "application/json",
          async () => ({ uri, mimeType: "application/json", text: "{}" }),
        );
        const match = ResourceRegistry.matchTemplate(uri);
        expect(match).toBeDefined();
        expect(parseAppFileResourceParams(match!.params)).toEqual(parts);
        expect(buildAppFileResourceUri(parseAppFileResourceParams(match!.params))).toBe(uri);
        expect(
          uri.endsWith(
            userId === undefined
              ? path === undefined
                ? "documents"
                : "welcome%20image.txt"
              : `?userId=${userId}`,
          ),
        ).toBe(true);
        ResourceRegistry.clearResources();
      }
    },
  );
  test.each(["", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e1", " 10 ", "abc"])(
    "rejects invalid resource userId %p",
    (userId) => {
      expect(() =>
        parseAppFileResourceParams({
          deviceId: "device",
          appId: "com.example.app",
          container: "documents",
          userId,
        }),
      ).toThrow("userId must be a non-negative safe integer");
    },
  );
});

describe("putAppFileSchema contentBase64 guard (#4183 A4)", () => {
  const base = {
    target: {
      domain: "app_containers" as const,
      appId: "com.example.app",
      container: "documents" as const,
    },
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

  test("accepts safe Android user IDs in canonical and legacy requests", () => {
    const canonical = {
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [textFile],
    };
    const legacy = {
      appId: "com.example.app",
      container: "documents",
      ...textFile,
    };
    for (const userId of [0, 10]) {
      expect(putAppFileSchema.parse({ ...canonical, userId }).userId).toBe(userId);
      expect(putAppFileSchema.parse({ ...legacy, userId }).userId).toBe(userId);
    }
    for (const userId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(putAppFileSchema.safeParse({ ...canonical, userId }).success).toBe(false);
    }
  });

  test("defaults user_files media indexing off and accepts an explicit request", () => {
    const base = { target: { domain: "user_files", namespace: "run-42" }, files: [textFile] };
    expect(putAppFileSchema.parse(base).target).toMatchObject({ indexMedia: false });
    expect(
      putAppFileSchema.parse({ ...base, target: { ...base.target, indexMedia: true } }).target,
    ).toMatchObject({ indexMedia: true });
  });

  test.each([
    { domain: "app_containers", appId: "com.example.app", container: "documents" },
    { domain: "media_library" },
  ])("rejects indexMedia on the $domain target", (target) => {
    expect(
      putAppFileSchema.safeParse({
        target: { ...target, indexMedia: true },
        files: [{ contentText: "hello", destinationPath: "photo.png" }],
      }).success,
    ).toBe(false);
  });

  test.each([
    {
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [textFile],
    },
    { target: { domain: "user_files", namespace: "run-42", reset: true }, files: [textFile] },
    {
      target: { domain: "media_library" },
      files: [{ destinationPath: "fixtures/welcome.png", contentBase64: "iVBORw0KGgo=" }],
    },
  ])("accepts target branch %#", (args) => {
    expect(putAppFileSchema.safeParse(args).success).toBe(true);
  });

  test("rejects media-library fixture names without a supported media extension", () => {
    expect(
      putAppFileSchema.safeParse({
        target: { domain: "media_library" },
        files: [{ destinationPath: "fixtures/payload", contentText: "not a media filename" }],
      }).success,
    ).toBe(false);
  });

  test.each(["clip.mkv", "clip.webm"])(
    "keeps Android media-library fixture format %s available",
    (destinationPath) => {
      expect(
        putAppFileSchema.safeParse({
          target: { domain: "media_library" },
          files: [{ destinationPath, contentBase64: "AQID" }],
        }).success,
      ).toBe(true);
    },
  );

  test("rejects extensionless media-library fixture names that look like an extension", () => {
    expect(
      putAppFileSchema.safeParse({
        target: { domain: "media_library" },
        files: [{ destinationPath: "fixtures/png", contentText: "not a media filename" }],
      }).success,
    ).toBe(false);
  });

  test("rejects NUL bytes in destination paths before media extension validation", () => {
    const destinationPath = `evil.sh${String.fromCharCode(0)}.png`;

    expect(() => normalizeAppFileRelativePath(destinationPath)).toThrow(/non-empty relative path/);
    expect(
      putAppFileSchema.safeParse({
        target: { domain: "media_library" },
        files: [{ destinationPath, contentText: "not a media filename" }],
      }).success,
    ).toBe(false);
  });

  test("leaves the media-library filename requirement to runtime validation", () => {
    const definitions = JSON.parse(readFileSync("schemas/tool-definitions.json", "utf8")) as Array<{
      name: string;
      inputSchema?: Record<string, unknown>;
    }>;
    const putAppFile = definitions.find((definition) => definition.name === "putAppFile");

    expect(putAppFile?.inputSchema?.if).toBeUndefined();
    expect(putAppFile?.inputSchema?.then).toBeUndefined();
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
    {
      target: {
        domain: "app_containers",
        appId: "com.example.app",
        container: "documents",
        namespace: "nope",
      },
      files: [textFile],
    },
    {
      target: { domain: "user_files", namespace: "../escape", appId: "com.example.app" },
      files: [textFile],
    },
    { target: { domain: "media_library", namespace: "nope" }, files: [textFile] },
    {
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [],
    },
    {
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ ...textFile, sourcePath: "/tmp/file" }],
    },
    {
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ ...textFile, destinationPath: "../escape" }],
    },
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
