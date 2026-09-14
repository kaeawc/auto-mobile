import { describe, expect, test } from "bun:test";
import {
  createDownloadsFixtureService,
  StageSessionDownloadsRefusal,
} from "../../src/server/downloadsFixtureService";
import {
  createSharedStorageServiceForTesting,
  type StageSharedStorageResult,
} from "../../src/server/sharedStorageService";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type {
  SharedStorageService,
  StageSharedStorageRequest,
} from "../../src/server/sharedStorageService";
import type { ActiveSessionDevice } from "../../src/server/activeSessionDevice";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
const iosDevice: BootedDevice = {
  deviceId: "SIM-UDID",
  name: "iPhone 15",
  platform: "ios",
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

function activeAndroid(sessionUuid: string): ActiveSessionDevice {
  return { sessionUuid, device: androidDevice };
}

describe("DownloadsFixtureService (#7007)", () => {
  test("resets exactly the named Downloads subdirectory and stages the named file", async () => {
    const executor = new FakeAdbExecutor();
    const adbFactory: AdbClientFactory = { create: () => executor };
    const service = createDownloadsFixtureService({
      resolveActiveSession: () => activeAndroid("session-1"),
      sharedStorage: () => createSharedStorageServiceForTesting({ adbFactory }),
    });

    const result = await service.stage({
      sessionUuid: "session-1",
      directory: "run-42",
      reset: true,
      indexMedia: false,
      files: [{ contentText: "fixture", destinationPath: "docs/read.txt" }],
    });

    expect(result).toMatchObject({
      success: true,
      sessionUuid: "session-1",
      platform: "android",
      directory: "run-42",
      reset: true,
      destinationDirectory: "/storage/emulated/0/Download/run-42",
    });

    const commands = executor.getExecutedCommands();
    expect(commands).toContain("shell rm -rf '/storage/emulated/0/Download/run-42'");
    // Nothing outside the declared directory is removed.
    expect(commands.filter((command) => command.startsWith("shell rm -rf "))).toEqual([
      "shell rm -rf '/storage/emulated/0/Download/run-42'",
    ]);
    expect(
      executor
        .getExecutedArgv()
        .some((argv) => argv[0] === "push" && argv[2].endsWith("/run-42/docs/read.txt")),
    ).toBe(true);
  });

  test("returns a per-file media-index result when indexing is requested", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const adbFactory: AdbClientFactory = { create: () => executor };
    const service = createDownloadsFixtureService({
      resolveActiveSession: () => activeAndroid("session-1"),
      sharedStorage: () => createSharedStorageServiceForTesting({ adbFactory }),
    });

    const result = await service.stage({
      sessionUuid: "session-1",
      directory: "media-run",
      indexMedia: true,
      files: [
        { contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "photo.png" },
        { contentText: "notes", destinationPath: "notes.txt" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.files).toEqual([
      { destinationPath: "photo.png", byteCount: 3, mediaIndexing: { status: "completed" } },
      {
        destinationPath: "notes.txt",
        byteCount: 5,
        mediaIndexing: {
          status: "notRequested",
          reason:
            "media indexing was not requested for notes.txt; Android document pickers discover files directly from Downloads",
        },
      },
    ]);
    expect(
      executor
        .getExecutedCommands()
        .some(
          (command) =>
            command.includes("MEDIA_SCANNER_SCAN_FILE") &&
            command.includes("Download/media-run/photo.png"),
        ),
    ).toBe(true);
  });

  test("refuses an unbound session before constructing any device client", async () => {
    let resolverCalls = 0;
    let stageCalls = 0;
    let deviceClientsCreated = 0;
    const adbFactory: AdbClientFactory = {
      create: () => {
        deviceClientsCreated += 1;
        return new FakeAdbExecutor();
      },
    };
    const sharedStorage: SharedStorageService = {
      stage: async (request: StageSharedStorageRequest) => {
        stageCalls += 1;
        // touch the factory so the counter would move if we ever got here
        adbFactory.create(request.device);
        throw new Error("must not stage on refusal");
      },
    };
    const service = createDownloadsFixtureService({
      resolveActiveSession: () => {
        resolverCalls += 1;
        return activeAndroid("session-1");
      },
      sharedStorage: () => sharedStorage,
    });

    await expect(
      service.stage({
        sessionUuid: "   ",
        directory: "run-42",
        files: [{ contentText: "x", destinationPath: "a.txt" }],
      }),
    ).rejects.toBeInstanceOf(StageSessionDownloadsRefusal);

    expect(resolverCalls).toBe(0);
    expect(stageCalls).toBe(0);
    expect(deviceClientsCreated).toBe(0);
  });

  test("refuses an inactive session after resolving, before any device access", async () => {
    let stageCalls = 0;
    const sharedStorage: SharedStorageService = {
      stage: async () => {
        stageCalls += 1;
        throw new Error("must not stage on refusal");
      },
    };
    const service = createDownloadsFixtureService({
      resolveActiveSession: () => undefined,
      sharedStorage: () => sharedStorage,
    });

    const error = await service
      .stage({
        sessionUuid: "session-gone",
        directory: "run-42",
        files: [{ contentText: "x", destinationPath: "a.txt" }],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StageSessionDownloadsRefusal);
    expect((error as StageSessionDownloadsRefusal).code).toBe("SESSION_NOT_ACTIVE");
    expect(stageCalls).toBe(0);
  });

  test("returns unavailable for an iOS session without touching shared storage", async () => {
    let stageCalls = 0;
    const sharedStorage: SharedStorageService = {
      stage: async () => {
        stageCalls += 1;
        throw new Error("must not stage on iOS");
      },
    };
    const service = createDownloadsFixtureService({
      resolveActiveSession: (sessionUuid) => ({ sessionUuid, device: iosDevice }),
      sharedStorage: () => sharedStorage,
    });

    const result = await service.stage({
      sessionUuid: "session-ios",
      directory: "run-42",
      files: [{ contentText: "x", destinationPath: "a.txt" }],
    });

    expect(result).toEqual({
      success: false,
      sessionUuid: "session-ios",
      deviceId: "SIM-UDID",
      platform: "ios",
      status: "unavailable",
      reason:
        "Shared Downloads staging is only available on Android; iOS has no user-visible " +
        "shared Downloads tree.",
    });
    expect(stageCalls).toBe(0);
  });

  test("keeps a released device quarantined until an in-flight stage settles", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [androidDevice]);
    const devicePool = new DevicePool(sessionManager, "daemon-test", timer, undefined, deviceUtils);
    const staging = Promise.withResolvers<StageSharedStorageResult>();
    try {
      await devicePool.initializeWithDevices([androidDevice]);
      await devicePool.bindOrReuseDeviceSession("session-1", androidDevice.deviceId, "android");
      DaemonState.getInstance().initialize(sessionManager, devicePool);
      const service = createDownloadsFixtureService({
        resolveActiveSession: () => activeAndroid("session-1"),
        sharedStorage: () => ({ stage: async () => staging.promise }),
      });

      const stage = service.stage({
        sessionUuid: "session-1",
        directory: "run-42",
        files: [{ contentText: "x", destinationPath: "a.txt" }],
      });
      expect(sessionManager.getPendingDeviceCleanup(androidDevice.deviceId)).not.toBeNull();

      await sessionManager.releaseSession("session-1");
      await devicePool.releaseDevice(androidDevice.deviceId, "session-1");
      expect(devicePool.getDevice(androidDevice.deviceId)?.status).toBe("busy");

      staging.resolve({
        success: true,
        deviceId: androidDevice.deviceId,
        platform: "android",
        namespace: "run-42",
        userId: 0,
        userSource: "primary",
        destinationDirectory: "/storage/emulated/0/Download/run-42",
        reset: false,
        files: [],
      });
      await stage;
      await sessionManager.getPendingDeviceCleanup(androidDevice.deviceId);
      await Promise.resolve();
      expect(devicePool.getDevice(androidDevice.deviceId)?.status).toBe("idle");
    } finally {
      staging.resolve({
        success: true,
        deviceId: androidDevice.deviceId,
        platform: "android",
        namespace: "run-42",
        userId: 0,
        userSource: "primary",
        destinationDirectory: "/storage/emulated/0/Download/run-42",
        reset: false,
        files: [],
      });
      DaemonState.getInstance().reset();
      sessionManager.stopCleanupTimer();
    }
  });
});
