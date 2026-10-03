import { logger } from "../../src/utils/logger";
import { describe, expect, spyOn, test } from "bun:test";
import {
  createSharedStorageServiceForTesting,
  type SharedStorageFileSystem,
} from "../../src/server/sharedStorageService";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { UserTargetRequest } from "../../src/utils/android-cmdline-tools/AndroidUserTargetResolver";
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
    expect(commands[0]).toBe("shell am get-current-user");
    expect(commands[1]).toBe("shell rm -rf '/storage/emulated/0/Download/run-42'");
    expect(
      executor.getCommandCalls().find((call) => call.command.startsWith("shell rm -rf"))?.timeoutMs,
    ).toBe(120_000);
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
      executor
        .getCommandCalls()
        .filter((call) => call.command.startsWith("push "))
        .map((call) => call.timeoutMs),
    ).toEqual([120_000, 120_000]);
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
    // A session release may cancel staging while a child is still exiting. Every
    // shared-storage mutation must remain pending until that process settles,
    // rather than rejecting immediately on abort.
    expect(
      executor
        .getCommandCalls()
        .filter((call) => /shell (?:rm -rf|mkdir -p|am broadcast)|^push /.test(call.command))
        .every((call) => call.waitForProcessSettlementAfterAbort === true),
    ).toBe(true);
  });

  test("uses the resolved active profile rather than assuming Android user zero", async () => {
    const executor = new FakeAdbExecutor();
    const requests: UserTargetRequest[] = [];
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          requests.push(request ?? {});
          return { userId: 12, source: "managedProfile" };
        },
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
    expect(requests).toEqual([{ explicitUserId: undefined, currentUser: true, signal: undefined }]);
    expect(executor.getExecutedCommands()).toContain(
      "shell rm -rf '/storage/emulated/12/Download/work-fixtures'",
    );
    expect(executor.getExecutedArgv()).toContainEqual([
      "push",
      expect.stringContaining("automobile-shared-storage-"),
      "/storage/emulated/12/Download/work-fixtures/document.txt",
    ]);
  });

  test("honors explicit user zero while still preferring current-user resolution otherwise", async () => {
    const executor = new FakeAdbExecutor();
    const requests: UserTargetRequest[] = [];
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          requests.push(request ?? {});
          return request?.explicitUserId !== undefined
            ? { userId: request.explicitUserId, source: "explicit" }
            : { userId: 12, source: "currentUser" };
        },
      }),
    });

    const result = await service.stage({
      device: androidDevice,
      namespace: "explicit-zero",
      explicitUserId: 0,
      files: [{ contentText: "zero", destinationPath: "fixture.txt" }],
    });

    expect(requests).toEqual([{ explicitUserId: 0, currentUser: true, signal: undefined }]);
    expect(result).toMatchObject({
      userId: 0,
      userSource: "explicit",
      destinationDirectory: "/storage/emulated/0/Download/explicit-zero",
    });
  });

  test("scopes MediaStore scanning and storage paths to a non-zero current user", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const requests: UserTargetRequest[] = [];
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          requests.push(request ?? {});
          return { userId: 12, source: "currentUser" };
        },
      }),
    });

    const result = await service.stage({
      device: androidDevice,
      namespace: "work-media",
      files: [
        { contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "photo.png" },
      ],
    });

    expect(requests[0]?.currentUser).toBe(true);
    expect(result.destinationDirectory).toBe("/storage/emulated/12/Download/work-media");
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

  for (const cleanupFails of [false, true]) {
    test(`cleans a failed inline write and preserves its error (cleanup fails: ${cleanupFails})`, async () => {
      const original = new Error("disk full");
      const cleanupError = new Error("cleanup denied");
      const removed: string[] = [];
      const fileSystem: SharedStorageFileSystem = {
        stat: async () => {
          throw new Error("not used");
        },
        mkdtemp: async () => "/fake/shared-write",
        writeFileBuffer: async () => {
          throw original;
        },
        rm: async (path) => {
          removed.push(path);
          if (cleanupFails) {
            throw cleanupError;
          }
        },
      };
      const adbFactory = new FakeAdbClientFactory();
      const service = createSharedStorageServiceForTesting({ fileSystem, adbFactory });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(
          service.stage({
            device: androidDevice,
            namespace: "run-42",
            files: [{ contentText: "hello", destinationPath: "file.txt" }],
          }),
        ).rejects.toBe(original);
        expect(removed).toEqual(["/fake/shared-write"]);
        expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
        if (cleanupFails) {
          expect(warn).toHaveBeenCalledWith(
            "Failed to remove inline shared-storage directory: cleanup denied",
            cleanupError,
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("cleans inline fixture directories when active user resolution fails", async () => {
    const removed: string[] = [];
    let nextDir = 0;
    const fileSystem: SharedStorageFileSystem = {
      stat: async () => {
        throw new Error("not used");
      },
      mkdtemp: async () => `/fake/shared-${++nextDir}`,
      writeFileBuffer: async () => {},
      rm: async (path) => {
        removed.push(path);
      },
    };
    const service = createSharedStorageServiceForTesting({
      fileSystem,
      createUserResolver: () => ({
        resolve: async () => {
          throw new Error("no profile");
        },
      }),
    });

    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        files: [
          { contentText: "first", destinationPath: "first.txt" },
          { contentBase64: "eA==", destinationPath: "second.txt" },
        ],
      }),
    ).rejects.toThrow("no profile");
    expect(removed).toEqual(["/fake/shared-1", "/fake/shared-2"]);
  });
});
