import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { registerAppFileTools } from "../../src/server/appFileTools";
import {
  createAppFileServiceForTesting,
  nodeAppFileFileSystem,
  type AppFileService,
} from "../../src/server/appFileService";
import type {
  StageSharedStorageRequest,
  SharedStorageService,
} from "../../src/server/sharedStorageService";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("App file tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("registers putAppFile with discoverable schema fields", () => {
    registerAppFileTools();

    const toolDefinition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "putAppFile",
    );
    expect(toolDefinition).toBeDefined();
    expect(toolDefinition!.inputSchema.properties.target).toBeDefined();
    expect(toolDefinition!.inputSchema.properties.files).toBeDefined();
    expect(toolDefinition!.inputSchema.properties.appId).toBeUndefined();
    expect(toolDefinition!.inputSchema.properties.container).toBeUndefined();
    expect(toolDefinition!.inputSchema.properties.destinationPath).toBeUndefined();

    const validate = compileAjv2020(toolDefinition!.inputSchema);
    const target = { domain: "app_containers", appId: "com.example.app", container: "documents" };
    expect(validate({ target, files: [{ destinationPath: "missing-source.txt" }] })).toBe(false);
    expect(
      validate({
        target,
        files: [
          { destinationPath: "multiple-sources.txt", contentText: "x", contentBase64: "eA==" },
        ],
      }),
    ).toBe(true);
    expect(
      validate({ target, files: [{ destinationPath: "one-source.txt", contentText: "x" }] }),
    ).toBe(true);
  });

  test("user_files advertises defaulted target fields as optional", () => {
    registerAppFileTools();
    const definition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "putAppFile",
    )!;
    const validate = compileAjv2020(definition.inputSchema);
    expect(
      validate({
        target: { domain: "user_files", namespace: "fixtures" },
        files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
      }),
    ).toBe(true);
  });

  test("accepts a canonical local-source batch with nested destination paths", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    expect(
      tool!.schema.parse({
        platform: "ios",
        target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
        files: [
          {
            sourcePath: "/Users/me/fixtures/welcome.png",
            destinationPath: "fixtures/onboarding/welcome image.png",
          },
        ],
      }),
    ).toMatchObject({
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ destinationPath: "fixtures/onboarding/welcome image.png" }],
    });
  });

  test("accepts inline text and base64 binary content independently", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    expect(() =>
      tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        container: "documents",
        contentText: '{"enabled":false}',
        destinationPath: "config/experiments.json",
      }),
    ).not.toThrow();

    expect(() =>
      tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        container: "cache",
        contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
        destinationPath: "images/raw.bin",
      }),
    ).not.toThrow();
  });

  test("rejects invalid source combinations with actionable messages", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    const bothSources = tool!.schema.safeParse({
      platform: "android",
      appId: "com.example.app",
      container: "documents",
      sourcePath: "/tmp/a.json",
      contentText: "{}",
      destinationPath: "config/a.json",
    });
    expect(bothSources.success).toBe(false);
    expect(bothSources.error!.issues[0].message).toContain("Provide exactly one");

    const noSource = tool!.schema.safeParse({
      platform: "android",
      appId: "com.example.app",
      container: "documents",
      destinationPath: "config/a.json",
    });
    expect(noSource.success).toBe(false);
    expect(noSource.error!.issues[0].message).toContain("Provide exactly one");
  });

  test("rejects unsafe destination paths", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    for (const destinationPath of [
      "/absolute/file.txt",
      "../escape.txt",
      "safe/../../escape.txt",
      "",
    ]) {
      const result = tool!.schema.safeParse({
        platform: "android",
        appId: "com.example.app",
        container: "documents",
        contentText: "x",
        destinationPath,
      });
      expect(result.success).toBe(false);
      expect(result.error!.issues[0].message).toContain("relative path");
    }
  });

  test("registers a pending user_files write before it settles", async () => {
    const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
    const pending = Promise.withResolvers<Awaited<ReturnType<AppFileService["putFile"]>>>();
    const registrations: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];
    registerAppFileTools({
      appFileService: () => ({
        putFile: (() => pending.promise) as AppFileService["putFile"],
        listFiles: async () => {
          throw new Error("unused");
        },
        readFile: async () => {
          throw new Error("unused");
        },
      }),
      registerPendingDeviceCleanup: (deviceId, cleanup) => {
        registrations.push({ deviceId, cleanup });
      },
    });

    const resultPromise = ToolRegistry.getTool("putAppFile")!.deviceAwareHandler!(device, {
      target: { domain: "user_files", namespace: "run-42" },
      files: [{ contentText: "fixture", destinationPath: "photo.png" }],
    });
    expect(registrations).toEqual([{ deviceId: device.deviceId, cleanup: pending.promise }]);
    pending.resolve({
      success: true,
      deviceId: device.deviceId,
      platform: "android",
      target: { domain: "user_files", namespace: "run-42" },
      files: [],
    });
    await resultPromise;
  });

  test("putAppFile user_files delegates to shared storage with rollback", async () => {
    const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
    const calls: StageSharedStorageRequest[] = [];
    const sharedStorage: SharedStorageService = {
      stage: async (request) => {
        calls.push(request);
        return {
          success: true,
          deviceId: device.deviceId,
          platform: "android",
          namespace: request.namespace,
          userId: 0,
          userSource: "primary",
          destinationDirectory: `/storage/emulated/0/Download/${request.namespace}`,
          reset: request.reset ?? false,
          files: request.files.map((file) => ({
            destinationPath: file.destinationPath,
            byteCount: 3,
            mediaIndexing: { status: "completed" },
          })),
        };
      },
    };
    const fileSystem = {
      ...nodeAppFileFileSystem,
      stat: async () => ({
        size: 3,
        mtime: new Date(0),
        isFile: () => true,
        isDirectory: () => false,
      }),
    };
    registerAppFileTools({
      appFileService: () =>
        createAppFileServiceForTesting({ sharedStorageService: sharedStorage, fileSystem }),
      registerPendingDeviceCleanup: () => {},
    });
    const file = { sourcePath: "/fixtures/photo.png", destinationPath: "photo.png" };
    await ToolRegistry.getTool("putAppFile")!.deviceAwareHandler!(device, {
      target: { domain: "user_files", namespace: "run-42", reset: true, indexMedia: true },
      files: [file],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      device,
      namespace: "run-42",
      reset: true,
      indexMedia: true,
      files: [{ sourcePath: file.sourcePath, destinationPath: file.destinationPath }],
      signal: undefined,
      rollbackOnFailure: true,
    });
  });
});
