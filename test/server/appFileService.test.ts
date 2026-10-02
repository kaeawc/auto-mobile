import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  type ForegroundAppLookup,
  type AppFileFileSystem,
  type AppFileStats,
  createAppFileServiceForTesting,
  executeAndroidAppFileCommand,
  resolveAndroidTarget,
  type AppFileProvider,
  type AppFileWriteProvider,
  type PutAppFileProviderRequest,
} from "../../src/server/appFileService";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  APP_FILE_RESOURCE_TEMPLATES,
  parseAppFileResourceParams,
  type AppFileContainer,
} from "../../src/server/appFileContract";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  createSharedStorageServiceForTesting,
  type StageSharedStorageRequest,
} from "../../src/server/sharedStorageService";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { shellQuote } from "../../src/utils/shellQuote";

function execResult(stdout: string, stderr = "") {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

function adbFactoryFor(executor: FakeAdbExecutor): AdbClientFactory {
  return {
    create: () => executor,
  };
}

describe("AppFileService", () => {
  const iosSimulatorDevice: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone",
    platform: "ios",
  };

  test("selects the matching provider and passes normalized put requests", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };
    const androidProvider = new RecordingAppFileProvider("android");
    const iosProvider = new RecordingAppFileProvider("ios");
    const service = createAppFileServiceForTesting({
      providers: [androidProvider, iosProvider],
      deviceResolver: async () => {
        throw new Error("putFile already has a device");
      },
    });

    const result = await service.putFile({
      device: androidDevice,
      appId: "com.example.app",
      container: "documents",
      contentText: "hello",
      destinationPath: "./fixtures/welcome.txt",
    });

    expect(result).toMatchObject({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      appId: "com.example.app",
      container: "documents",
      destinationPath: "fixtures/welcome.txt",
      byteCount: 5,
    });
    expect(androidProvider.putRequests).toHaveLength(1);
    expect(androidProvider.putRequests[0]?.destinationPath).toBe("fixtures/welcome.txt");
    expect(androidProvider.putRequests[0]?.sourcePath).toContain("automobile-app-file-");
    expect(iosProvider.putRequests).toHaveLength(0);
  });

  test("rejects malformed base64 for direct service callers", async () => {
    const provider = new RecordingAppFileProvider("android");
    const service = createAppFileServiceForTesting({
      providers: [provider],
      deviceResolver: async () => {
        throw new Error("putFile already has a device");
      },
    });

    await expect(
      service.putFile({
        device: {
          deviceId: "emulator-5554",
          name: "Pixel",
          platform: "android",
        },
        appId: "com.example.app",
        container: "documents",
        contentBase64: "%%%not-base64%%%",
        destinationPath: "fixture.bin",
      }),
    ).rejects.toThrow("contentBase64 must be valid, non-empty base64.");
    expect(provider.putRequests).toEqual([]);
  });

  test("iOS put resource URI has no Android user query", async () => {
    const provider = new RecordingAppFileProvider("ios");
    const service = createAppFileServiceForTesting({
      providers: [provider],
      fileSystem: new TestAppFileFileSystem(),
    });
    const result = await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "documents",
      userId: 10,
      contentText: "hello",
      destinationPath: "welcome.txt",
    });
    expect(result.resourceUri).toBe(
      `automobile:devices/${iosSimulatorDevice.deviceId}/apps/com.example.app/files/documents/welcome.txt`,
    );
  });

  test("routes a normalized canonical batch by platform and logical domain", async () => {
    const provider = new RecordingStorageWriteProvider("android", "user_files", {
      effects: [{ type: "media_index", status: "notRequested", reason: "not media" }],
    });
    const service = createAppFileServiceForTesting({ providers: [provider] });

    const result = await service.putFile({
      device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      target: { domain: "user_files", namespace: " run-42 ", reset: true, indexMedia: true },
      files: [
        { contentText: "one", destinationPath: "./one.txt" },
        { contentBase64: Buffer.from("two").toString("base64"), destinationPath: "nested/two.txt" },
      ],
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      target: { domain: "user_files", namespace: "run-42", reset: true, indexMedia: true },
      files: [
        {
          destinationPath: "one.txt",
          byteCount: 3,
          effects: [{ type: "media_index", status: "notRequested", reason: "not media" }],
        },
        {
          destinationPath: "nested/two.txt",
          byteCount: 3,
          effects: [{ type: "media_index", status: "notRequested", reason: "not media" }],
        },
      ],
    });
    expect(provider.requests.map((request) => request.destinationPath)).toEqual([
      "one.txt",
      "nested/two.txt",
    ]);
    expect(provider.requests.every((request) => request.target.domain === "user_files")).toBe(true);
    expect(provider.requests.map((request) => request.target)).toEqual([
      { domain: "user_files", namespace: "run-42", reset: true, indexMedia: true },
      { domain: "user_files", namespace: "run-42", reset: false, indexMedia: true },
    ]);
  });

  test("stages user_files in the resolved profile Downloads namespace with document-picker effects", async () => {
    const executor = new FakeAdbExecutor();
    let resolveCalls = 0;
    const sharedStorageService = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          expect(request?.explicitUserId).toBe(10);
          resolveCalls += 1;
          return { userId: 10, source: "managedProfile" };
        },
      }),
    });
    const service = createAppFileServiceForTesting({ sharedStorageService });

    const result = await service.putFile({
      device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      target: { domain: "user_files", namespace: "picker-run", reset: true },
      userId: 10,
      files: [
        { contentText: "one", destinationPath: "docs/one.txt" },
        { contentText: "two", destinationPath: "docs/two.txt" },
      ],
    });

    expect(result.files.map((file) => file.effects[0])).toEqual([
      {
        type: "document_picker",
        status: "completed",
        reason:
          "document fixture is available in Downloads for device emulator-5554, resolved profile 10, namespace picker-run",
      },
      {
        type: "document_picker",
        status: "completed",
        reason:
          "document fixture is available in Downloads for device emulator-5554, resolved profile 10, namespace picker-run",
      },
    ]);
    expect(
      executor
        .getExecutedCommands()
        .filter((command) => command === "shell rm -rf '/storage/emulated/10/Download/picker-run'"),
    ).toHaveLength(1);
    expect(
      executor
        .getExecutedArgv()
        .filter((args) => args[0] === "push")
        .every((args) => args[2]?.startsWith("/storage/emulated/10/Download/picker-run/")),
    ).toBe(true);
    expect(resolveCalls).toBe(1);
  });

  test.each([true, false, undefined])(
    "passes user_files indexMedia=%p to staging and reports its effect",
    async (indexMedia) => {
      const staged: StageSharedStorageRequest[] = [];
      const service = createAppFileServiceForTesting({
        fileSystem: new TestAppFileFileSystem(),
        sharedStorageService: {
          stage: async (request) => {
            staged.push(request);
            return {
              success: true,
              deviceId: request.device.deviceId,
              platform: "android",
              namespace: request.namespace,
              userId: 0,
              userSource: "primary",
              destinationDirectory: `/storage/emulated/0/Download/${request.namespace}`,
              reset: request.reset ?? false,
              files: request.files.map((file) => ({
                destinationPath: file.destinationPath,
                byteCount: 3,
                mediaIndexing: {
                  status: request.indexMedia ? "completed" : "notRequested",
                },
              })),
            };
          },
        },
      });
      const result = await service.putFile({
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        target: { domain: "user_files", namespace: "run-42", indexMedia },
        files: [{ contentBase64: "AQID", destinationPath: "photo.png" }],
      });

      expect(staged).toHaveLength(1);
      expect(staged[0]?.indexMedia).toBe(indexMedia ?? false);
      expect(result.files[0]?.effects).toContainEqual({
        type: "media_index",
        status: indexMedia ? "completed" : "notRequested",
      });
    },
  );

  test("stages media_library fixtures through the bounded AutoMobile namespace after MediaStore verification", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const sharedStorageService = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          expect(request?.explicitUserId).toBe(12);
          return { userId: 12, source: "managedProfile" };
        },
      }),
    });
    const service = createAppFileServiceForTesting({ sharedStorageService });

    const result = await service.putFile({
      device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      target: { domain: "media_library" },
      userId: 12,
      files: [
        { contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "photo.png" },
      ],
    });

    expect(result.files[0]?.effects).toEqual([
      {
        type: "media_index",
        status: "completed",
        reason:
          "MediaStore verified fixture discovery for device emulator-5554, resolved profile 12, namespace automobile-media",
      },
    ]);
    expect(executor.getExecutedArgv()).toContainEqual([
      "push",
      expect.stringContaining("automobile-app-file-"),
      "/storage/emulated/12/Download/automobile-media/photo.png",
    ]);
    expect(
      executor.getExecutedCommands().some((command) => command.includes("content query")),
    ).toBe(true);
  });

  test("rolls back earlier media files when writing the third of five fails", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    executor.setCommandError("third.png", new Error("index query failed"));
    const sharedStorageService = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async () => ({ userId: 12, source: "managedProfile" }),
      }),
    });
    const service = createAppFileServiceForTesting({ sharedStorageService });

    await expect(
      service.putFile({
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        target: { domain: "media_library" },
        files: ["first", "second", "third", "fourth", "fifth"].map((name) => ({
          contentBase64: "AQID",
          destinationPath: `${name}.png`,
        })),
      }),
    ).rejects.toThrow(
      "failed for third.png: Android shared-storage operation failed: index query failed Rolled back: second.png, first.png",
    );

    expect(executor.getExecutedArgv().filter((args) => args[0] === "push")).toHaveLength(3);
    expect(
      executor.getExecutedCommands().filter((command) => command.includes("shell rm -f")),
    ).toEqual([
      "shell rm -f '/storage/emulated/12/Download/automobile-media/second.png'",
      "shell rm -f '/storage/emulated/12/Download/automobile-media/first.png'",
    ]);
  });

  test("rolls back the staged prefix when MediaStore indexing fails", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponseSequence("content query", [
      execResult("Row: 0 _id=42"),
      execResult("Row: 0 _id=42"),
      execResult(""),
    ]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sharedStorageService = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      timer,
      createUserResolver: () => ({
        resolve: async () => ({ userId: 12, source: "managedProfile" }),
      }),
    });
    const service = createAppFileServiceForTesting({ sharedStorageService });

    await expect(
      service.putFile({
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        target: { domain: "media_library" },
        files: ["first", "second", "third", "fourth", "fifth"].map((name) => ({
          contentBase64: "AQID",
          destinationPath: `${name}.png`,
        })),
      }),
    ).rejects.toThrow(
      "failed for third.png: Android media indexing did not complete for /storage/emulated/12/Download/automobile-media/third.png within 5 seconds. Rolled back: third.png, second.png, first.png",
    );

    expect(executor.getExecutedArgv().filter((args) => args[0] === "push")).toHaveLength(3);
    expect(
      executor.getExecutedCommands().filter((command) => command.includes("shell rm -f")),
    ).toHaveLength(3);
  });

  test("validates the entire media batch before writing any file", async () => {
    const executor = new FakeAdbExecutor();
    const sharedStorageService = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async () => ({ userId: 12, source: "managedProfile" }),
      }),
    });
    const service = createAppFileServiceForTesting({ sharedStorageService });

    await expect(
      service.putFile({
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        target: { domain: "media_library" },
        files: [
          { contentBase64: "AQID", destinationPath: "first.png" },
          { contentBase64: "BAUG", destinationPath: "unsupported.txt" },
        ],
      }),
    ).rejects.toThrow("supported by Android MediaStore");

    expect(executor.getExecutedCommands()).toEqual([]);
    expect(executor.getExecutedArgv()).toEqual([]);
  });

  test("reports and warns when rolling back a media file fails", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    executor.setCommandError("third.png", new Error("index query failed"));
    executor.setCommandError(
      "shell rm -f '/storage/emulated/12/Download/automobile-media/second.png'",
      new Error("device unavailable"),
    );
    const sharedStorageService = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async () => ({ userId: 12, source: "managedProfile" }),
      }),
    });
    const service = createAppFileServiceForTesting({ sharedStorageService });
    const warnings: string[] = [];
    const warnSpy = spyOn(logger, "warn").mockImplementation((message) => warnings.push(message));

    try {
      await expect(
        service.putFile({
          device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
          target: { domain: "media_library" },
          files: ["first", "second", "third"].map((name) => ({
            contentBase64: "AQID",
            destinationPath: `${name}.png`,
          })),
        }),
      ).rejects.toThrow(
        "Rollback failures: second.png: Android shared-storage operation failed: device unavailable",
      );
    } finally {
      warnSpy.mockRestore();
    }

    const rollbackWarnings = warnings.filter((message) =>
      message.includes("[SharedStorage] Failed to roll back staged media file"),
    );
    expect(rollbackWarnings).toHaveLength(1);
    expect(rollbackWarnings[0]).toContain("second.png");
  });

  test("imports iOS Simulator media through an injected argv-safe client and preserves filenames", async () => {
    const fileSystem = new TestAppFileFileSystem();
    const imports: Array<{ deviceId: string; paths: string[] }> = [];
    const service = createAppFileServiceForTesting({
      fileSystem,
      iosSimulatorMediaClient: {
        importMedia: async (device, paths) => {
          imports.push({ deviceId: device.deviceId, paths: [...paths] });
        },
      },
    });

    const result = await service.putFile({
      device: iosSimulatorDevice,
      target: { domain: "media_library" },
      files: [
        { destinationPath: "fixtures/photo.png", contentBase64: "AQID" },
        { destinationPath: "clips/demo.mov", contentBase64: "BAUG" },
      ],
    });

    expect(imports).toEqual([
      {
        deviceId: iosSimulatorDevice.deviceId,
        paths: [expect.stringMatching(/photo\.png$/), expect.stringMatching(/demo\.mov$/)],
      },
    ]);
    expect(result.files.map((file) => file.effects)).toEqual([
      [
        expect.objectContaining({ type: "media_import", status: "completed" }),
        expect.objectContaining({ type: "picker_visibility", status: "unavailable" }),
      ],
      [
        expect.objectContaining({ type: "media_import", status: "completed" }),
        expect.objectContaining({ type: "picker_visibility", status: "unavailable" }),
      ],
    ]);
  });

  test("rejects iOS physical-device media-library mutation before importing", async () => {
    let importCalls = 0;
    const service = createAppFileServiceForTesting({
      iosSimulatorMediaClient: {
        importMedia: async () => {
          importCalls += 1;
        },
      },
    });

    await expect(
      service.putFile({
        device: { deviceId: "00008110-001234567890801E", name: "iPhone", platform: "ios" },
        target: { domain: "media_library" },
        files: [{ destinationPath: "photo.png", contentBase64: "AQID" }],
      }),
    ).rejects.toThrow("only supported on iOS simulators");
    expect(importCalls).toBe(0);
  });

  test("prepares every file and rejects conflicts before provider mutation", async () => {
    const provider = new RecordingStorageWriteProvider("android", "app_containers");
    const service = createAppFileServiceForTesting({ providers: [provider] });
    const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

    await expect(
      service.putFile({
        device,
        target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
        files: [
          { contentText: "first", destinationPath: "fixtures" },
          { contentText: "second", destinationPath: "fixtures/nested.txt" },
        ],
      }),
    ).rejects.toThrow("conflicts with another file");
    expect(provider.requests).toEqual([]);
  });

  test("cleans prepared temporary sources when a provider write fails", async () => {
    const fileSystem = new TestAppFileFileSystem();
    const provider = new RecordingStorageWriteProvider(
      "android",
      "app_containers",
      undefined,
      new Error("write failed"),
    );
    const service = createAppFileServiceForTesting({ providers: [provider], fileSystem });

    await expect(
      service.putFile({
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
        files: [{ contentText: "hello", destinationPath: "fixture.txt" }],
      }),
    ).rejects.toThrow("write failed");
    expect(fileSystem.removedPaths).toHaveLength(1);
  });

  test("rejects unsafe service input before provider selection", async () => {
    const provider = new RecordingAppFileProvider("android");
    const service = createAppFileServiceForTesting({
      providers: [provider],
      deviceResolver: async () => {
        throw new Error("device resolver should not be called");
      },
    });
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };

    await expect(
      service.putFile({
        device,
        appId: "../com.example.app",
        container: "documents",
        contentText: "hello",
        destinationPath: "fixtures/welcome.txt",
      }),
    ).rejects.toThrow(
      "appId must be a non-empty app identifier without path separators or traversal segments",
    );

    await expect(
      service.putFile({
        device,
        appId: "com.example.app",
        container: "documents",
        contentText: "hello",
        destinationPath: "/absolute.txt",
      }),
    ).rejects.toThrow(
      "destinationPath must be a non-empty relative path without '.' or '..' segments",
    );

    expect(provider.putRequests).toHaveLength(0);
  });

  test("maps unsupported platform capabilities to explicit operation errors", async () => {
    const service = createAppFileServiceForTesting({
      providers: [new RecordingAppFileProvider("android")],
      deviceResolver: async (deviceId) => ({
        deviceId,
        name: "iPhone",
        platform: "ios",
      }),
    });

    await expect(
      service.listFiles({
        deviceId: "sim-1",
        appId: "com.example.app",
        container: "documents",
      }),
    ).rejects.toThrow("listFiles is not supported for appId com.example.app in documents on ios");
  });

  test("writes Android inline content through run-as and returns stable response metadata", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
    });
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };

    const result = await service.putFile({
      device,
      appId: "com.example.app",
      container: "documents",
      userId: 0,
      contentText: "hello",
      destinationPath: "fixtures/welcome file.txt",
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      appId: "com.example.app",
      container: "documents",
      destinationPath: "fixtures/welcome file.txt",
      byteCount: 5,
      resourceUri:
        "automobile:devices/emulator-5554/apps/com.example.app/files/documents/fixtures/welcome%20file.txt?userId=0",
    });

    const commands = adbFactory.getFakeClient().getAllCommands();
    expect(commands[0]).toContain("push ");
    expect(adbFactory.getFakeClient().getCommandCalls()[0]?.timeoutMs).toBe(120_000);
    expect(commands[1]).toContain("shell run-as 'com.example.app' sh -c");
    expect(commands[1]).toContain("mkdir -p");
    expect(commands[1]).toContain("files/fixtures");
    expect(commands[1]).toContain("cp ");
    expect(commands[1]).toContain("/data/local/tmp/automobile-");
    expect(commands[1]).toContain("files/fixtures/welcome file.txt");
    expect(commands[2]).toContain("shell rm -f '/data/local/tmp/automobile-");
  });

  test("putFile uses the exact run-as command for explicit primary and work-profile users", async () => {
    for (const userId of [0, 10]) {
      const adbFactory = new FakeAdbClientFactory();
      const service = createAppFileServiceForTesting({
        adbFactory,
        idGenerator: new CountingIdGenerator("tmp"),
      });
      await service.putFile({
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        appId: "com.example.app",
        container: "documents",
        contentText: "hello",
        destinationPath: "fixtures/welcome.txt",
        userId,
      });
      const script =
        "mkdir -p 'files/fixtures' && " +
        "cp '/data/local/tmp/automobile-tmp-1-welcome.txt' 'files/fixtures/welcome.txt' && " +
        "chmod 600 'files/fixtures/welcome.txt'";
      expect(adbFactory.getFakeClient().getAllCommands()[1]).toBe(
        `shell run-as 'com.example.app'${userId === 10 ? " --user 10" : ""} sh -c ${shellQuote(script)}`,
      );
      expect(adbFactory.getFakeClient().getAllCommands()).toHaveLength(3);
    }
  });

  test("listFiles uses the exact run-as command for explicit primary and work-profile users", async () => {
    for (const userId of [0, 10]) {
      const adbFactory = new FakeAdbClientFactory();
      const service = createAppFileServiceForTesting({
        adbFactory,
        deviceResolver: async () => ({
          deviceId: "emulator-5554",
          name: "Pixel",
          platform: "android",
        }),
      });
      await service.listFiles({
        deviceId: "emulator-5554",
        appId: "com.example.app",
        container: "documents",
        userId,
      });
      const script = "if [ -d 'files' ]; then find 'files' -exec stat -c '%F|%s|%Y|%n' {} \\; ; fi";
      expect(adbFactory.getFakeClient().getLastCommand()).toBe(
        `shell run-as 'com.example.app'${userId === 10 ? " --user 10" : ""} sh -c ${shellQuote(script)}`,
      );
      expect(adbFactory.getFakeClient().getAllCommands()).toHaveLength(1);
    }
  });

  test("readFile uses the exact run-as command for explicit primary and work-profile users", async () => {
    for (const userId of [0, 10]) {
      const adbFactory = new FakeAdbClientFactory();
      const service = createAppFileServiceForTesting({
        adbFactory,
        deviceResolver: async () => ({
          deviceId: "emulator-5554",
          name: "Pixel",
          platform: "android",
        }),
      });
      await service.readFile({
        deviceId: "emulator-5554",
        appId: "com.example.app",
        container: "documents",
        path: "fixtures/welcome.txt",
        userId,
      });
      expect(adbFactory.getFakeClient().getLastCommand()).toBe(
        `shell run-as 'com.example.app'${userId === 10 ? " --user 10" : ""} base64 'files/fixtures/welcome.txt'`,
      );
      expect(adbFactory.getFakeClient().getAllCommands()).toHaveLength(1);
    }
  });

  test("rejects unsafe Android run-as user IDs before issuing ADB commands", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });
    for (const userId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        service.listFiles({
          deviceId: "emulator-5554",
          appId: "com.example.app",
          container: "documents",
          userId,
        }),
      ).rejects.toThrow("Android userId must be a non-negative safe integer.");
    }
    expect(adbFactory.getFakeClient().getAllCommands()).toHaveLength(0);
  });

  test("uses a transfer budget for Android externalFiles pushes", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({ adbFactory });

    await service.putFile({
      device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
      contentText: "hello",
      destinationPath: "fixtures/welcome.txt",
    });

    const calls = adbFactory.getFakeClient().getCommandCalls();
    expect(calls.find((call) => call.command.startsWith("push "))?.timeoutMs).toBe(120_000);
    expect(calls.find((call) => call.command.startsWith("shell mkdir"))?.timeoutMs).toBeUndefined();
  });

  test("sources the run-as temp path token from the injected IdGenerator", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      idGenerator: new CountingIdGenerator("tmp"),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
    });
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };

    await service.putFile({
      device,
      appId: "com.example.app",
      container: "documents",
      userId: 0,
      contentText: "hello",
      destinationPath: "fixtures/welcome.txt",
    });

    const commands = adbFactory.getFakeClient().getAllCommands();
    // Deterministic token proves randomUUID() was routed onto the IdGenerator seam (issue #3511).
    expect(commands[0]).toContain("/data/local/tmp/automobile-tmp-1-welcome.txt");
    expect(commands[2]).toContain("/data/local/tmp/automobile-tmp-1-welcome.txt");
  });

  test("lists missing Android containers as empty instead of failing find", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    const result = await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "documents",
      userId: 0,
    });

    expect(result.files).toEqual([]);
    expect(adbFactory.getFakeClient().getLastCommand()).toContain("if [ -d");
    expect(adbFactory.getFakeClient().getLastCommand()).toContain("find");
    expect(adbFactory.getFakeClient().getLastCommand()).toContain("files");
  });

  test("rejects Android app IDs that could escape external storage app paths", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
    });
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };

    await expect(
      service.putFile({
        device,
        appId: "../other.app",
        container: "externalFiles",
        userId: 0,
        contentText: "hello",
        destinationPath: "fixtures/welcome.txt",
      }),
    ).rejects.toThrow(
      "appId must be a non-empty app identifier without path separators or traversal segments",
    );

    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("writes iOS files through the provider resolved app data container", async () => {
    const fileSystem = new TestAppFileFileSystem();
    const dataRoot = "/simulators/SIM-1/data";
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      dataRoot,
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem,
    });

    const result = await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "library",
      contentText: "hello ios",
      destinationPath: "Support/config.txt",
    });

    expect(result).toMatchObject({
      success: true,
      deviceId: iosSimulatorDevice.deviceId,
      platform: "ios",
      appId: "com.example.app",
      container: "library",
      destinationPath: "Support/config.txt",
      byteCount: 9,
    });
    await expect(
      fileSystem.readText(join(dataRoot, "Library", "Support", "config.txt")),
    ).resolves.toBe("hello ios");
  });

  test("stages an iOS app file beside its destination before replacing it", async () => {
    const target = "/simulators/SIM-1/data/Documents/fixtures/value.txt";
    const writes: string[] = [];
    class TrackingFileSystem extends TestAppFileFileSystem {
      override async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
        writes.push(`copy:${destinationPath}`.replaceAll("\\", "/"));
        await super.copyFile(sourcePath, destinationPath);
      }

      override async rename(oldPath: string, newPath: string): Promise<void> {
        writes.push(`rename:${oldPath}:${newPath}`.replaceAll("\\", "/"));
        await super.rename(oldPath, newPath);
      }
    }
    const fileSystem = new TrackingFileSystem();
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      "/simulators/SIM-1/data",
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as unknown as SimCtlClient,
      fileSystem,
    });

    await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "documents",
      contentText: "complete",
      destinationPath: "fixtures/value.txt",
    });

    expect(await fileSystem.readText(target)).toBe("complete");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toStartWith(`copy:${dirname(target)}/.value.txt.`);
    expect(writes[0]).toEndWith(".tmp");
    expect(writes[1]).toBe(`rename:${writes[0]!.slice(5)}:${target}`);
    expect(await fileSystem.readdir(dirname(target))).toEqual([{ name: "value.txt" }]);
  });

  for (const destinationExists of [true, false]) {
    test(`preserves ${destinationExists ? "existing" : "absent"} iOS destination after a partial copy`, async () => {
      const target = "/simulators/SIM-1/data/Documents/fixtures/value.txt";
      const failure = new Error("copy failed");
      class FailingCopyFileSystem extends TestAppFileFileSystem {
        override async copyFile(_sourcePath: string, destinationPath: string): Promise<void> {
          await this.writeFileBuffer(destinationPath, Buffer.from("partial"));
          throw failure;
        }
      }
      const fileSystem = new FailingCopyFileSystem();
      if (destinationExists) {
        await fileSystem.writeFileBuffer(target, Buffer.from("original"));
      }
      const simctl = new FakeSimCtlClient();
      simctl.setCommandResult(
        `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
        "/simulators/SIM-1/data",
      );
      const service = createAppFileServiceForTesting({
        simctlFactory: () => simctl as unknown as SimCtlClient,
        fileSystem,
      });

      await expect(
        service.putFile({
          device: iosSimulatorDevice,
          appId: "com.example.app",
          container: "documents",
          contentText: "replacement",
          destinationPath: "fixtures/value.txt",
        }),
      ).rejects.toBe(failure);

      if (destinationExists) {
        expect(await fileSystem.readText(target)).toBe("original");
      } else {
        await expect(fileSystem.readText(target)).rejects.toThrow();
      }
      expect(await fileSystem.readdir(dirname(target))).toEqual(
        destinationExists ? [{ name: "value.txt" }] : [],
      );
      expect(fileSystem.removedPaths.filter((path) => path.includes(".value.txt."))).toHaveLength(
        1,
      );
    });
  }

  test("removes the iOS temporary file when rename fails", async () => {
    const target = "/simulators/SIM-1/data/Documents/fixtures/value.txt";
    const failure = new Error("rename failed");
    class FailingRenameFileSystem extends TestAppFileFileSystem {
      override async rename(): Promise<void> {
        throw failure;
      }
    }
    const fileSystem = new FailingRenameFileSystem();
    await fileSystem.writeFileBuffer(target, Buffer.from("original"));
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      "/simulators/SIM-1/data",
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as unknown as SimCtlClient,
      fileSystem,
    });

    await expect(
      service.putFile({
        device: iosSimulatorDevice,
        appId: "com.example.app",
        container: "documents",
        contentText: "replacement",
        destinationPath: "fixtures/value.txt",
      }),
    ).rejects.toBe(failure);

    expect(await fileSystem.readText(target)).toBe("original");
    expect(await fileSystem.readdir(dirname(target))).toEqual([{ name: "value.txt" }]);
    expect(fileSystem.removedPaths.filter((path) => path.includes(".value.txt."))).toHaveLength(1);
  });

  test("serializes concurrent iOS puts to the same destination", async () => {
    const target = "/simulators/SIM-1/data/Documents/fixtures/value.txt";
    const writes: string[] = [];
    class TrackingFileSystem extends TestAppFileFileSystem {
      override async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
        writes.push(`copy:start:${destinationPath}`.replaceAll("\\", "/"));
        await Promise.resolve();
        await super.copyFile(sourcePath, destinationPath);
        writes.push(`copy:end:${destinationPath}`.replaceAll("\\", "/"));
      }

      override async rename(oldPath: string, newPath: string): Promise<void> {
        writes.push(`rename:${oldPath}:${newPath}`.replaceAll("\\", "/"));
        await super.rename(oldPath, newPath);
      }
    }
    const fileSystem = new TrackingFileSystem();
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      "/simulators/SIM-1/data",
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as unknown as SimCtlClient,
      fileSystem,
    });
    const put = (contentText: string) =>
      service.putFile({
        device: iosSimulatorDevice,
        appId: "com.example.app",
        container: "documents",
        contentText,
        destinationPath: "fixtures/value.txt",
      });

    await Promise.all([put("first complete payload"), put("second complete payload")]);

    expect(writes).toHaveLength(6);
    expect(writes[0]).toStartWith("copy:start:");
    expect(writes[1]).toBe(writes[0]!.replace("copy:start:", "copy:end:"));
    expect(writes[2]).toStartWith("rename:");
    expect(writes[3]).toStartWith("copy:start:");
    expect(writes[4]).toBe(writes[3]!.replace("copy:start:", "copy:end:"));
    expect(writes[5]).toStartWith("rename:");
    expect(["first complete payload", "second complete payload"]).toContain(
      await fileSystem.readText(target),
    );
    expect(await fileSystem.readdir(dirname(target))).toEqual([{ name: "value.txt" }]);
  });

  test("maps iOS logical containers to simulator data container folders", async () => {
    const fileSystem = new TestAppFileFileSystem();
    const dataRoot = "/simulators/SIM-1/data";
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      dataRoot,
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem,
    });

    await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "documents",
      contentText: "documents",
      destinationPath: "fixtures/value.txt",
    });
    await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "cache",
      contentText: "cache",
      destinationPath: "fixtures/value.txt",
    });
    await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "tmp",
      contentText: "tmp",
      destinationPath: "fixtures/value.txt",
    });

    await expect(
      fileSystem.readText(join(dataRoot, "Documents", "fixtures", "value.txt")),
    ).resolves.toBe("documents");
    await expect(
      fileSystem.readText(join(dataRoot, "Library", "Caches", "fixtures", "value.txt")),
    ).resolves.toBe("cache");
    await expect(fileSystem.readText(join(dataRoot, "tmp", "fixtures", "value.txt"))).resolves.toBe(
      "tmp",
    );
  });

  test("preserves iOS binary app files exactly when writing and reading", async () => {
    const fileSystem = new TestAppFileFileSystem();
    const dataRoot = "/simulators/SIM-1/data";
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      dataRoot,
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem,
      deviceResolver: async () => iosSimulatorDevice,
    });
    const sourceBytes = Buffer.from([0, 1, 2, 239, 187, 191, 255]);
    const sourcePath = "/host/fixtures/source.bin";
    await fileSystem.writeFileBuffer(sourcePath, sourceBytes);

    const putResult = await service.putFile({
      device: iosSimulatorDevice,
      appId: "com.example.app",
      container: "documents",
      sourcePath,
      destinationPath: "fixtures/welcome.bin",
    });
    const readResult = await service.readFile({
      deviceId: iosSimulatorDevice.deviceId,
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/welcome.bin",
    });

    expect(putResult.byteCount).toBe(sourceBytes.byteLength);
    expect(readResult).toMatchObject({
      deviceId: iosSimulatorDevice.deviceId,
      platform: "ios",
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/welcome.bin",
      byteCount: sourceBytes.byteLength,
      mimeType: "application/octet-stream",
      blob: sourceBytes.toString("base64"),
    });
    expect(readResult.text).toBeUndefined();
  });

  test("resolves relative sourcePath from the daemon launch working directory", async () => {
    const previousLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
    const launchCwd = resolve("/launch/cwd");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    try {
      const fileSystem = new TestAppFileFileSystem();
      const dataRoot = "/simulators/SIM-1/data";
      const simctl = new FakeSimCtlClient();
      simctl.setCommandResult(
        `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
        dataRoot,
      );
      const service = createAppFileServiceForTesting({
        simctlFactory: () => simctl as any,
        fileSystem,
      });
      const sourceBytes = Buffer.from("from launch cwd");
      await fileSystem.writeFileBuffer(join(launchCwd, "fixtures", "source.bin"), sourceBytes);

      const result = await service.putFile({
        device: iosSimulatorDevice,
        appId: "com.example.app",
        container: "documents",
        sourcePath: "./fixtures/source.bin",
        destinationPath: "fixtures/copied.bin",
      });

      expect(result.byteCount).toBe(sourceBytes.byteLength);
      await expect(
        fileSystem.readFileBuffer(join(dataRoot, "Documents", "fixtures", "copied.bin")),
      ).resolves.toEqual(sourceBytes);
    } finally {
      if (previousLaunchCwd === undefined) {
        delete process.env[DAEMON_LAUNCH_CWD_ENV];
      } else {
        process.env[DAEMON_LAUNCH_CWD_ENV] = previousLaunchCwd;
      }
    }
  });

  test("lists iOS app files and directories with relative metadata only", async () => {
    const fileSystem = new TestAppFileFileSystem();
    const dataRoot = "/simulators/SIM-1/data";
    await fileSystem.mkdir(join(dataRoot, "Documents", "fixtures"));
    await fileSystem.writeFileBuffer(join(dataRoot, "Documents", "root.txt"), Buffer.from("root"));
    await fileSystem.writeFileBuffer(
      join(dataRoot, "Documents", "fixtures", "welcome.png"),
      Buffer.from([0, 1, 2]),
    );
    fileSystem.setSymlink(join(dataRoot, "Documents", "broken-link"));
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      dataRoot,
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem,
      deviceResolver: async () => iosSimulatorDevice,
    });

    const result = await service.listFiles({
      deviceId: iosSimulatorDevice.deviceId,
      appId: "com.example.app",
      container: "documents",
    });

    expect(result.files.map((file) => file.path).sort()).toEqual([
      "fixtures",
      "fixtures/welcome.png",
      "root.txt",
    ]);
    expect(result.files.every((file) => !file.path.startsWith(dataRoot))).toBe(true);
    expect(result.files.find((file) => file.path === "fixtures")).toMatchObject({
      name: "fixtures",
      isDirectory: true,
      resourceUri: `automobile:devices/${iosSimulatorDevice.deviceId}/apps/com.example.app/files/documents/fixtures`,
    });
    const fileEntry = result.files.find((file) => file.path === "fixtures/welcome.png");
    expect(fileEntry).toMatchObject({
      name: "welcome.png",
      byteCount: 3,
      isDirectory: false,
      resourceUri: `automobile:devices/${iosSimulatorDevice.deviceId}/apps/com.example.app/files/documents/fixtures/welcome.png`,
    });
    expect(fileEntry?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns clear iOS simulator-only errors without invoking simctl for physical devices", async () => {
    const simctl = new FakeSimCtlClient();
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem: new TestAppFileFileSystem(),
      deviceResolver: async (deviceId) => ({ deviceId, name: "iPhone", platform: "ios" }),
    });
    const physicalDevice: BootedDevice = {
      deviceId: "00008030-001A2B3C0E11002E",
      name: "iPhone",
      platform: "ios",
    };

    await expect(
      service.putFile({
        device: physicalDevice,
        appId: "com.example.app",
        container: "documents",
        contentText: "hello",
        destinationPath: "config.txt",
      }),
    ).rejects.toThrow("iOS app file putFile is only supported on iOS simulators");

    await expect(
      service.listFiles({
        deviceId: physicalDevice.deviceId,
        appId: "com.example.app",
        container: "documents",
      }),
    ).rejects.toThrow("iOS app file listFiles is only supported on iOS simulators");
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("maps missing iOS app containers to actionable simulator errors", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.missing.app' data`,
      new Error(
        "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2): The application is not installed.",
      ),
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem: new TestAppFileFileSystem(),
      deviceResolver: async () => iosSimulatorDevice,
    });

    await expect(
      service.readFile({
        deviceId: iosSimulatorDevice.deviceId,
        appId: "com.missing.app",
        container: "documents",
        path: "config.json",
      }),
    ).rejects.toThrow("iOS app com.missing.app is not installed on simulator");
  });

  test("maps unavailable iOS simulators to actionable errors", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      `get_app_container '${iosSimulatorDevice.deviceId}' 'com.example.app' data`,
      new Error("No such device or device is shutdown"),
    );
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem: new TestAppFileFileSystem(),
      deviceResolver: async () => iosSimulatorDevice,
    });

    await expect(
      service.listFiles({
        deviceId: iosSimulatorDevice.deviceId,
        appId: "com.example.app",
        container: "documents",
      }),
    ).rejects.toThrow(
      "iOS simulator AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE is unavailable or not booted",
    );
  });

  test("does not let iOS app file paths escape the resolved app container", async () => {
    const simctl = new FakeSimCtlClient();
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem: new TestAppFileFileSystem(),
      deviceResolver: async () => iosSimulatorDevice,
    });

    await expect(
      service.readFile({
        deviceId: iosSimulatorDevice.deviceId,
        appId: "com.example.app",
        container: "documents",
        path: "../Library/Preferences/config.plist",
      }),
    ).rejects.toThrow(
      "destinationPath must be a non-empty relative path without '.' or '..' segments",
    );

    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("maps iOS externalFiles to explicit unsupported capability errors", async () => {
    const simctl = new FakeSimCtlClient();
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      fileSystem: new TestAppFileFileSystem(),
      deviceResolver: async (deviceId) => ({ deviceId, name: "iPhone", platform: "ios" }),
    });
    const device: BootedDevice = {
      deviceId: iosSimulatorDevice.deviceId,
      name: "iPhone",
      platform: "ios",
    };

    await expect(
      service.putFile({
        device,
        appId: "com.example.app",
        container: "externalFiles",
        contentText: "hello",
        destinationPath: "config.txt",
      }),
    ).rejects.toThrow("putFile is not supported for appId com.example.app in externalFiles on ios");

    await expect(
      service.listFiles({
        deviceId: iosSimulatorDevice.deviceId,
        appId: "com.example.app",
        container: "externalFiles",
      }),
    ).rejects.toThrow(
      "listFiles is not supported for appId com.example.app in externalFiles on ios",
    );

    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("uses an expanded ADB maxBuffer when reading Android app files as base64", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "documents",
      userId: 0,
      path: "screenshots/home.png",
    });
    await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
      path: "screenshots/home.png",
    });

    const calls = adbFactory.getFakeClient().getCommandCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toContain("shell run-as 'com.example.app' base64");
    expect(calls[0]?.maxBuffer).toBeGreaterThan(1024 * 1024);
    expect(calls[1]?.command).toContain(
      "shell base64 '/sdcard/Android/data/com.example.app/files/screenshots/home.png'",
    );
    expect(calls[1]?.maxBuffer).toBe(calls[0]?.maxBuffer);
    expect(calls.map((call) => call.timeoutMs)).toEqual([120_000, 120_000]);
  });

  test("uses an expanded ADB maxBuffer when listing Android app files", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "documents",
      userId: 0,
    });
    await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
    });

    const calls = adbFactory.getFakeClient().getCommandCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toContain("shell run-as 'com.example.app' sh -c");
    expect(calls[0]?.command).toContain("find");
    expect(calls[0]?.maxBuffer).toBeGreaterThan(1024 * 1024);
    expect(calls[1]?.command).toContain(
      "shell if [ -d '/sdcard/Android/data/com.example.app/files'",
    );
    expect(calls[1]?.command).toContain("find");
    expect(calls[1]?.maxBuffer).toBe(calls[0]?.maxBuffer);
    expect(calls.map((call) => call.timeoutMs)).toEqual([120_000, 120_000]);
  });

  test("suppresses ADB retries on every read and list app-file command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "documents",
      userId: 0,
      path: "screenshots/home.png",
    });
    await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
    });

    const calls = adbFactory.getFakeClient().getCommandCalls();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.noRetry === true)).toBe(true);
  });

  test("propagates noRetry and the caller's AbortSignal through every Android putFile command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
    });
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };
    const controller = new AbortController();

    await service.putFile({
      device,
      appId: "com.example.app",
      container: "documents",
      userId: 0,
      contentText: "hello",
      destinationPath: "fixtures/welcome.txt",
      signal: controller.signal,
    });

    const calls = adbFactory.getFakeClient().getCommandCalls();
    // push to temp, run-as cp, and the rm cleanup all flow through the helper / adb.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((call) => call.noRetry === true)).toBe(true);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  test("lists Android externalFiles with file names, directory markers, byte sizes, and last-modified metadata", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "find '/sdcard/Android/data/com.example.app/files'",
      execResult(
        [
          "directory|4096|1710000000|/sdcard/Android/data/com.example.app/files",
          "directory|4096|1710000060|/sdcard/Android/data/com.example.app/files/fixtures",
          "regular file|4|1710000123|/sdcard/Android/data/com.example.app/files/fixtures/welcome file.txt",
        ].join("\n"),
      ),
    );
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    const result = await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
    });

    expect(result.files).toEqual([
      {
        path: "fixtures",
        name: "fixtures",
        isDirectory: true,
        lastModified: "2024-03-09T16:01:00.000Z",
        resourceUri:
          "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/fixtures?userId=0",
      },
      {
        path: "fixtures/welcome file.txt",
        name: "welcome file.txt",
        byteCount: 4,
        isDirectory: false,
        lastModified: "2024-03-09T16:02:03.000Z",
        resourceUri:
          "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/fixtures/welcome%20file.txt?userId=0",
      },
    ]);
  });

  test("reads Android UTF-8 files as text without platform-specific decoding", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "base64 '/sdcard/Android/data/com.example.app/files/config/settings.json'",
      execResult(Buffer.from('{"enabled":true}\n', "utf8").toString("base64")),
    );
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    const result = await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
      path: "config/settings.json",
    });

    expect(result).toMatchObject({
      byteCount: 17,
      mimeType: "text/plain; charset=utf-8",
      text: '{"enabled":true}\n',
    });
    expect(result.blob).toBeUndefined();
  });

  test("preserves UTF-8 BOM bytes when reading text app files", async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "base64 '/sdcard/Android/data/com.example.app/files/config/bom.json'",
      execResult(bytes.toString("base64")),
    );
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    const result = await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
      path: "config/bom.json",
    });

    expect(result).toMatchObject({
      byteCount: bytes.byteLength,
      mimeType: "text/plain; charset=utf-8",
      text: "\uFEFF{}",
    });
    expect(Buffer.from(result.text!, "utf8")).toEqual(bytes);
    expect(result.blob).toBeUndefined();
  });

  test("keeps Android binary reads as lossless MCP blobs", async () => {
    const bytes = Buffer.from([0, 159, 146, 150, 255]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "base64 '/sdcard/Android/data/com.example.app/files/fixtures/pixel.bin'",
      execResult(bytes.toString("base64")),
    );
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    const result = await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
      userId: 0,
      path: "fixtures/pixel.bin",
    });

    expect(result).toMatchObject({
      byteCount: bytes.byteLength,
      mimeType: "application/octet-stream",
      blob: bytes.toString("base64"),
    });
    expect(result.text).toBeUndefined();
  });

  test("maps Android run-as failures to actionable private-storage guidance", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell run-as 'com.example.app'",
      new Error("run-as: Package 'com.example.app' is not debuggable"),
    );
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      }),
    });

    await expect(
      service.readFile({
        deviceId: "emulator-5554",
        appId: "com.example.app",
        container: "documents",
        userId: 0,
        path: "fixtures/private.txt",
      }),
    ).rejects.toThrow(
      "Android documents app file read for com.example.app on emulator-5554 requires a debuggable app build because it uses run-as",
    );
  });
});

// User/package/current-user state and all error strings in this suite are
// constructed, not captured from a device. No captured fixtures exist for them.
class AppFileUserAdb extends FakeAdbExecutor {
  listUsersCalls = 0;
  listUsersError?: Error;
  override async listUsers() {
    this.listUsersCalls += 1;
    if (this.listUsersError) {
      throw this.listUsersError;
    }
    return super.listUsers();
  }
}

class FakeForegroundAppLookup implements ForegroundAppLookup {
  calls = 0;
  app: { packageName: string; userId: number } | null = null;
  error?: Error;
  onLookup?: (signal?: AbortSignal) => void;

  async getForegroundApp(signal?: AbortSignal) {
    this.calls += 1;
    this.onLookup?.(signal);
    if (this.error) {
      throw this.error;
    }
    return this.app;
  }
}

const appFileUserDevice: BootedDevice = {
  deviceId: "fake-device",
  name: "Fake",
  platform: "android",
};
const appFileUserCases = [
  {
    name: "foreground work app with parent current user",
    users: [0, 10],
    installed: [0, 10],
    current: 0,
    resolved: 10,
    foreground: { packageName: "com.example.app", userId: 10 },
  },
  {
    name: "different foreground package",
    users: [0, 10],
    installed: [0, 10],
    current: 0,
    resolved: 0,
    foreground: { packageName: "com.other.app", userId: 10 },
  },
  {
    name: "foreground user outside candidates",
    users: [0, 10],
    installed: [0, 10],
    current: 0,
    resolved: 0,
    foreground: { packageName: "com.example.app", userId: 11 },
  },
  {
    name: "null foreground",
    users: [0, 10],
    installed: [0, 10],
    current: 0,
    resolved: 0,
  },
  {
    name: "failed foreground",
    users: [0, 10],
    installed: [0, 10],
    current: 0,
    resolved: 0,
    foregroundError: new Error("foreground unavailable"),
  },
  { name: "explicit work profile", explicit: 10, users: [0, 10], installed: [], resolved: 10 },
  { name: "explicit primary user", explicit: 0, users: [0, 10], installed: [], resolved: 0 },
  { name: "sole primary installation", users: [0], installed: [0], resolved: 0 },
  { name: "sole work-profile installation", users: [0, 10], installed: [10], resolved: 10 },
  {
    name: "secondary full user via current-user fallback",
    users: [0, 10],
    installed: [0, 10],
    current: 10,
    resolved: 10,
  },
  {
    name: "several installations, foreground absent",
    users: [0, 10, 11],
    installed: [0, 10],
    current: 11,
    error: "candidate users 0, 10",
  },
  {
    name: "no installation",
    users: [0, 10],
    installed: [],
    error: "com.example.app is not installed for any user on fake-device",
  },
  { name: "unknown user list", users: [], installed: [], error: "user resolution failed" },
];

function appFileUserService(
  adb: AppFileUserAdb,
  foregroundAppLookup: ForegroundAppLookup | null = new FakeForegroundAppLookup(),
) {
  const fileSystem = new TestAppFileFileSystem();
  return {
    fileSystem,
    service: createAppFileServiceForTesting({
      adbFactory: new FakeAdbClientFactory(adb),
      foregroundAppLookup: foregroundAppLookup ?? undefined,
      idGenerator: new CountingIdGenerator("tmp"),
      deviceResolver: async () => appFileUserDevice,
      fileSystem,
    }),
  };
}

function appFileOperationCommands(
  operation: "put" | "list" | "read",
  container: AppFileContainer,
  userId: number,
): string[] {
  const root =
    container === "externalFiles"
      ? `${userId === 0 ? "/sdcard" : `/storage/emulated/${userId}`}/Android/data/com.example.app/files`
      : container === "documents"
        ? "files"
        : container === "tmp"
          ? "cache/tmp"
          : "cache";
  const path = `${root}/fixtures/welcome.txt`;
  const prefix = `shell run-as 'com.example.app'${userId ? ` --user ${userId}` : ""}`;
  if (operation === "put") {
    if (container === "externalFiles") {
      return [`shell mkdir -p '${root}/fixtures'`, `push '/fixtures/welcome.txt' '${path}'`];
    }
    const temp = "/data/local/tmp/automobile-tmp-1-welcome.txt";
    const script = `mkdir -p '${root}/fixtures' && cp '${temp}' '${path}' && chmod 600 '${path}'`;
    return [
      `push '/fixtures/welcome.txt' '${temp}'`,
      `${prefix} sh -c ${shellQuote(script)}`,
      `shell rm -f '${temp}'`,
    ];
  }
  if (operation === "read") {
    return [`${container === "externalFiles" ? "shell" : prefix} base64 '${path}'`];
  }
  const script = `if [ -d '${root}' ]; then find '${root}' -exec stat -c '%F|%s|%Y|%n' {} \\; ; fi`;
  return [
    container === "externalFiles" ? `shell ${script}` : `${prefix} sh -c ${shellQuote(script)}`,
  ];
}

describe("Android app-file running candidates", () => {
  test.each([
    {
      name: "running owner bypasses stopped installation",
      installed: [0, 10],
      workRunning: false,
      resolved: 0,
      foregroundCalls: 0,
    },
    {
      name: "sole stopped installation remains selectable",
      installed: [10],
      workRunning: false,
      resolved: 10,
      foregroundCalls: 0,
    },
    {
      name: "two running installations still prefer foreground work app",
      installed: [0, 10],
      workRunning: true,
      resolved: 10,
      foregroundCalls: 1,
    },
  ])("$name", async (scenario) => {
    const adb = new AppFileUserAdb();
    adb.setUsers([
      { userId: 0, name: "Owner", running: true, flags: 0 },
      { userId: 10, name: "Work", running: scenario.workRunning, flags: 0 },
    ]);
    for (const userId of [0, 10]) {
      adb.setCommandResponse(
        `shell pm list packages --user ${userId}`,
        execResult(scenario.installed.includes(userId) ? "package:com.example.app\n" : ""),
      );
    }
    const foreground = new FakeForegroundAppLookup();
    foreground.app = { packageName: "com.example.app", userId: 10 };
    const { service } = appFileUserService(adb, foreground);
    await service.listFiles({
      deviceId: appFileUserDevice.deviceId,
      appId: "com.example.app",
      container: "documents",
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell pm list packages --user 0",
      "shell pm list packages --user 10",
      ...appFileOperationCommands("list", "documents", scenario.resolved),
    ]);
    expect(foreground.calls).toBe(scenario.foregroundCalls);
    expect(adb.listUsersCalls).toBe(1);
  });
});

for (const operation of ["put", "list", "read"] as const) {
  describe(`Android app-file user targeting: ${operation}`, () => {
    const debugSpies: Array<{ mockRestore: () => void }> = [];
    afterEach(() => {
      for (const debugSpy of debugSpies.splice(0)) {
        debugSpy.mockRestore();
      }
    });

    test.each(appFileUserCases)("$name (exact commands)", async (scenario) => {
      for (const container of ["documents", "cache", "tmp", "externalFiles"] as const) {
        const adb = new AppFileUserAdb();
        adb.setUsers(
          scenario.users.map((userId) => ({
            userId,
            name: `User ${userId}`,
            running: true,
            flags: 0,
          })),
        );
        for (const userId of scenario.users) {
          // Constructed, not captured from a device: exact package-list entry or empty listing.
          adb.setCommandResponse(
            `shell pm list packages --user ${userId}`,
            execResult(scenario.installed.includes(userId) ? "package:com.example.app\n" : ""),
          );
        }
        if (scenario.current !== undefined) {
          // Constructed, not captured from a device: current full-user number.
          adb.setCommandResponse("shell am get-current-user", execResult(`${scenario.current}\n`));
        }
        const foreground = new FakeForegroundAppLookup();
        foreground.app = scenario.foreground ?? null;
        foreground.error = scenario.foregroundError;
        const debug = scenario.foregroundError
          ? spyOn(logger, "debug").mockImplementation(() => {})
          : undefined;
        if (debug) {
          debugSpies.push(debug);
        }
        const { service, fileSystem } = appFileUserService(adb, foreground);
        await fileSystem.writeFileBuffer("/fixtures/welcome.txt", Buffer.from("hello"));
        const common = {
          deviceId: appFileUserDevice.deviceId,
          appId: "com.example.app",
          container,
          userId: scenario.explicit,
        };
        const result =
          operation === "put"
            ? service.putFile({
                ...common,
                device: appFileUserDevice,
                sourcePath: "/fixtures/welcome.txt",
                destinationPath: "fixtures/welcome.txt",
              })
            : operation === "list"
              ? service.listFiles(common)
              : service.readFile({ ...common, path: "fixtures/welcome.txt" });
        const resolution =
          scenario.explicit !== undefined
            ? []
            : scenario.users.map((id) => `shell pm list packages --user ${id}`);
        if (
          scenario.current !== undefined &&
          !(
            scenario.foreground?.packageName === "com.example.app" &&
            scenario.installed.includes(scenario.foreground.userId)
          )
        ) {
          resolution.push("shell am get-current-user");
        }
        if (scenario.error) {
          await expect(result).rejects.toBeInstanceOf(ActionableError);
          await expect(result).rejects.toThrow(scenario.error);
          if (scenario.current !== undefined || scenario.users.length === 0) {
            await expect(result).rejects.toThrow("Pass userId");
          }
          expect(adb.getExecutedCommands()).toEqual(resolution);
          expect(adb.wasCommandExecuted("run-as")).toBe(false);
        } else {
          await result;
          expect(adb.getExecutedCommands()).toEqual([
            ...resolution,
            ...appFileOperationCommands(operation, container, scenario.resolved!),
          ]);
        }
        // Single-user omitted ID costs one listUsers + one pm list, no current-user read.
        // Explicit IDs cost zero resolution reads; every other operation lists users once.
        expect(adb.listUsersCalls).toBe(scenario.explicit === undefined ? 1 : 0);
        expect(foreground.calls).toBe(
          scenario.explicit === undefined && scenario.installed.length > 1 ? 1 : 0,
        );
        if (scenario.foregroundError) {
          expect(debug).toHaveBeenCalledWith(
            "Android app-file foreground lookup failed",
            scenario.foregroundError,
          );
        }
      }
    });

    test("failed user listing is actionable and issues no file commands", async () => {
      const adb = new AppFileUserAdb();
      // Constructed, not captured from a device: a user-enumeration failure.
      adb.listUsersError = new Error("user enumeration unavailable");
      const { service, fileSystem } = appFileUserService(adb);
      await fileSystem.writeFileBuffer("/fixtures/welcome.txt", Buffer.from("hello"));
      const common = {
        deviceId: appFileUserDevice.deviceId,
        appId: "com.example.app",
        container: "documents" as const,
      };
      const result =
        operation === "put"
          ? service.putFile({
              ...common,
              device: appFileUserDevice,
              sourcePath: "/fixtures/welcome.txt",
              destinationPath: "welcome.txt",
            })
          : operation === "list"
            ? service.listFiles(common)
            : service.readFile({ ...common, path: "welcome.txt" });
      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow(
        "Android user resolution failed for com.example.app on fake-device. Pass userId",
      );
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });
}

describe("Android app-file resource user round trips", () => {
  afterEach(() => ResourceRegistry.clearResources());

  const scenarios = [
    {
      name: "explicit primary",
      explicit: 0,
      installed: [0, 10],
      current: 10,
      user: 0,
      query: "?userId=0",
    },
    {
      name: "explicit work",
      explicit: 10,
      installed: [0, 10],
      current: 0,
      user: 10,
      query: "?userId=10",
    },
    { name: "sole work installation", installed: [10], user: 10, query: "?userId=10" },
    {
      name: "foreground work",
      installed: [0, 10],
      current: 0,
      user: 10,
      query: "?userId=10",
      foreground: { packageName: "com.example.app", userId: 10 },
    },
    { name: "secondary full user", installed: [0, 10], current: 10, user: 10, query: "?userId=10" },
    { name: "foreground primary", installed: [0, 10], current: 0, user: 0, query: "?userId=0" },
    { name: "single primary user", users: [0], installed: [0], user: 0, query: "" },
    { name: "sole primary installation with other users", installed: [0], user: 0, query: "" },
  ];

  for (const operation of ["put", "list"] as const) {
    for (const container of ["documents", "externalFiles"] as const) {
      test.each(scenarios)(`${operation} ${container}: $name URI round trip`, async (scenario) => {
        const adb = new AppFileUserAdb();
        const users = scenario.users ?? [0, 10];
        adb.setUsers(users.map((userId) => ({ userId, name: `User ${userId}` })));
        for (const userId of users) {
          adb.setCommandResponse(
            `shell pm list packages --user ${userId}`,
            execResult(scenario.installed.includes(userId) ? "package:com.example.app\n" : ""),
          );
        }
        adb.setCommandResponse(
          "shell am get-current-user",
          execResult(`${scenario.current ?? 10}\n`),
        );
        const root =
          container === "documents"
            ? "files"
            : `${scenario.user === 0 ? "/sdcard" : `/storage/emulated/${scenario.user}`}/Android/data/com.example.app/files`;
        const commands = appFileOperationCommands(operation, container, scenario.user);
        adb.setCommandResponse(
          commands[operation === "put" ? 1 : 0]!,
          execResult(`regular file|5|0|${root}/fixtures/welcome.txt\n`),
        );
        const readCommand = appFileOperationCommands("read", container, scenario.user)[0]!;
        adb.setCommandResponse(readCommand, execResult(Buffer.from("hello").toString("base64")));
        const foreground = new FakeForegroundAppLookup();
        foreground.app = scenario.foreground ?? null;
        const { service, fileSystem } = appFileUserService(adb, foreground);
        await fileSystem.writeFileBuffer("/fixtures/welcome.txt", Buffer.from("hello"));
        const common = {
          deviceId: appFileUserDevice.deviceId,
          appId: "com.example.app",
          container,
          userId: scenario.explicit,
        };
        const uri =
          operation === "put"
            ? (
                await service.putFile({
                  ...common,
                  device: appFileUserDevice,
                  sourcePath: "/fixtures/welcome.txt",
                  destinationPath: "fixtures/welcome.txt",
                })
              ).resourceUri
            : (await service.listFiles(common)).files[0]!.resourceUri;
        expect(uri).toBe(
          `automobile:devices/fake-device/apps/com.example.app/files/${container}/fixtures/welcome.txt${scenario.query}`,
        );
        const resolution =
          scenario.explicit === undefined
            ? users.map((id) => `shell pm list packages --user ${id}`)
            : [];
        if (
          scenario.explicit === undefined &&
          scenario.installed.length > 1 &&
          !scenario.foreground
        ) {
          resolution.push("shell am get-current-user");
        }
        expect(adb.getExecutedCommands()).toEqual([...resolution, ...commands]);
        expect(adb.listUsersCalls).toBe(scenario.explicit === undefined ? 1 : 0);

        ResourceRegistry.registerTemplate(
          APP_FILE_RESOURCE_TEMPLATES.FILE,
          "File",
          "File",
          "text/plain",
          async () => ({ uri }),
        );
        const match = ResourceRegistry.matchTemplate(uri);
        expect(match).toBeDefined();
        const parts = parseAppFileResourceParams(match!.params);
        expect(parts.userId).toBe(scenario.query ? scenario.user : undefined);
        const discoveryCalls = adb.listUsersCalls;
        const foregroundCalls = foreground.calls;
        adb.clearHistory();
        // Change constructed foreground/current state: pinned reads must not drift.
        foreground.app = { packageName: "com.example.app", userId: scenario.user === 0 ? 10 : 0 };
        adb.setCommandResponse(
          "shell am get-current-user",
          execResult(`${scenario.user === 0 ? 10 : 0}\n`),
        );
        const read = await service.readFile({ ...parts, path: parts.path! });
        expect(read.text).toBe("hello");
        expect(adb.getExecutedCommands()).toEqual([
          ...(scenario.query ? [] : resolution),
          readCommand,
        ]);
        expect(adb.listUsersCalls).toBe(discoveryCalls + (scenario.query ? 0 : 1));
        expect(foreground.calls).toBe(foregroundCalls);
      });
    }
  }
});

describe("Android app-file profile details", () => {
  test("default foreground lookup delegates to the operation's adb client", async () => {
    const adb = new AppFileUserAdb();
    adb.setUsers([
      { userId: 0, name: "Owner" },
      { userId: 10, name: "Work" },
    ]);
    // Constructed, not captured from a device: work app resumed, parent remains current.
    adb.setForegroundApp({ packageName: "com.example.app", userId: 10 });
    adb.setCommandResponse("shell pm list packages", execResult("package:com.example.app\n"));
    adb.setCommandResponse("shell am get-current-user", execResult("0\n"));
    const { service } = appFileUserService(adb, null);
    const result = await service.putFile({
      device: appFileUserDevice,
      target: { domain: "app_containers", appId: "com.example.app", container: "externalFiles" },
      files: [{ contentText: "hello", destinationPath: "welcome.txt" }],
    });
    expect(result.files[0]!.resourceUri).toEndWith("?userId=10");
    expect(adb.wasCommandExecuted("shell am get-current-user")).toBe(false);
  });

  test("foreground lookup abort propagates without current-user fallback", async () => {
    const adb = new AppFileUserAdb();
    adb.setUsers([
      { userId: 0, name: "Owner" },
      { userId: 10, name: "Work" },
    ]);
    // Constructed, not captured from a device: both users have the package.
    adb.setCommandResponse("shell pm list packages", execResult("package:com.example.app\n"));
    const foreground = new FakeForegroundAppLookup();
    const controller = new AbortController();
    const abort = new Error("lookup aborted");
    foreground.onLookup = (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(abort);
    };
    foreground.error = abort;
    const { service } = appFileUserService(adb, foreground);
    await expect(
      service.putFile({
        device: appFileUserDevice,
        target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
        files: [{ contentText: "hello", destinationPath: "welcome.txt" }],
        signal: controller.signal,
      }),
    ).rejects.toBe(abort);
    expect(foreground.calls).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([
      "shell pm list packages --user 0",
      "shell pm list packages --user 10",
    ]);
  });

  test("resolveAndroidTarget keeps primary paths and substitutes secondary storage roots", () => {
    expect(resolveAndroidTarget("com.example.app", "externalFiles", "a.txt")).toEqual({
      kind: "external",
      absolutePath: "/sdcard/Android/data/com.example.app/files/a.txt",
    });
    expect(resolveAndroidTarget("com.example.app", "externalFiles", "a.txt", 10)).toEqual({
      kind: "external",
      absolutePath: "/storage/emulated/10/Android/data/com.example.app/files/a.txt",
    });
    for (const userId of [0, 10]) {
      expect(resolveAndroidTarget("com.example.app", "documents", "a.txt", userId)).toEqual({
        kind: "runAs",
        relativePath: "files/a.txt",
      });
    }
  });

  test("putFiles batch resolves once even when foreground state could change", async () => {
    const adb = new AppFileUserAdb();
    adb.setUsers([
      { userId: 0, name: "Owner" },
      { userId: 10, name: "Work" },
    ]);
    // Constructed, not captured from a device: both users have the package, current user changes.
    adb.setCommandResponse("shell pm list packages", execResult("package:com.example.app\n"));
    adb.setCommandResponseSequence("shell am get-current-user", [
      execResult("10\n"),
      execResult("0\n"),
    ]);
    const { service } = appFileUserService(adb);
    const result = await service.putFile({
      device: appFileUserDevice,
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [
        { contentText: "one", destinationPath: "one.txt" },
        { contentText: "two", destinationPath: "two.txt" },
      ],
    });
    expect(result.files.map((file) => file.resourceUri)).toEqual([
      "automobile:devices/fake-device/apps/com.example.app/files/documents/one.txt?userId=10",
      "automobile:devices/fake-device/apps/com.example.app/files/documents/two.txt?userId=10",
    ]);
    expect(adb.listUsersCalls).toBe(1);
    expect(adb.getExecutedCommands().filter((c) => c.startsWith("shell pm list packages"))).toEqual(
      ["shell pm list packages --user 0", "shell pm list packages --user 10"],
    );
    expect(adb.getExecutedCommands().filter((c) => c === "shell am get-current-user")).toHaveLength(
      1,
    );
    const writes = adb.getExecutedCommands().filter((c) => c.startsWith("shell run-as"));
    expect(writes).toHaveLength(2);
    expect(
      writes.every((c) => c.startsWith("shell run-as 'com.example.app' --user 10 sh -c")),
    ).toBe(true);
  });

  test("listed file resource URI retains the resolved work profile", async () => {
    const adb = new AppFileUserAdb();
    // Constructed, not captured from a device: stat record for a work-profile file.
    adb.setCommandResponse("shell run-as", execResult("regular file|5|0|files/welcome.txt\n"));
    const { service } = appFileUserService(adb);
    const result = await service.listFiles({
      deviceId: appFileUserDevice.deviceId,
      appId: "com.example.app",
      container: "documents",
      userId: 10,
    });
    expect(result.files[0]?.resourceUri).toBe(
      "automobile:devices/fake-device/apps/com.example.app/files/documents/welcome.txt?userId=10",
    );
  });

  // Every string here is constructed, not captured from a device; --user API support is unverified.
  test.each([
    ["run-as: unknown package: com.example.app", "not installed for user 10"],
    ["run-as: package not debuggable: com.example.app", "com.example.app for user 10"],
    ["run-as: unknown option --user", "run-as --user appears unsupported"],
    ["command failed\n  run-as: Unknown option --user", "run-as --user appears unsupported"],
    ["run-as: invalid option --user", "run-as --user appears unsupported"],
    ["run-as: unrecognized option --user", "run-as --user appears unsupported"],
    ["Usage: run-as <package> <command>", "run-as --user appears unsupported"],
    ["Permission denied", "was denied by the device"],
    [
      "run-as: package not debuggable: com.example.app\nUsage: run-as <package> <command>",
      "requires a debuggable app build",
    ],
    [
      "run-as: unknown package: com.example.app\nUsage: run-as <package> <command>",
      "not installed for user 10",
    ],
    ["Permission denied\nUsage: run-as <package> <command>", "was denied by the device"],
    ["cp: 'files/unknown option.txt': does not exist", "not installed for user 10"],
    [
      "cp: 'files/unknown option.txt': No such file or directory",
      "Failed to list Android documents app files",
    ],
    [
      "cp: 'files/Usage: run-as.txt': No such file or directory",
      "Failed to list Android documents app files",
    ],
    ["run-as: unknown user 99", "Failed to list Android documents app files"],
  ])("maps %s", async (output, expected) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("run-as", new Error(output));
    const result = executeAndroidAppFileCommand(
      adb,
      `shell run-as 'com.example.app' --user ${output.includes("unknown user 99") ? 99 : 10} ls`,
      {
        device: appFileUserDevice,
        appId: "com.example.app",
        container: "documents",
        operation: "list",
        access: "run-as",
        userId: output.includes("unknown user 99") ? 99 : 10,
      },
    );
    await expect(result).rejects.toBeInstanceOf(ActionableError);
    await expect(result).rejects.toThrow(expected);
    if (expected.includes("unsupported")) {
      await expect(result).rejects.toThrow("unverified which API level");
    } else {
      await expect(result).rejects.not.toThrow("run-as --user appears unsupported");
    }
  });

  test("usage without --user retains the ordinary error branch", async () => {
    const adb = new FakeAdbExecutor();
    // Constructed, not captured from a device: run-as usage text.
    adb.setCommandError("run-as", new Error("Usage: run-as <package> <command>"));
    await expect(
      executeAndroidAppFileCommand(adb, "shell run-as 'com.example.app' ls", {
        device: appFileUserDevice,
        appId: "com.example.app",
        container: "documents",
        operation: "list",
        access: "run-as",
        userId: 0,
      }),
    ).rejects.toThrow("Failed to list Android documents app files");
  });
});

class RecordingAppFileProvider implements AppFileProvider {
  readonly putRequests: PutAppFileProviderRequest[] = [];
  readonly domain = "app_containers" as const;

  constructor(readonly platform: "android" | "ios") {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    this.putRequests.push(request);
  }

  async listFiles(): Promise<never> {
    throw new Error(`${this.platform} listFiles not supported in fake`);
  }

  async readFile(): Promise<never> {
    throw new Error(`${this.platform} readFile not supported in fake`);
  }
}

class RecordingStorageWriteProvider implements AppFileWriteProvider {
  readonly requests: PutAppFileProviderRequest[] = [];

  constructor(
    readonly platform: "android" | "ios",
    readonly domain: "app_containers" | "user_files" | "media_library",
    private readonly result?: {
      effects?: Array<{
        type: string;
        status: "completed" | "notRequested" | "unavailable";
        reason?: string;
      }>;
    },
    private readonly error?: Error,
  ) {}

  async putFile(request: PutAppFileProviderRequest) {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

class TestAppFileFileSystem implements AppFileFileSystem {
  readonly removedPaths: string[] = [];
  private readonly files = new Map<string, Buffer>();
  private readonly directories = new Set<string>(["/"]);
  private readonly symlinks = new Set<string>();
  private tempIndex = 0;

  async stat(path: string): Promise<AppFileStats> {
    const normalized = this.normalize(path);
    if (this.files.has(normalized)) {
      return this.stats(this.files.get(normalized)?.byteLength ?? 0, "file");
    }
    if (this.directories.has(normalized)) {
      return this.stats(0, "directory");
    }
    throw this.notFound(path);
  }

  async lstat(path: string): Promise<AppFileStats> {
    const normalized = this.normalize(path);
    if (this.symlinks.has(normalized)) {
      return this.stats(0, "symlink");
    }
    return this.stat(path);
  }

  async readdir(path: string): Promise<Array<{ name: string }>> {
    const normalized = this.normalize(path);
    if (!this.directories.has(normalized)) {
      throw this.notFound(path);
    }
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const names = new Set<string>();

    for (const directory of this.directories) {
      if (directory !== normalized && directory.startsWith(prefix)) {
        names.add(directory.slice(prefix.length).split("/")[0] ?? "");
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        names.add(file.slice(prefix.length).split("/")[0] ?? "");
      }
    }
    for (const symlink of this.symlinks) {
      if (symlink.startsWith(prefix)) {
        names.add(symlink.slice(prefix.length).split("/")[0] ?? "");
      }
    }

    return [...names]
      .filter(Boolean)
      .sort()
      .map((name) => ({ name }));
  }

  async mkdir(path: string): Promise<void> {
    this.ensureDirectory(path);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    const source = await this.readFileBuffer(sourcePath);
    await this.writeFileBuffer(destinationPath, source);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const source = this.normalize(oldPath);
    const data = this.files.get(source);
    if (data === undefined) {
      throw this.notFound(oldPath);
    }
    this.files.set(this.normalize(newPath), data);
    this.files.delete(source);
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const normalized = this.normalize(path);
    const data = this.files.get(normalized);
    if (data === undefined) {
      throw this.notFound(path);
    }
    return Buffer.from(data);
  }

  async readText(path: string): Promise<string> {
    return (await this.readFileBuffer(path)).toString("utf8");
  }

  async writeFileBuffer(path: string, data: Buffer): Promise<void> {
    const normalized = this.normalize(path);
    this.ensureDirectory(dirname(normalized));
    this.files.set(normalized, Buffer.from(data));
  }

  async mkdtemp(prefix: string): Promise<string> {
    const path = this.normalize(`${prefix}${++this.tempIndex}`);
    this.ensureDirectory(path);
    return path;
  }

  async rm(path: string): Promise<void> {
    this.removedPaths.push(path);
    const normalized = this.normalize(path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;

    for (const file of [...this.files.keys()]) {
      if (file === normalized || file.startsWith(prefix)) {
        this.files.delete(file);
      }
    }
    for (const symlink of [...this.symlinks]) {
      if (symlink === normalized || symlink.startsWith(prefix)) {
        this.symlinks.delete(symlink);
      }
    }
    for (const directory of [...this.directories]) {
      if (directory !== "/" && (directory === normalized || directory.startsWith(prefix))) {
        this.directories.delete(directory);
      }
    }
  }

  setSymlink(path: string): void {
    const normalized = this.normalize(path);
    this.ensureDirectory(dirname(normalized));
    this.symlinks.add(normalized);
  }

  private ensureDirectory(path: string): void {
    const normalized = this.normalize(path);
    const segments = normalized.split("/").filter(Boolean);
    let current = normalized.startsWith("/") ? "/" : "";

    for (const segment of segments) {
      current =
        current === "/" || current === "" ? `${current}${segment}` : `${current}/${segment}`;
      this.directories.add(current);
    }
  }

  private normalize(path: string): string {
    const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
    return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  }

  private stats(size: number, kind: "file" | "directory" | "symlink"): AppFileStats {
    return {
      size,
      mtime: new Date("2026-06-29T00:00:00.000Z"),
      isFile: () => kind === "file",
      isDirectory: () => kind === "directory",
    };
  }

  private notFound(path: string): NodeJS.ErrnoException {
    const error = new Error(`ENOENT: no such file or directory, ${path}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    return error;
  }
}
