import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  type AppFileFileSystem,
  type AppFileStats,
  createAppFileServiceForTesting,
  type AppFileProvider,
  type AppFileWriteProvider,
  type PutAppFileProviderRequest,
} from "../../src/server/appFileService";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";

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

  test("routes a normalized canonical batch by platform and logical domain", async () => {
    const provider = new RecordingStorageWriteProvider("android", "user_files", {
      effects: [{ type: "media_index", status: "notRequested", reason: "not media" }],
    });
    const service = createAppFileServiceForTesting({ providers: [provider] });

    const result = await service.putFile({
      device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      target: { domain: "user_files", namespace: " run-42 ", reset: true },
      files: [
        { contentText: "one", destinationPath: "./one.txt" },
        { contentBase64: Buffer.from("two").toString("base64"), destinationPath: "nested/two.txt" },
      ],
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      target: { domain: "user_files", namespace: "run-42", reset: true },
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
      { domain: "user_files", namespace: "run-42", reset: true },
      { domain: "user_files", namespace: "run-42", reset: false },
    ]);
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
    const provider = new RecordingStorageWriteProvider("android", "app_containers", undefined, new Error("write failed"));
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
        "automobile:devices/emulator-5554/apps/com.example.app/files/documents/fixtures/welcome%20file.txt",
    });

    const commands = adbFactory.getFakeClient().getAllCommands();
    expect(commands[0]).toContain("push ");
    expect(commands[1]).toContain("shell run-as 'com.example.app' sh -c");
    expect(commands[1]).toContain("mkdir -p");
    expect(commands[1]).toContain("files/fixtures");
    expect(commands[1]).toContain("cp ");
    expect(commands[1]).toContain("/data/local/tmp/automobile-");
    expect(commands[1]).toContain("files/fixtures/welcome file.txt");
    expect(commands[2]).toContain("shell rm -f '/data/local/tmp/automobile-");
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
      path: "screenshots/home.png",
    });
    await service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
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
    });
    await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
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
      path: "screenshots/home.png",
    });
    await service.listFiles({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "externalFiles",
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
    });

    expect(result.files).toEqual([
      {
        path: "fixtures",
        name: "fixtures",
        isDirectory: true,
        lastModified: "2024-03-09T16:01:00.000Z",
        resourceUri:
          "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/fixtures",
      },
      {
        path: "fixtures/welcome file.txt",
        name: "welcome file.txt",
        byteCount: 4,
        isDirectory: false,
        lastModified: "2024-03-09T16:02:03.000Z",
        resourceUri:
          "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/fixtures/welcome%20file.txt",
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
        path: "fixtures/private.txt",
      }),
    ).rejects.toThrow(
      "Android documents app file read for com.example.app on emulator-5554 requires a debuggable app build because it uses run-as",
    );
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
    private readonly result?: { effects?: Array<{ type: string; status: "completed" | "notRequested" | "unavailable"; reason?: string }> },
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
