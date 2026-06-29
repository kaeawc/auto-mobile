import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAppFileServiceForTesting,
  type AppFileProvider,
  type PutAppFileProviderRequest,
} from "../../src/server/appFileService";
import type { BootedDevice } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";

describe("AppFileService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

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

    await expect(service.putFile({
      device,
      appId: "../com.example.app",
      container: "documents",
      contentText: "hello",
      destinationPath: "fixtures/welcome.txt",
    })).rejects.toThrow("appId must be a non-empty app identifier without path separators or traversal segments");

    await expect(service.putFile({
      device,
      appId: "com.example.app",
      container: "documents",
      contentText: "hello",
      destinationPath: "/absolute.txt",
    })).rejects.toThrow("destinationPath must be a non-empty relative path without '.' or '..' segments");

    expect(provider.putRequests).toHaveLength(0);
  });

  test("maps unsupported platform capabilities to explicit operation errors", async () => {
    const service = createAppFileServiceForTesting({
      providers: [new RecordingAppFileProvider("android")],
      deviceResolver: async deviceId => ({
        deviceId,
        name: "iPhone",
        platform: "ios",
      }),
    });

    await expect(service.listFiles({
      deviceId: "sim-1",
      appId: "com.example.app",
      container: "documents",
    })).rejects.toThrow(
      "listFiles is not supported for appId com.example.app in documents on ios"
    );
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
      resourceUri: "automobile:devices/emulator-5554/apps/com.example.app/files/documents/fixtures/welcome%20file.txt",
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

  test("lists missing Android containers as empty instead of failing find", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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

    await expect(service.putFile({
      device,
      appId: "../other.app",
      container: "externalFiles",
      contentText: "hello",
      destinationPath: "fixtures/welcome.txt",
    })).rejects.toThrow("appId must be a non-empty app identifier without path separators or traversal segments");

    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("writes iOS files through the provider resolved app data container", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "automobile-ios-app-file-"));
    tempDirs.push(dataRoot);
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult("get_app_container 'SIM-1' 'com.example.app' data", dataRoot);
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
    });
    const device: BootedDevice = {
      deviceId: "SIM-1",
      name: "iPhone",
      platform: "ios",
    };

    const result = await service.putFile({
      device,
      appId: "com.example.app",
      container: "library",
      contentText: "hello ios",
      destinationPath: "Support/config.txt",
    });

    expect(result).toMatchObject({
      success: true,
      deviceId: "SIM-1",
      platform: "ios",
      appId: "com.example.app",
      container: "library",
      destinationPath: "Support/config.txt",
      byteCount: 9,
    });
    await expect(readFile(join(dataRoot, "Library", "Support", "config.txt"), "utf8")).resolves.toBe("hello ios");
  });

  test("maps iOS externalFiles to explicit unsupported capability errors", async () => {
    const simctl = new FakeSimCtlClient();
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      deviceResolver: async deviceId => ({ deviceId, name: "iPhone", platform: "ios" }),
    });
    const device: BootedDevice = {
      deviceId: "SIM-1",
      name: "iPhone",
      platform: "ios",
    };

    await expect(service.putFile({
      device,
      appId: "com.example.app",
      container: "externalFiles",
      contentText: "hello",
      destinationPath: "config.txt",
    })).rejects.toThrow("putFile is not supported for appId com.example.app in externalFiles on ios");

    await expect(service.listFiles({
      deviceId: "SIM-1",
      appId: "com.example.app",
      container: "externalFiles",
    })).rejects.toThrow("listFiles is not supported for appId com.example.app in externalFiles on ios");

    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("uses an expanded ADB maxBuffer when reading Android app files as base64", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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
    expect(calls[1]?.command).toContain("shell base64 '/sdcard/Android/data/com.example.app/files/screenshots/home.png'");
    expect(calls[1]?.maxBuffer).toBe(calls[0]?.maxBuffer);
  });

  test("uses an expanded ADB maxBuffer when listing Android app files", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createAppFileServiceForTesting({
      adbFactory,
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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
    expect(calls[1]?.command).toContain("shell if [ -d '/sdcard/Android/data/com.example.app/files'");
    expect(calls[1]?.command).toContain("find");
    expect(calls[1]?.maxBuffer).toBe(calls[0]?.maxBuffer);
  });
});

class RecordingAppFileProvider implements AppFileProvider {
  readonly putRequests: PutAppFileProviderRequest[] = [];

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
