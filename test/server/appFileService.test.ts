import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAppFileServiceForTesting,
  type AppFileProvider,
  type PutAppFileProviderRequest,
} from "../../src/server/appFileService";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
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

  test("lists Android externalFiles with file names, directory markers, byte sizes, and last-modified metadata", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("find '/sdcard/Android/data/com.example.app/files'", execResult([
      "directory|4096|1710000000|/sdcard/Android/data/com.example.app/files",
      "directory|4096|1710000060|/sdcard/Android/data/com.example.app/files/fixtures",
      "regular file|4|1710000123|/sdcard/Android/data/com.example.app/files/fixtures/welcome file.txt",
    ].join("\n")));
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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
        resourceUri: "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/fixtures",
      },
      {
        path: "fixtures/welcome file.txt",
        name: "welcome file.txt",
        byteCount: 4,
        isDirectory: false,
        lastModified: "2024-03-09T16:02:03.000Z",
        resourceUri: "automobile:devices/emulator-5554/apps/com.example.app/files/externalFiles/fixtures/welcome%20file.txt",
      },
    ]);
  });

  test("reads Android UTF-8 files as text without platform-specific decoding", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("base64 '/sdcard/Android/data/com.example.app/files/config/settings.json'", execResult(
      Buffer.from("{\"enabled\":true}\n", "utf8").toString("base64")
    ));
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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
      text: "{\"enabled\":true}\n",
    });
    expect(result.blob).toBeUndefined();
  });

  test("preserves UTF-8 BOM bytes when reading text app files", async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("base64 '/sdcard/Android/data/com.example.app/files/config/bom.json'", execResult(
      bytes.toString("base64")
    ));
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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
    adb.setCommandResponse("base64 '/sdcard/Android/data/com.example.app/files/fixtures/pixel.bin'", execResult(
      bytes.toString("base64")
    ));
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
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
    adb.setCommandError("shell run-as 'com.example.app'", new Error("run-as: Package 'com.example.app' is not debuggable"));
    const service = createAppFileServiceForTesting({
      adbFactory: adbFactoryFor(adb),
      simctlFactory: () => {
        throw new Error("simctl not used");
      },
      deviceResolver: async () => ({ deviceId: "emulator-5554", name: "Pixel", platform: "android" }),
    });

    await expect(service.readFile({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      container: "documents",
      path: "fixtures/private.txt",
    })).rejects.toThrow(
      "Android documents app file read for com.example.app on emulator-5554 requires a debuggable app build because it uses run-as"
    );
  });

  test("skips broken symlinks when listing iOS app container files", async () => {
    const root = await mkdtemp(join(tmpdir(), "automobile-app-files-"));
    tempDirs.push(root);
    const dataRoot = join(root, "data");
    const documentsRoot = join(dataRoot, "Documents");
    await mkdir(documentsRoot, { recursive: true });
    await writeFile(join(documentsRoot, "welcome.txt"), "hello");
    await symlink(join(documentsRoot, "missing.txt"), join(documentsRoot, "broken-link"));
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult("get_app_container 'ios-sim-1' 'com.example.app' data", dataRoot);
    const service = createAppFileServiceForTesting({
      simctlFactory: () => simctl as any,
      deviceResolver: async () => ({ deviceId: "ios-sim-1", name: "iPhone", platform: "ios" }),
    });

    const result = await service.listFiles({
      deviceId: "ios-sim-1",
      appId: "com.example.app",
      container: "documents",
    });

    expect(result.files.map(file => file.path)).toEqual(["welcome.txt"]);
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
