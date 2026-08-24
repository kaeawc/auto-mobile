import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSharedStorageReadServiceForTesting } from "../../src/server/sharedStorageReadService";
import type { SharedStorageUserResolver } from "../../src/server/sharedStorageReadService";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type {
  ResolvedUserTarget,
  UserTargetRequest,
} from "../../src/utils/android-cmdline-tools/AndroidUserTargetResolver";

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

function resolverReturning(target: ResolvedUserTarget, captured?: UserTargetRequest[]) {
  const resolver: SharedStorageUserResolver = {
    resolve: async (request: UserTargetRequest = {}) => {
      captured?.push(request);
      return target;
    },
  };
  return () => resolver;
}

function serviceWith(
  executor: FakeAdbExecutor,
  target: ResolvedUserTarget = { userId: 0, source: "primary" },
  options: { device?: BootedDevice | null; captured?: UserTargetRequest[] } = {},
) {
  return createSharedStorageReadServiceForTesting({
    adbFactory: adbFactoryFor(executor),
    createUserResolver: resolverReturning(target, options.captured),
    deviceResolver: async () => (options.device === undefined ? androidDevice : options.device),
  });
}

describe("SharedStorageReadService.list", () => {
  test("lists staged files with byte count, MIME, hash, and per-file resource URIs", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse(
      "-exec stat",
      execResult(
        "7|1690000000|/storage/emulated/0/Download/run-42/docs/read me.txt\n" +
          "3|1690000100|/storage/emulated/0/Download/run-42/media/photo.png\n",
      ),
    );
    executor.setCommandResponse(
      "sha256sum",
      execResult(
        "1111111111111111111111111111111111111111111111111111111111111111  /storage/emulated/0/Download/run-42/docs/read me.txt\n" +
          "2222222222222222222222222222222222222222222222222222222222222222  /storage/emulated/0/Download/run-42/media/photo.png\n",
      ),
    );

    const listing = await serviceWith(executor).list({
      deviceId: "emulator-5554",
      namespace: "run-42",
    });

    expect(listing).toEqual({
      deviceId: "emulator-5554",
      platform: "android",
      namespace: "run-42",
      userId: 0,
      userSource: "primary",
      downloadsDirectory: "/storage/emulated/0/Download/run-42",
      observation: "complete",
      files: [
        {
          path: "docs/read me.txt",
          name: "read me.txt",
          byteCount: 7,
          mimeType: "text/plain",
          sha256: "1111111111111111111111111111111111111111111111111111111111111111",
          lastModified: new Date(1690000000 * 1000).toISOString(),
          resourceUri: "automobile:devices/emulator-5554/downloads/run-42/docs/read%20me.txt",
        },
        {
          path: "media/photo.png",
          name: "photo.png",
          byteCount: 3,
          mimeType: "image/png",
          sha256: "2222222222222222222222222222222222222222222222222222222222222222",
          lastModified: new Date(1690000100 * 1000).toISOString(),
          resourceUri: "automobile:devices/emulator-5554/downloads/run-42/media/photo.png",
        },
      ],
    });
  });

  test("distinguishes an existing-but-empty namespace from a missing one", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("-exec stat", execResult(""));
    executor.setCommandResponse("sha256sum", execResult(""));

    const empty = await serviceWith(executor).list({
      deviceId: "emulator-5554",
      namespace: "run-42",
    });
    expect(empty.observation).toBe("complete");
    expect(empty.files).toEqual([]);
  });

  test("reports a missing namespace as a typed observation, not an authoritative empty list", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("-exec stat", execResult("__AUTOMOBILE_NS_MISSING__"));

    const listing = await serviceWith(executor).list({
      deviceId: "emulator-5554",
      namespace: "run-42",
    });
    expect(listing.observation).toBe("missing");
    expect(listing.files).toEqual([]);
    expect(listing.reason).toBeDefined();
  });

  test("reports an unavailable observation when the device cannot be observed", async () => {
    const executor = new FakeAdbExecutor();
    executor.setDefaultError(new Error("device offline"));

    const listing = await serviceWith(executor).list({
      deviceId: "emulator-5554",
      namespace: "run-42",
    });
    expect(listing.observation).toBe("unavailable");
    expect(listing.reason).toContain("device offline");
    expect(listing.files).toEqual([]);
  });

  test("reports unsupported for non-Android devices without issuing commands", async () => {
    const executor = new FakeAdbExecutor();
    const listing = await serviceWith(
      executor,
      { userId: 0, source: "primary" },
      {
        device: { deviceId: "ios", name: "iPhone", platform: "ios" },
      },
    ).list({ deviceId: "ios", namespace: "run-42" });
    expect(listing.observation).toBe("unsupported");
    expect(listing.files).toEqual([]);
    expect(executor.getExecutedCommands()).toEqual([]);
  });

  test("reports unavailable when the device is not booted", async () => {
    const executor = new FakeAdbExecutor();
    const listing = await serviceWith(
      executor,
      { userId: 0, source: "primary" },
      {
        device: null,
      },
    ).list({ deviceId: "ghost", namespace: "run-42" });
    expect(listing.observation).toBe("unavailable");
    expect(listing.reason).toContain("not booted");
  });

  test("targets the resolved profile's Downloads for work-profile devices", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("-exec stat", execResult(""));
    executor.setCommandResponse("sha256sum", execResult(""));
    const captured: UserTargetRequest[] = [];

    const listing = await serviceWith(
      executor,
      { userId: 10, source: "managedProfile" },
      { captured },
    ).list({ deviceId: "emulator-5554", namespace: "run-42", explicitUserId: 10 });

    expect(listing.userId).toBe(10);
    expect(listing.userSource).toBe("managedProfile");
    expect(listing.downloadsDirectory).toBe("/storage/emulated/10/Download/run-42");
    expect(captured[0]?.explicitUserId).toBe(10);
    expect(
      executor
        .getExecutedCommands()
        .some((c) => c.includes("/storage/emulated/10/Download/run-42")),
    ).toBe(true);
  });

  test("reports unavailable when the active profile cannot be resolved", async () => {
    const executor = new FakeAdbExecutor();
    const resolver: SharedStorageUserResolver = {
      resolve: async () => {
        throw new Error("Android target user is ambiguous");
      },
    };
    const service = createSharedStorageReadServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => resolver,
      deviceResolver: async () => androidDevice,
    });
    const listing = await service.list({ deviceId: "emulator-5554", namespace: "run-42" });
    expect(listing.observation).toBe("unavailable");
    expect(listing.reason).toContain("ambiguous");
    expect(executor.getExecutedCommands()).toEqual([]);
  });
});

describe("SharedStorageReadService.read", () => {
  test("reads a UTF-8 file as text with byte count, MIME, and hash", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse(
      "base64",
      execResult(Buffer.from("hello", "utf8").toString("base64")),
    );

    const result = await serviceWith(executor).read({
      deviceId: "emulator-5554",
      namespace: "run-42",
      path: "notes/hi.txt",
    });

    expect(result.observation).toBe("complete");
    expect(result.text).toBe("hello");
    expect(result.blob).toBeUndefined();
    expect(result.byteCount).toBe(5);
    expect(result.mimeType).toBe("text/plain");
    expect(result.sha256).toBe(
      createHash("sha256").update(Buffer.from("hello", "utf8")).digest("hex"),
    );
    expect(result.resourceUri).toBe(
      "automobile:devices/emulator-5554/downloads/run-42/notes/hi.txt",
    );
  });

  test("reads a binary file as a lossless base64 blob", async () => {
    const executor = new FakeAdbExecutor();
    const bytes = Buffer.from([0x00, 0x01, 0xff]);
    executor.setCommandResponse("base64", execResult(bytes.toString("base64")));

    const result = await serviceWith(executor).read({
      deviceId: "emulator-5554",
      namespace: "run-42",
      path: "media/blob.bin",
    });

    expect(result.observation).toBe("complete");
    expect(result.text).toBeUndefined();
    expect(result.blob).toBe(bytes.toString("base64"));
    expect(result.byteCount).toBe(3);
    expect(result.mimeType).toBe("application/octet-stream");
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("reports a missing file as a typed observation", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("base64", execResult("__AUTOMOBILE_FILE_MISSING__"));

    const result = await serviceWith(executor).read({
      deviceId: "emulator-5554",
      namespace: "run-42",
      path: "notes/gone.txt",
    });
    expect(result.observation).toBe("missing");
    expect(result.text).toBeUndefined();
    expect(result.blob).toBeUndefined();
  });

  test("rejects a path that escapes the declared namespace", async () => {
    const executor = new FakeAdbExecutor();
    await expect(
      serviceWith(executor).read({
        deviceId: "emulator-5554",
        namespace: "run-42",
        path: "../../etc/hosts",
      }),
    ).rejects.toThrow();
    expect(executor.getExecutedCommands()).toEqual([]);
  });
});
