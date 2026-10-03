import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { dirname, join, resolve, sep } from "node:path";
import * as appFiles from "../../src/server/appFileService";
import type {
  AppFileFileSystem,
  AppFileStats,
  PutAppFileProviderRequest,
  IosFilesFixtureContainer,
  DocumentPickerVisibilityVerifier,
} from "../../src/server/appFileService";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { logger } from "../../src/utils/logger";

const device: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "fixture simulator",
  platform: "ios",
};
const physical: BootedDevice = { ...device, deviceId: "00008110-000A1B2C3D4E5F60" };
const root = resolve("/runtime/fixture data");
const namespaceRoot = join(root, "Documents/automobile/run-42");
const source = "/host/input.txt";

class MemoryFileSystem implements AppFileFileSystem {
  readonly files = new Map<string, Buffer>([[source, Buffer.from("fixture")]]);
  readonly directories = new Set<string>();
  readonly links = new Set<string>();
  readonly calls: Array<{ operation: string; paths: string[] }> = [];
  failure?: string;
  cleanupFailure = false;
  private tempIndex = 0;

  private record(operation: string, ...paths: string[]) {
    this.calls.push({ operation, paths });
    if (this.failure === operation) {
      throw new Error(`${operation} failed`);
    }
  }
  async stat(path: string): Promise<AppFileStats> {
    this.record("stat", path);
    return this.stats(path);
  }
  async lstat(path: string): Promise<AppFileStats> {
    this.record("lstat", path);
    if (this.links.has(path)) {
      return { size: 0, mtime: new Date(0), isFile: () => false, isDirectory: () => false };
    }
    return this.stats(path);
  }
  private stats(path: string): AppFileStats {
    if (!this.files.has(path) && !this.directories.has(path)) {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
    return {
      size: this.files.get(path)?.length ?? 0,
      mtime: new Date(0),
      isFile: () => this.files.has(path),
      isDirectory: () => this.directories.has(path),
    };
  }
  async readdir(): Promise<Array<{ name: string }>> {
    throw new Error("listing is not exposed");
  }
  async mkdir(path: string): Promise<void> {
    this.record("mkdir", path);
    let parent = path;
    while (parent !== dirname(parent)) {
      this.directories.add(parent);
      parent = dirname(parent);
    }
  }
  async copyFile(from: string, to: string): Promise<void> {
    // A partial copy must be cleaned on failure.
    this.files.set(to, Buffer.from(this.files.get(from) ?? "partial"));
    this.record("copyFile", from, to);
  }
  async rename(from: string, to: string): Promise<void> {
    this.record("rename", from, to);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  async readFileBuffer(path: string): Promise<Buffer> {
    this.record("readFileBuffer", path);
    return this.files.get(path)!;
  }
  async writeFileBuffer(path: string, data: Buffer): Promise<void> {
    this.record("writeFileBuffer", path);
    this.files.set(path, data);
  }
  async mkdtemp(prefix: string): Promise<string> {
    this.record("mkdtemp", prefix);
    return `${prefix}${++this.tempIndex}`;
  }
  async rm(path: string): Promise<void> {
    this.record("rm", path);
    if (this.cleanupFailure) {
      throw new Error("cleanup failed");
    }
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(`${path}${sep}`)) {
        this.files.delete(key);
      }
    }
    for (const key of this.directories) {
      if (key === path || key.startsWith(`${path}${sep}`)) {
        this.directories.delete(key);
      }
    }
  }
}

class FakeFixtureContainer implements IosFilesFixtureContainer {
  readonly batches: PutAppFileProviderRequest[][] = [];
  failure?: Error;
  async stageFiles(requests: readonly PutAppFileProviderRequest[]): Promise<void> {
    // Retain the batch without allowing the provider to mutate our record.
    this.batches.push([...requests]);
    if (this.failure) {
      throw this.failure;
    }
  }
}
class FakePickerVerifier implements DocumentPickerVisibilityVerifier {
  readonly requests: Array<Parameters<DocumentPickerVisibilityVerifier["verify"]>[0]> = [];
  status: "completed" | "unavailable" = "completed";
  reason = "Observed exact fixture selection";
  failure?: Error;
  async verify(request: Parameters<DocumentPickerVisibilityVerifier["verify"]>[0]) {
    this.requests.push(request);
    if (this.failure) {
      throw this.failure;
    }
    return { status: this.status, reason: this.reason };
  }
}
function request(overrides: Partial<PutAppFileProviderRequest> = {}): PutAppFileProviderRequest {
  return {
    device,
    target: { domain: "user_files", namespace: "run-42" },
    sourcePath: source,
    destinationPath: "nested/input.txt",
    byteCount: 7,
    ...overrides,
  };
}
function harness() {
  const fs = new MemoryFileSystem();
  const simctl = new FakeSimCtlClient();
  const args = ["get_app_container", device.deviceId, appFiles.IOS_FILES_FIXTURE_BUNDLE_ID, "data"];
  // Only single-path stdout is trimmed; there is no simctl-output parser fixture.
  simctl.setCommandArgsResult(args, ` ${root}\n`);
  const factory = () => simctl as unknown as SimCtlClient;
  const container = new appFiles.SimctlIosFilesFixtureContainer(factory, fs);
  const provider = new appFiles.IosSimulatorUserFilesProvider(container);
  return { fs, simctl, args, factory, container, provider };
}
const removed = (fs: MemoryFileSystem) =>
  fs.calls.filter((call) => call.operation === "rm").map((call) => call.paths[0]);

afterEach(() => {
  spyOn(logger, "warn").mockRestore();
});

describe("iOS Simulator user_files", () => {
  test("rejects physical UDIDs before any simctl or filesystem access", async () => {
    const { provider, fs, simctl } = harness();
    await expect(provider.putFile(request({ device: physical }))).rejects.toThrow(ActionableError);
    await expect(provider.putFile(request({ device: physical }))).rejects.toThrow(
      "on-device fixture-app integration",
    );
    expect(fs.calls).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });
  test("service rejects physical UDIDs before preparing host sources", async () => {
    const fs = new MemoryFileSystem();
    let simctlCalls = 0;
    const service = appFiles.createAppFileServiceForTesting({
      fileSystem: fs,
      simctlFactory: () => {
        simctlCalls++;
        throw new Error("must not call simctl");
      },
    });
    await expect(
      service.putFile({
        device: physical,
        target: { domain: "user_files", namespace: "run-42" },
        files: [{ sourcePath: source, destinationPath: "input.txt" }],
      }),
    ).rejects.toThrow("on-device fixture-app integration");
    expect(fs.calls).toEqual([]);
    expect(simctlCalls).toBe(0);
  });
  test.each(["empty", "command failure"])(
    "fixture unavailable (%s) gives install guidance with no filesystem access",
    async (mode) => {
      const { provider, fs, simctl, args } = harness();
      if (mode === "empty") {
        simctl.setCommandArgsResult(args, "  \n");
      } else {
        simctl.setCommandArgsError(args, new Error("fixture missing"));
      }
      await expect(provider.putFile(request())).rejects.toThrow(ActionableError);
      await expect(provider.putFile(request())).rejects.toThrow(
        "Install the managed iOS Files fixture app",
      );
      expect(fs.calls).toEqual([]);
    },
  );
  test("resolves runtime container with argv, atomically stages, and reports unverified picker visibility", async () => {
    const { provider, fs, simctl, args } = harness();
    const signal = new AbortController().signal;
    const command = spyOn(simctl, "executeCommandArgs");
    const result = await provider.putFile(request({ signal }));
    const target = join(namespaceRoot, "nested/input.txt");
    const temporary = join(dirname(target), ".input.txt.1.tmp");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([{ args, timeoutMs: 5000 }]);
    expect(command).toHaveBeenCalledWith(args, 5000, signal);
    expect(
      fs.calls.filter((call) => ["mkdir", "copyFile", "rename"].includes(call.operation)),
    ).toEqual([
      { operation: "mkdir", paths: [dirname(target)] },
      { operation: "copyFile", paths: [source, temporary] },
      { operation: "rename", paths: [temporary, target] },
    ]);
    expect(fs.files.get(target)?.toString()).toBe("fixture");
    expect(fs.files.has(temporary)).toBe(false);
    expect(result.effects).toEqual([
      { type: "host_stage", status: "completed" },
      {
        type: "document_picker",
        status: "unavailable",
        reason: expect.stringContaining("no document-picker verifier"),
      },
    ]);
  });
  test.each(["mkdir", "copyFile", "rename"])(
    "atomic %s failure cleans temporary and preserves destination",
    async (failure) => {
      const { provider, fs } = harness();
      const target = join(namespaceRoot, "nested/input.txt");
      fs.files.set(target, Buffer.from("original"));
      fs.failure = failure;
      await expect(provider.putFile(request())).rejects.toThrow(`${failure} failed`);
      expect(fs.files.get(target)?.toString()).toBe("original");
      expect(removed(fs)).toEqual([join(dirname(target), ".input.txt.1.tmp")]);
      expect([...fs.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
    },
  );
  test("rejects relative container stdout without a fallback or filesystem access", async () => {
    const { provider, fs, simctl, args } = harness();
    simctl.setCommandArgsResult(args, "relative/container");
    await expect(provider.putFile(request())).rejects.toThrow(
      "Install the managed iOS Files fixture app",
    );
    expect(fs.calls).toEqual([]);
  });
  test("validates later batch paths before any reset or copy", async () => {
    const { provider, fs, simctl } = harness();
    await expect(
      provider.putFiles([
        request({ target: { domain: "user_files", namespace: "run-42", reset: true } }),
        request({ destinationPath: "../escape" }),
      ]),
    ).rejects.toThrow();
    expect(fs.calls).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });
  test("rejects a different target domain before I/O", async () => {
    const { provider, fs } = harness();
    await expect(
      provider.putFile(request({ target: { domain: "media_library" } })),
    ).rejects.toThrow("user_files");
    expect(fs.calls).toEqual([]);
  });
  test("empty batch performs no I/O or verification", async () => {
    const { container, fs, simctl } = harness();
    const verifier = new FakePickerVerifier();
    expect(
      await new appFiles.IosSimulatorUserFilesProvider(container, verifier).putFiles([]),
    ).toEqual([]);
    expect(fs.calls).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    expect(verifier.requests).toEqual([]);
  });
  test("direct batch duplicate reset flags still reset the namespace only once", async () => {
    const { provider, fs } = harness();
    const target = { domain: "user_files" as const, namespace: "run-42", reset: true };
    await provider.putFiles([
      request({ target, destinationPath: "one.txt" }),
      request({ target, destinationPath: "two.txt" }),
    ]);
    expect(removed(fs)).toEqual([namespaceRoot]);
    expect(fs.files.has(join(namespaceRoot, "one.txt"))).toBe(true);
    expect(fs.files.has(join(namespaceRoot, "two.txt"))).toBe(true);
  });
  test("cleanup failure logs without masking the copy failure", async () => {
    const { provider, fs } = harness();
    fs.failure = "copyFile";
    fs.cleanupFailure = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    await expect(provider.putFile(request())).rejects.toThrow("copyFile failed");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to remove partial iOS app file"),
      expect.any(Error),
    );
  });
  test.each([
    "../escape",
    resolve("/host/input.txt"),
    "nested/../../escape",
    "nested\\..\\escape",
    "",
    "nested//input.txt",
    "bad\0file",
  ])("rejects destination traversal/invalid path %p before any I/O", async (destinationPath) => {
    const { provider, fs, simctl } = harness();
    await expect(provider.putFile(request({ destinationPath }))).rejects.toThrow();
    expect(fs.calls).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });
  test.each(["..", ".", "../other", "one/two", "one\\two", "", "bad\0ns"])(
    "rejects invalid namespace %p before any I/O",
    async (namespace) => {
      const { provider, fs, simctl } = harness();
      await expect(
        provider.putFile(request({ target: { domain: "user_files", namespace, reset: true } })),
      ).rejects.toThrow();
      expect(fs.calls).toEqual([]);
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    },
  );
  test("reset removes exactly one namespace and preserves Documents, neighbors, and host source", async () => {
    const { provider, fs } = harness();
    const untouched = [
      join(root, "Documents/keep.txt"),
      join(root, "Documents/automobile/other/input.txt"),
      source,
    ];
    for (const path of untouched) {
      fs.files.set(path, Buffer.from("keep"));
    }
    fs.files.set(join(namespaceRoot, "stale.txt"), Buffer.from("stale"));
    await provider.putFile(
      request({ target: { domain: "user_files", namespace: "run-42", reset: true } }),
    );
    expect(removed(fs)).toEqual([namespaceRoot]);
    expect(fs.files.has(join(namespaceRoot, "stale.txt"))).toBe(false);
    for (const path of untouched) {
      expect(fs.files.get(path)?.toString()).toBe("keep");
    }
  });
  test("default registry routes iOS user_files batch and resets once", async () => {
    const { fs, simctl, factory } = harness();
    const service = appFiles.createAppFileServiceForTesting({
      fileSystem: fs,
      simctlFactory: factory,
    });
    const result = await service.putFile({
      device,
      target: { domain: "user_files", namespace: "run-42", reset: true },
      files: ["one.txt", "two.txt"].map((destinationPath) => ({
        sourcePath: source,
        destinationPath,
      })),
    });
    expect(removed(fs)).toEqual([namespaceRoot]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
    for (const name of ["one.txt", "two.txt"]) {
      expect(fs.files.get(join(namespaceRoot, name))?.toString()).toBe("fixture");
    }
    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.resourceUri === undefined)).toBe(true);
    expect(service.describeProviderCoverage?.()).toContainEqual({
      platform: "ios",
      domain: "user_files",
      write: true,
      list: false,
      read: false,
      namespaceReset: true,
      mediaIndexing: false,
    });
  });
  test("failed namespace reset prevents copying and picker verification", async () => {
    const { container, fs } = harness();
    const verifier = new FakePickerVerifier();
    const provider = new appFiles.IosSimulatorUserFilesProvider(container, verifier);
    fs.failure = "rm";
    await expect(
      provider.putFile(
        request({ target: { domain: "user_files", namespace: "run-42", reset: true } }),
      ),
    ).rejects.toThrow("rm failed");
    expect(fs.calls.some((call) => call.operation === "copyFile")).toBe(false);
    expect(verifier.requests).toEqual([]);
  });
  test.each([
    "Documents",
    "Documents/automobile",
    "Documents/automobile/run-42",
    "Documents/automobile/run-42/nested",
    "Documents/automobile/run-42/nested/input.txt",
  ])("rejects symlink containment escape at %s", async (path) => {
    const { provider, fs } = harness();
    fs.links.add(join(root, path));
    await expect(
      provider.putFile(
        request({ target: { domain: "user_files", namespace: "run-42", reset: true } }),
      ),
    ).rejects.toThrow("symlink");
    expect(removed(fs)).toEqual([]);
    expect(fs.calls.some((call) => call.operation === "copyFile")).toBe(false);
  });
  test("unexpected containment stat failure surfaces without mutating", async () => {
    const { provider, fs } = harness();
    fs.failure = "lstat";
    await expect(provider.putFile(request())).rejects.toThrow("lstat failed");
    expect(fs.calls.every((call) => call.operation === "lstat")).toBe(true);
  });
  test.each(["completed", "unavailable"] as const)(
    "injected verifier alone controls document_picker %s",
    async (status) => {
      const container = new FakeFixtureContainer();
      const verifier = new FakePickerVerifier();
      verifier.status = status;
      const provider = new appFiles.IosSimulatorUserFilesProvider(container, verifier);
      const signal = new AbortController().signal;
      const result = await provider.putFile(request({ signal }));
      expect(container.batches).toHaveLength(1);
      expect(verifier.requests).toEqual([
        { device, namespace: "run-42", destinationPath: "nested/input.txt", signal },
      ]);
      expect(result.effects).toEqual([
        { type: "host_stage", status: "completed" },
        { type: "document_picker", status, reason: verifier.reason },
      ]);
    },
  );
  test("verifier exceptions log and return unavailable after a completed copy", async () => {
    const { container, fs } = harness();
    const verifier = new FakePickerVerifier();
    verifier.failure = new Error("picker disconnected");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const result = await new appFiles.IosSimulatorUserFilesProvider(container, verifier).putFile(
      request(),
    );
    expect(fs.files.get(join(namespaceRoot, "nested/input.txt"))?.toString()).toBe("fixture");
    expect(result.effects[0]).toEqual({ type: "host_stage", status: "completed" });
    expect(result.effects[1]).toEqual({
      type: "document_picker",
      status: "unavailable",
      reason: expect.stringContaining("picker disconnected"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("picker disconnected"),
      verifier.failure,
    );
  });
  test("injected container failure never claims host_stage or invokes verifier", async () => {
    const container = new FakeFixtureContainer();
    container.failure = new ActionableError("container unavailable");
    const verifier = new FakePickerVerifier();
    await expect(
      new appFiles.IosSimulatorUserFilesProvider(container, verifier).putFile(request()),
    ).rejects.toThrow("container unavailable");
    expect(verifier.requests).toEqual([]);
  });
  test("service dependencies inject container and verifier and preserve reset-on-first-file", async () => {
    const fs = new MemoryFileSystem();
    const container = new FakeFixtureContainer();
    const verifier = new FakePickerVerifier();
    const service = appFiles.createAppFileServiceForTesting({
      fileSystem: fs,
      iosFilesFixtureContainer: container,
      documentPickerVisibilityVerifier: verifier,
    });
    await service.putFile({
      device,
      target: { domain: "user_files", namespace: " run-42 ", reset: true },
      files: ["one.txt", "two.txt"].map((destinationPath) => ({
        sourcePath: source,
        destinationPath,
      })),
    });
    expect(container.batches[0]?.map((file) => file.target)).toEqual([
      { domain: "user_files", namespace: "run-42", reset: true },
      { domain: "user_files", namespace: "run-42", reset: false },
    ]);
    expect(verifier.requests).toHaveLength(2);
  });
});
