import { describe, expect, test } from "bun:test";
import { createSharedStorageServiceForTesting } from "../../src/server/sharedStorageService";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  };
}

function adbFactoryFor(executor: FakeAdbExecutor): AdbClientFactory {
  return { create: () => executor };
}

describe("SharedStorageService", () => {
  test("resets only the declared Downloads namespace, stages every file, and indexes media", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const service = createSharedStorageServiceForTesting({ adbFactory: adbFactoryFor(executor) });

    const result = await service.stage({
      device: androidDevice,
      namespace: "run-42",
      reset: true,
      files: [
        { contentText: "read me", destinationPath: "docs/read me.txt" },
        {
          contentBase64: Buffer.from([1, 2, 3]).toString("base64"),
          destinationPath: "media/photo.png",
        },
      ],
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      namespace: "run-42",
      userId: 0,
      userSource: "primary",
      destinationDirectory: "/storage/emulated/0/Download/run-42",
      reset: true,
      files: [
        {
          destinationPath: "docs/read me.txt",
          byteCount: 7,
          mediaIndexing: {
            status: "notRequested",
            reason:
              "media indexing was not requested for docs/read me.txt; Android document pickers discover files directly from Downloads",
          },
        },
        {
          destinationPath: "media/photo.png",
          byteCount: 3,
          mediaIndexing: { status: "completed" },
        },
      ],
    });

    const commands = executor.getExecutedCommands();
    expect(commands[0]).toBe("shell rm -rf '/storage/emulated/0/Download/run-42'");
    expect(commands).toContain("shell mkdir -p '/storage/emulated/0/Download/run-42'");
    expect(commands).toContain("shell mkdir -p '/storage/emulated/0/Download/run-42/docs'");
    expect(commands).toContain("shell mkdir -p '/storage/emulated/0/Download/run-42/media'");
    expect(
      commands.some(
        (command) =>
          command.includes("push ") &&
          command.includes("/storage/emulated/0/Download/run-42/docs/read me.txt"),
      ),
    ).toBe(true);
    expect(executor.getExecutedArgv()).toContainEqual([
      "push",
      expect.stringContaining("automobile-shared-storage-"),
      "/storage/emulated/0/Download/run-42/docs/read me.txt",
    ]);
    expect(
      commands.some(
        (command) =>
          command.includes("MEDIA_SCANNER_SCAN_FILE") &&
          command.includes("file:///storage/emulated/0/Download/run-42/media/photo.png"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("content query") && command.includes("external_primary/images/media"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("relative_path=") &&
          command.includes("Download") &&
          !command.includes("Download/Download/"),
      ),
    ).toBe(true);
    expect(commands.every((command) => !command.includes(".."))).toBe(true);
  });

  test("uses the resolved active profile rather than assuming Android user zero", async () => {
    const executor = new FakeAdbExecutor();
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async () => ({ userId: 12, source: "managedProfile" }),
      }),
    });

    const result = await service.stage({
      device: androidDevice,
      namespace: "work-fixtures",
      reset: true,
      files: [{ contentText: "picker", destinationPath: "document.txt" }],
    });

    expect(result).toMatchObject({
      userId: 12,
      userSource: "managedProfile",
      destinationDirectory: "/storage/emulated/12/Download/work-fixtures",
    });
    expect(executor.getExecutedCommands()).toContain(
      "shell rm -rf '/storage/emulated/12/Download/work-fixtures'",
    );
    expect(executor.getExecutedArgv()).toContainEqual([
      "push",
      expect.stringContaining("automobile-shared-storage-"),
      "/storage/emulated/12/Download/work-fixtures/document.txt",
    ]);
  });

  test("scopes MediaStore scanning and verification to the resolved profile", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async () => ({ userId: 12, source: "managedProfile" }),
      }),
    });

    await service.stage({
      device: androidDevice,
      namespace: "work-media",
      files: [{ contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "photo.png" }],
    });

    expect(executor.getExecutedCommands()).toContain(
      "shell am broadcast --user 12 -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file:///storage/emulated/12/Download/work-media/photo.png'",
    );
    expect(
      executor
        .getExecutedCommands()
        .some((command) => command.startsWith("shell content query --user 12 --uri ")),
    ).toBe(true);
  });

  test("reports why indexing was not requested when the caller opts out", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    const result = await service.stage({
      device: androidDevice,
      namespace: "run-42",
      indexMedia: false,
      files: [{ contentText: "png", destinationPath: "photo.png" }],
    });

    expect(result.files[0]?.mediaIndexing).toEqual({
      status: "notRequested",
      reason: "media indexing was disabled by indexMedia=false",
    });
    expect(
      adbFactory
        .getFakeClient()
        .getAllCommands()
        .some((command) => command.includes("MEDIA_SCANNER_SCAN_FILE")),
    ).toBe(false);
  });

  test("rejects non-Android devices before issuing commands", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: { deviceId: "ios", name: "iPhone", platform: "ios" },
        namespace: "run-42",
        files: [{ contentText: "hello", destinationPath: "file.txt" }],
      }),
    ).rejects.toThrow("only supported on Android");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("validates every source before resetting the existing namespace", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        reset: true,
        files: [{ sourcePath: "/definitely-missing-5587", destinationPath: "fixture.txt" }],
      }),
    ).rejects.toThrow("ENOENT");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("does not report media indexing complete until MediaStore exposes the file", async () => {
    const executor = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      timer,
    });

    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        files: [
          {
            contentBase64: Buffer.from([1, 2, 3]).toString("base64"),
            destinationPath: "photo.png",
          },
        ],
      }),
    ).rejects.toThrow("media indexing did not complete");
    expect(
      executor.getExecutedCommands().filter((command) => command.includes("content query")),
    ).toHaveLength(20);
  });

  test("rejects prefix-conflicting destinations before touching shared storage", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        reset: true,
        files: [
          { contentText: "nested", destinationPath: "foo/bar.txt" },
          { contentText: "file", destinationPath: "foo" },
        ],
      }),
    ).rejects.toThrow("conflicts with a nested fixture");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("rejects duplicate normalized destinations before touching shared storage", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        reset: true,
        files: [
          { contentText: "first", destinationPath: "fixture.txt" },
          { contentText: "second", destinationPath: "./fixture.txt" },
        ],
      }),
    ).rejects.toThrow("conflicts with a nested fixture");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });
});
