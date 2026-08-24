import { describe, expect, test } from "bun:test";
import { createSharedStorageServiceForTesting } from "../../src/server/sharedStorageService";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

function execResult(stdout: string) {
  return { stdout, stderr: "", toString: () => stdout, trim: () => stdout.trim(), includes: (text: string) => stdout.includes(text) };
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
        { contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "media/photo.png" },
      ],
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      namespace: "run-42",
      destinationDirectory: "/sdcard/Download/run-42",
      reset: true,
      files: [
        {
          destinationPath: "docs/read me.txt",
          byteCount: 7,
          mediaIndexing: {
            status: "notRequested",
            reason: "media indexing was not requested for docs/read me.txt; Android document pickers discover files directly from Downloads",
          },
        },
        { destinationPath: "media/photo.png", byteCount: 3, mediaIndexing: { status: "completed" } },
      ],
    });

    const commands = executor.getExecutedCommands();
    expect(commands[0]).toBe("shell rm -rf '/sdcard/Download/run-42'");
    expect(commands).toContain("shell mkdir -p '/sdcard/Download/run-42'");
    expect(commands).toContain("shell mkdir -p '/sdcard/Download/run-42/docs'");
    expect(commands).toContain("shell mkdir -p '/sdcard/Download/run-42/media'");
    expect(commands.some(command => command.includes("push ") && command.includes("/sdcard/Download/run-42/docs/read me.txt"))).toBe(true);
    expect(commands.some(command => command.includes("MEDIA_SCANNER_SCAN_FILE") && command.includes("file:///sdcard/Download/run-42/media/photo.png"))).toBe(true);
    expect(commands.some(command => command.includes("content query") && command.includes("external_primary/images/media"))).toBe(true);
    expect(commands.every(command => !command.includes(".."))).toBe(true);
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
    expect(adbFactory.getFakeClient().getAllCommands().some(command => command.includes("MEDIA_SCANNER_SCAN_FILE"))).toBe(false);
  });

  test("rejects non-Android devices before issuing commands", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(service.stage({
      device: { deviceId: "ios", name: "iPhone", platform: "ios" },
      namespace: "run-42",
      files: [{ contentText: "hello", destinationPath: "file.txt" }],
    })).rejects.toThrow("only supported on Android");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("validates every source before resetting the existing namespace", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(service.stage({
      device: androidDevice,
      namespace: "run-42",
      reset: true,
      files: [{ sourcePath: "/definitely-missing-5587", destinationPath: "fixture.txt" }],
    })).rejects.toThrow("ENOENT");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("does not report media indexing complete until MediaStore exposes the file", async () => {
    const executor = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const service = createSharedStorageServiceForTesting({ adbFactory: adbFactoryFor(executor), timer });

    await expect(service.stage({
      device: androidDevice,
      namespace: "run-42",
      files: [{ contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "photo.png" }],
    })).rejects.toThrow("media indexing did not complete");
    expect(executor.getExecutedCommands().filter(command => command.includes("content query"))).toHaveLength(20);
  });
});
