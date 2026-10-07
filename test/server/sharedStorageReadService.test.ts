import {
  SimctlIosFilesFixtureContainer,
  nodeAppFileFileSystem,
  IOS_FILES_FIXTURE_BUNDLE_ID,
} from "../../src/server/appFileService";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as hostPath from "node:path";
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

// Device fixtures use `stat -c '%s|%Y|%n'` and sha256sum's exact
// `<64 lowercase hex chars><two spaces><path>` output format.

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

    expect(
      executor
        .getCommandCalls()
        .filter((call) => call.command.includes("-exec stat") || call.command.includes("sha256sum"))
        .map((call) => call.timeoutMs),
    ).toEqual([120_000, 120_000]);

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
    expect(captured[0]?.currentUser).toBe(true);
    expect(
      executor
        .getExecutedCommands()
        .some((c) => c.includes("/storage/emulated/10/Download/run-42")),
    ).toBe(true);
  });

  test("uses current user for list and read when no explicit user is supplied", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("-exec stat", execResult(""));
    executor.setCommandResponse("sha256sum", execResult(""));
    executor.setCommandResponse("base64", execResult(Buffer.from("current").toString("base64")));
    const captured: UserTargetRequest[] = [];
    const service = createSharedStorageReadServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: resolverReturning({ userId: 12, source: "currentUser" }, captured),
      deviceResolver: async () => androidDevice,
    });

    const listing = await service.list({ deviceId: "emulator-5554", namespace: "current" });
    const result = await service.read({
      deviceId: "emulator-5554",
      namespace: "current",
      path: "note.txt",
    });

    expect(captured).toHaveLength(2);
    expect(captured.every((request) => request.currentUser === true)).toBe(true);
    expect(listing.downloadsDirectory).toBe("/storage/emulated/12/Download/current");
    expect(result.userId).toBe(12);
    expect(
      executor
        .getExecutedCommands()
        .some((command) => command.includes("/storage/emulated/12/Download/current/note.txt")),
    ).toBe(true);
  });

  test("explicit user zero wins for both list and read", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("-exec stat", execResult(""));
    executor.setCommandResponse("sha256sum", execResult(""));
    executor.setCommandResponse("base64", execResult(Buffer.from("zero").toString("base64")));
    const captured: UserTargetRequest[] = [];
    const service = createSharedStorageReadServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          captured.push(request);
          return request.explicitUserId !== undefined
            ? { userId: request.explicitUserId, source: "explicit" }
            : { userId: 12, source: "currentUser" };
        },
      }),
      deviceResolver: async () => androidDevice,
    });

    const listing = await service.list({
      deviceId: "emulator-5554",
      namespace: "explicit-zero",
      explicitUserId: 0,
    });
    const result = await service.read({
      deviceId: "emulator-5554",
      namespace: "explicit-zero",
      path: "note.txt",
      explicitUserId: 0,
    });

    expect(captured.map((request) => request.explicitUserId)).toEqual([0, 0]);
    expect(captured.every((request) => request.currentUser === true)).toBe(true);
    expect(listing.downloadsDirectory).toBe("/storage/emulated/0/Download/explicit-zero");
    expect(result.userId).toBe(0);
    expect(
      executor
        .getExecutedCommands()
        .some((command) => command.includes("/storage/emulated/0/Download/explicit-zero/note.txt")),
    ).toBe(true);
  });

  test("reuses hashes for unchanged files without issuing another sha256sum command", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse(
      "-exec stat",
      execResult("4|1690000000|/storage/emulated/0/Download/run-42/a.txt\n"),
    );
    executor.setCommandResponse(
      "sha256sum",
      execResult(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  /storage/emulated/0/Download/run-42/a.txt\n",
      ),
    );
    const service = serviceWith(executor);
    const request = { deviceId: "emulator-5554", namespace: "run-42" };

    await service.list(request);
    const second = await service.list(request);

    expect(second.files[0]?.sha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(
      executor.getExecutedCommands().filter((command) => command.includes("sha256sum")),
    ).toHaveLength(1);
  });

  test("rehashes only files whose size or mtime changed", async () => {
    for (const changedField of ["mtime", "size"] as const) {
      const executor = new FakeAdbExecutor();
      const directory = "/storage/emulated/0/Download/run-42/";
      const firstA = `4|1690000000|${directory}a.txt\n`;
      const changedA =
        changedField === "mtime"
          ? `4|1690000001|${directory}a.txt\n`
          : `5|1690000000|${directory}a.txt\n`;
      const b = `8|1690000000|${directory}b.txt\n`;
      executor.setCommandResponseSequence("-exec stat", [
        execResult(`${firstA}${b}`),
        execResult(`${changedA}${b}`),
      ]);
      executor.setCommandResponse(
        "sha256sum",
        execResult(
          `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ${directory}a.txt\n` +
            `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  ${directory}b.txt\n`,
        ),
      );
      const service = serviceWith(executor);
      const request = { deviceId: "emulator-5554", namespace: "run-42" };

      await service.list(request);
      await service.list(request);

      const hashCommands = executor
        .getExecutedCommands()
        .filter((command) => command.includes("sha256sum"));
      expect(hashCommands).toHaveLength(2);
      expect(hashCommands[1]).toContain("a.txt");
      expect(hashCommands[1]).not.toContain("b.txt");
    }
  });

  test("marks a vanished file's hash unavailable and ignores hashes absent from stat output", async () => {
    const executor = new FakeAdbExecutor();
    const directory = "/storage/emulated/0/Download/run-42/";
    executor.setCommandResponse(
      "-exec stat",
      execResult(`3|1690000000|${directory}vanished.txt\n`),
    );
    executor.setCommandResponse(
      "sha256sum",
      execResult(
        `dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  ${directory}other.txt\n`,
      ),
    );

    const listing = await serviceWith(executor).list({
      deviceId: "emulator-5554",
      namespace: "run-42",
    });

    expect(listing.observation).toBe("complete");
    expect(listing.files).toHaveLength(1);
    expect(listing.files[0]?.sha256).toBeUndefined();
    expect(listing.files[0]?.sha256Unavailable).toContain("disappeared");
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

    expect(
      executor.getCommandCalls().find((call) => call.command.includes("base64"))?.timeoutMs,
    ).toBe(120_000);

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

describe("bounded storage-domain readers", () => {
  test("Android media lists only automobile-media and preserves user_files", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse(
      "-exec stat",
      execResult("3|1690000000|/storage/emulated/0/Download/automobile-media/photo.png\n"),
    );
    const service = serviceWith(executor);
    const listing = await service.list({
      deviceId: androidDevice.deviceId,
      namespace: "automobile-media",
      domain: "media_library",
    });
    expect(listing.observation).toBe("complete");
    expect(listing.files[0]?.resourceUri).toBe(
      "automobile:devices/emulator-5554/storage-domains/media_library/automobile-media/photo.png",
    );
    for (const method of ["list", "read"] as const) {
      const result = await service[method]({
        deviceId: androidDevice.deviceId,
        namespace: "other",
        path: "a.txt",
        domain: "media_library",
      });
      expect(result.observation).toBe("unsupported");
    }
    expect(executor.getExecutedCommands().some((command) => command.includes("/other"))).toBe(
      false,
    );
    executor.setCommandResponse("-exec stat", execResult(""));
    expect(
      (await service.list({ deviceId: androidDevice.deviceId, namespace: "other" }))
        .downloadsDirectory,
    ).toBe("/storage/emulated/0/Download/other");
  });

  test("Android media reads text, binary, and missing observations", async () => {
    const executor = new FakeAdbExecutor();
    const service = serviceWith(executor);
    const request = {
      deviceId: androidDevice.deviceId,
      namespace: "automobile-media",
      path: "photo.png",
      domain: "media_library" as const,
    };
    executor.setCommandResponse("base64", execResult(Buffer.from("hello").toString("base64")));
    expect((await service.read(request)).text).toBe("hello");
    executor.setCommandResponse("base64", execResult("AAH/"));
    const binary = await service.read(request);
    expect(binary.blob).toBe("AAH/");
    expect(binary.byteCount).toBe(3);
    expect(binary.mimeType).toBe("image/png");
    expect(binary.resourceUri).toBe(
      "automobile:devices/emulator-5554/storage-domains/media_library/automobile-media/photo.png",
    );
    executor.setCommandResponse("base64", execResult("__AUTOMOBILE_FILE_MISSING__"));
    expect((await service.read(request)).observation).toBe("missing");
    executor.setCommandResponse("-exec stat", execResult("__AUTOMOBILE_NS_MISSING__"));
    expect((await service.list(request)).observation).toBe("missing");
  });
});

describe("iOS Simulator bounded fixture reads", () => {
  function harness() {
    const device: BootedDevice = {
      deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      platform: "ios",
      name: "Simulator",
    };
    const simctl = new FakeSimCtlClient();
    simctl.setContainerPath(IOS_FILES_FIXTURE_BUNDLE_ID, "/fixture");
    const files = new Map<string, Buffer>([
      ["/fixture/Documents/automobile/run/note.txt", Buffer.from("hello")],
      ["/fixture/Documents/automobile/run/photo.png", Buffer.from([0, 1, 255])],
    ]);
    const symlinks = new Set<string>();
    const reads: string[] = [];
    const directories = new Set([
      "/fixture/Documents",
      "/fixture/Documents/automobile",
      "/fixture/Documents/automobile/run",
    ]);
    const reader = new SimctlIosFilesFixtureContainer(() => simctl, {
      ...nodeAppFileFileSystem,
      lstat: async (path) => {
        if (!files.has(path) && !directories.has(path) && !symlinks.has(path)) {
          throw Object.assign(new Error("missing namespace/file"), { code: "ENOENT" });
        }
        return {
          size: files.get(path)?.length ?? 0,
          mtime: new Date(0),
          isFile: () => files.has(path) && !symlinks.has(path),
          isDirectory: () => directories.has(path) && !symlinks.has(path),
        };
      },
      readdir: async (path) =>
        [...new Set([...files.keys(), ...directories, ...symlinks])]
          .filter(
            (file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"),
          )
          .map((file) => ({ name: file.slice(path.length + 1) })),
      readFileBuffer: async (path) => {
        reads.push(path);
        return files.get(path)!;
      },
    });
    const service = createSharedStorageReadServiceForTesting({
      deviceResolver: async () => device,
      iosFixtureReader: reader,
    });
    const request = { deviceId: device.deviceId, namespace: "run" };
    return { service, request, simctl, symlinks, reads, files, directories };
  }

  test("lists only the fixture namespace using fake simctl and filesystem", async () => {
    const { service, request, simctl } = harness();
    const listing = await service.list(request);
    expect(listing.observation).toBe("complete");
    expect(listing.files.map((file) => file.path)).toEqual(["note.txt", "photo.png"]);
    expect(listing.files[0]?.resourceUri).toContain("/storage-domains/user_files/run/note.txt");
    expect(listing.files[0]?.byteCount).toBe(5);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
  });

  test("reads UTF-8 and binary content with hashes", async () => {
    const { service, request, reads } = harness();
    const text = await service.read({ ...request, path: "note.txt" });
    expect(text.text).toBe("hello");
    expect(text.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    const binary = await service.read({ ...request, path: "photo.png" });
    expect(binary.blob).toBe("AAH/");
    expect(binary.text).toBeUndefined();
    expect(binary.mimeType).toBe("image/png");
    expect(reads.every((path) => path.startsWith("/fixture/Documents/automobile/run/"))).toBe(true);
  });

  test("keeps Simulator paths POSIX when host path functions use Windows semantics", async () => {
    const spies = [
      spyOn(hostPath, "resolve").mockImplementation(hostPath.win32.resolve),
      spyOn(hostPath, "join").mockImplementation(hostPath.win32.join),
      spyOn(hostPath, "relative").mockImplementation(hostPath.win32.relative),
      spyOn(hostPath, "isAbsolute").mockImplementation(hostPath.win32.isAbsolute),
    ];
    try {
      expect(hostPath.join("/fixture", "Documents")).toBe("\\fixture\\Documents");
      const { service, request, files, directories, symlinks, reads } = harness();
      directories.add("/fixture/Documents/automobile/run/nested");
      files.set("/fixture/Documents/automobile/run/nested/note.txt", Buffer.from("nested"));
      const listing = await service.list(request);
      expect(listing.observation).toBe("complete");
      expect(listing.files.map((file) => file.path)).toEqual([
        "note.txt",
        "photo.png",
        "nested/note.txt",
      ]);
      expect((await service.read({ ...request, path: "nested/note.txt" })).text).toBe("nested");
      expect(reads).toEqual(["/fixture/Documents/automobile/run/nested/note.txt"]);
      reads.length = 0;
      for (const path of ["../secret", "..\\secret", "/secret", "\\\\host\\share\\secret"]) {
        await expect(service.read({ ...request, path })).rejects.toThrow();
      }
      symlinks.add("/fixture/Documents/automobile/run/nested");
      expect((await service.read({ ...request, path: "nested/note.txt" })).observation).toBe(
        "unavailable",
      );
      symlinks.add("/fixture/Documents/automobile/run");
      expect((await service.list(request)).observation).toBe("unavailable");
      expect(reads).toEqual([]);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  test("missing files and namespaces remain typed missing observations", async () => {
    const { service, request } = harness();
    expect((await service.read({ ...request, path: "gone.txt" })).observation).toBe("missing");
    expect((await service.list({ ...request, namespace: "unstaged" })).observation).toBe("missing");
    expect(
      (await service.read({ ...request, namespace: "unstaged", path: "note.txt" })).observation,
    ).toBe("missing");
  });

  test("rejects traversal and refuses symlinks without reading their targets", async () => {
    const { service, request, symlinks, reads } = harness();
    await expect(service.read({ ...request, path: "../../secret" })).rejects.toThrow();
    await expect(service.list({ ...request, namespace: "../secret" })).rejects.toThrow();
    symlinks.add("/fixture/Documents/automobile/run");
    expect((await service.read({ ...request, path: "note.txt" })).observation).toBe("unavailable");
    expect((await service.list(request)).observation).toBe("unavailable");
    expect(reads).toEqual([]);
  });

  test("media list/read is unsupported with the recorded reason and no device command", async () => {
    const { service, request, simctl, reads } = harness();
    for (const method of ["list", "read"] as const) {
      const result = await service[method]({
        ...request,
        path: "photo.png",
        domain: "media_library",
      });
      expect(result.observation).toBe("unsupported");
      expect(result.reason).toContain("simctl addmedia");
    }
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    expect(reads).toEqual([]);
  });
});
