import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAppFileTools } from "../../src/server/appFileTools";
import {
  createAppFileServiceForTesting,
  nodeAppFileFileSystem,
} from "../../src/server/appFileService";
import { createSharedStorageServiceForTesting } from "../../src/server/sharedStorageService";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
beforeEach(() => ToolRegistry.clearTools());
afterEach(() => ToolRegistry.clearTools());
describe("putAppFile shared-storage rollback", () => {
  test("preserves the shared rollback error for a three-file indexing failure", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const service = createSharedStorageServiceForTesting({
      adbFactory: { create: () => adb },
      timer,
      fileSystem: {
        stat: async () => ({ size: 7, isFile: () => true }),
        mkdtemp: async () => "/fake/unused",
        writeFileBuffer: async () => {},
        rm: async () => {},
      },
      createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "primary" }) }),
    });
    const pendingCleanups: Promise<unknown>[] = [];
    registerAppFileTools({
      appFileService: () =>
        createAppFileServiceForTesting({
          sharedStorageService: service,
          fileSystem: {
            ...nodeAppFileFileSystem,
            mkdtemp: async () => "/fake/staging",
            writeFileBuffer: async () => {},
            rm: async () => {},
            stat: async () => ({
              size: 7,
              mtime: new Date(0),
              isFile: () => true,
              isDirectory: () => false,
            }),
          },
        }),
      registerPendingDeviceCleanup: (_deviceId, cleanup) => {
        pendingCleanups.push(cleanup);
      },
    });
    const error = await ToolRegistry.getTool("putAppFile")!.deviceAwareHandler!(androidDevice, {
      target: { domain: "user_files", namespace: "fixtures", indexMedia: true },
      files: ["a.txt", "b.png", "c.txt"].map((destinationPath) => ({
        contentText: "fixture",
        destinationPath,
      })),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toBe(
      "Android shared-storage batch staging failed for b.png: Android media indexing did not complete for /storage/emulated/0/Download/fixtures/b.png within 5 seconds. Rolled back: b.png, a.txt. Rollback failures: none.",
    );
    expect(adb.getExecutedArgv().filter((args) => args[0] === "push")).toHaveLength(2);
    expect(adb.getExecutedCommands()).toContain(
      "shell rm -f '/storage/emulated/0/Download/fixtures/b.png' '/storage/emulated/0/Download/fixtures/a.txt'",
    );
    expect(pendingCleanups).toHaveLength(1);
    await expect(pendingCleanups[0]).rejects.toBe(error);
  });
});
