import { describe, expect, test } from "bun:test";
import { dirname, normalize } from "node:path";
import type { BootedDevice, ExecResult } from "../../src/models";
import type { AppFileStats } from "../../src/server/appFileService";
import {
  IOS_FILES_FIXTURE_BUNDLE_ID,
  IosUserFilesProvider,
  MarkerDocumentPickerVisibilityVerifier,
  SimctlIosFilesFixtureContainer,
  XcodebuildIosFilesFixtureInstaller,
  type DocumentPickerVisibilityVerifier,
  type IosFilesFixtureContainer,
  type IosFilesFixtureContainerResolution,
  type IosFilesFixtureFileSystem,
  type IosFilesStagedFixture,
} from "../../src/server/iosUserFilesProvider";

const simulator: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "iPhone 15 Pro",
  platform: "ios",
};
const physical: BootedDevice = {
  deviceId: "00008110-001234567890801E",
  name: "iPhone",
  platform: "ios",
};

function result(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("iOS user_files provider (#5807)", () => {
  test("resolves once, resets exactly one namespace, stages a batch, and reports independent effects", async () => {
    const container = new RecordingFixtureContainer();
    const verifier = new RecordingVisibilityVerifier("unavailable");
    const provider = new IosUserFilesProvider(container, verifier);

    const results = await provider.putFiles([
      request("run-42", "docs/one.txt", "/host/one.txt", true, 3),
      request("run-42", "docs/two.txt", "/host/two.txt", false, 4),
    ]);

    expect(container.resolvedDevices).toEqual([simulator.deviceId]);
    expect(container.resetNamespaces).toEqual(["run-42"]);
    expect(container.copies).toEqual([
      ["run-42", "docs/one.txt", "/host/one.txt"],
      ["run-42", "docs/two.txt", "/host/two.txt"],
    ]);
    expect(verifier.destinations).toEqual(["docs/one.txt", "docs/two.txt"]);
    expect(results).toEqual([
      {
        effects: [
          {
            type: "host_stage",
            status: "completed",
            reason:
              "Staged in the managed iOS Files fixture namespace run-42 on AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.",
          },
          {
            type: "document_picker",
            status: "unavailable",
            reason: "The exact fixture has not been observed by the document picker verifier.",
          },
        ],
      },
      {
        effects: [
          {
            type: "host_stage",
            status: "completed",
            reason:
              "Staged in the managed iOS Files fixture namespace run-42 on AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.",
          },
          {
            type: "document_picker",
            status: "unavailable",
            reason: "The exact fixture has not been observed by the document picker verifier.",
          },
        ],
      },
    ]);
  });

  test("rejects physical iOS before resolving a container or invoking the verifier", async () => {
    const container = new RecordingFixtureContainer();
    const verifier = new RecordingVisibilityVerifier("completed");
    const provider = new IosUserFilesProvider(container, verifier);

    await expect(
      provider.putFile({ ...request("run-42", "one.txt", "/host/one.txt"), device: physical }),
    ).rejects.toThrow("only supported on iOS simulators");
    expect(container.resolvedDevices).toEqual([]);
    expect(verifier.destinations).toEqual([]);
  });

  test("resolves the installed managed app through simctl metadata and rejects missing providers", async () => {
    const fileSystem = new MemoryFixtureFileSystem();
    const commands: string[][] = [];
    const available = new SimctlIosFilesFixtureContainer(
      () => ({
        executeCommandArgs: async (args) => {
          commands.push(args);
          return result("/sim/provider-data\n");
        },
      }),
      fileSystem,
    );

    await expect(available.resolve(simulator)).resolves.toEqual({
      dataRoot: "/sim/provider-data",
      managedRoot: "/sim/provider-data/Documents/automobile",
    });
    expect(commands).toEqual([
      ["get_app_container", simulator.deviceId, IOS_FILES_FIXTURE_BUNDLE_ID, "data"],
    ]);

    const missing = new SimctlIosFilesFixtureContainer(
      () => ({
        executeCommandArgs: async () => {
          throw new Error("The application is not installed");
        },
      }),
      fileSystem,
    );
    await expect(missing.resolve(simulator)).rejects.toThrow(
      "managed iOS Files fixture provider is not installed",
    );
    await expect(missing.isAvailable(simulator)).resolves.toBe(false);
    await expect(missing.isAvailable(physical)).resolves.toBe(false);
  });

  test("builds and installs the packaged provider once when the simulator app is missing", async () => {
    const container = new InstallableFixtureContainer();
    const xcodebuildArgs: string[][] = [];
    const simctlArgs: string[][] = [];
    const removed: string[] = [];
    const installer = new XcodebuildIosFilesFixtureInstaller(
      container,
      () => ({
        executeCommandArgs: async (args) => {
          simctlArgs.push(args);
          container.available = true;
          return result();
        },
      }),
      {
        isAvailable: async () => true,
        executeCommand: async (args) => {
          xcodebuildArgs.push(args);
          return result();
        },
        startStreaming: async () => {
          throw new Error("not used");
        },
      },
      "ios/FilesFixtureProvider/FilesFixtureProvider.xcodeproj",
      {
        mkdtemp: async () => "/tmp/fixture-provider-build",
        rm: async (path) => {
          removed.push(path);
        },
      },
    );

    await installer.ensureInstalled(simulator);
    await installer.ensureInstalled(simulator);

    expect(xcodebuildArgs).toHaveLength(1);
    expect(xcodebuildArgs[0]).toContain("FilesFixtureProvider");
    expect(simctlArgs).toEqual([
      [
        "install",
        simulator.deviceId,
        "/tmp/fixture-provider-build/Build/Products/Debug-iphonesimulator/AutoMobile Files.app",
      ],
    ]);
    expect(removed).toEqual(["/tmp/fixture-provider-build"]);
  });

  test("contains writes and reset below Documents/automobile without following symlink parents", async () => {
    const fileSystem = new MemoryFixtureFileSystem();
    const container = resolvedContainer(fileSystem);
    const resolution = await container.resolve(simulator);
    await fileSystem.writeFile("/host/fixture.txt", "fixture");

    await container.resetNamespace(resolution, "run-42");
    await container.putFile(resolution, "run-42", "nested/fixture.txt", "/host/fixture.txt");
    expect(fileSystem.removed.slice(0, 2)).toEqual([
      "/sim/provider-data/Documents/automobile/run-42",
      "/sim/provider-data/Library/Application Support/AutoMobile/staging-identities/run-42",
    ]);
    expect(
      await fileSystem.readText(
        "/sim/provider-data/Documents/automobile/run-42/nested/fixture.txt",
      ),
    ).toBe("fixture");

    fileSystem.addSpecial("/sim/provider-data/Documents/automobile/run-42/redirect");
    await expect(
      container.putFile(resolution, "run-42", "redirect/escape.txt", "/host/fixture.txt"),
    ).rejects.toThrow("Refusing to follow non-directory fixture path");
    expect(
      fileSystem.has("/sim/provider-data/Documents/automobile/run-42/redirect/escape.txt"),
    ).toBe(false);

    fileSystem.addSpecial(
      "/sim/provider-data/Documents/automobile/run-42/nested/existing-fixture.txt",
    );
    await expect(
      container.putFile(resolution, "run-42", "nested/existing-fixture.txt", "/host/fixture.txt"),
    ).rejects.toThrow("Refusing to replace non-file fixture path");
  });

  test("rejects malformed container roots and never broadens namespace reset", async () => {
    const fileSystem = new MemoryFixtureFileSystem();
    const relative = new SimctlIosFilesFixtureContainer(
      () => ({ executeCommandArgs: async () => result("relative/provider") }),
      fileSystem,
    );
    await expect(relative.resolve(simulator)).rejects.toThrow("absolute data container path");

    const container = resolvedContainer(fileSystem);
    const resolution = await container.resolve(simulator);
    await expect(container.resetNamespace(resolution, "../escape")).rejects.toThrow(
      "namespace must be a non-empty single directory name",
    );
    expect(fileSystem.removed).toEqual([]);

    fileSystem.addSpecial(resolution.managedRoot);
    await expect(container.resetNamespace(resolution, "run-42")).rejects.toThrow(
      "Refusing to follow non-directory fixture path",
    );
    expect(fileSystem.removed).toEqual([]);
  });

  test("reports picker completion only for an exact provider-authored marker", async () => {
    const fileSystem = new MemoryFixtureFileSystem();
    const verifier = new MarkerDocumentPickerVisibilityVerifier(fileSystem);
    const resolution: IosFilesFixtureContainerResolution = {
      dataRoot: "/sim/provider-data",
      managedRoot: "/sim/provider-data/Documents/automobile",
    };
    const stagedPath = "/sim/provider-data/Documents/automobile/run-42/nested/fixture.txt";
    await fileSystem.writeFile(stagedPath, "fixture");

    await expect(
      verifier.verify({
        resolution,
        namespace: "run-42",
        destinationPath: "nested/fixture.txt",
        stagedPath,
        generation: "generation-1",
        byteCount: 7,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });

    await fileSystem.writeFile(
      "/sim/provider-data/Library/Application Support/AutoMobile/picker-visibility.json",
      JSON.stringify({
        schemaVersion: 2,
        namespace: "run-42",
        destinationPath: "nested/fixture.txt",
        byteCount: 7,
        sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
        generation: "generation-1",
      }),
    );
    await expect(
      verifier.verify({
        resolution,
        namespace: "run-42",
        destinationPath: "nested/fixture.txt",
        stagedPath,
        generation: "generation-1",
        byteCount: 7,
      }),
    ).resolves.toEqual({
      type: "document_picker",
      status: "completed",
      reason:
        "The managed fixture app observed this exact logical destination in UIDocumentPickerViewController.",
    });
  });

  test("binds picker evidence to staged bytes and invalidates it across namespace reset", async () => {
    const fileSystem = new MemoryFixtureFileSystem();
    const generations = ["generation-1", "generation-2"];
    const container = new SimctlIosFilesFixtureContainer(
      () => ({ executeCommandArgs: async () => result("/sim/provider-data") }),
      fileSystem,
      () => generations.shift()!,
    );
    const resolution = await container.resolve(simulator);
    await fileSystem.writeFile("/host/fixture.txt", "fixture");

    const first = await container.putFile(
      resolution,
      "run-42",
      "nested/fixture.txt",
      "/host/fixture.txt",
    );
    const repeated = await container.putFile(
      resolution,
      "run-42",
      "nested/fixture.txt",
      "/host/fixture.txt",
    );
    expect(repeated.generation).toBe(first.generation);

    await fileSystem.writeFile(
      "/sim/provider-data/Library/Application Support/AutoMobile/picker-visibility.json",
      JSON.stringify({
        schemaVersion: 2,
        namespace: "run-42",
        destinationPath: "nested/fixture.txt",
        byteCount: 7,
        sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
        generation: first.generation,
      }),
    );
    await fileSystem.writeFile("/host/fixture.txt", "changed source after staging");
    const verifier = new MarkerDocumentPickerVisibilityVerifier(fileSystem);
    await expect(
      verifier.verify({
        resolution,
        namespace: "run-42",
        destinationPath: "nested/fixture.txt",
        stagedPath: first.stagedPath,
        generation: first.generation,
        byteCount: 7,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    await container.resetNamespace(resolution, "run-42");
    await fileSystem.writeFile("/host/fixture.txt", "fixture");
    const afterReset = await container.putFile(
      resolution,
      "run-42",
      "nested/fixture.txt",
      "/host/fixture.txt",
    );
    expect(afterReset.generation).toBe("generation-2");
    await expect(
      verifier.verify({
        resolution,
        namespace: "run-42",
        destinationPath: "nested/fixture.txt",
        stagedPath: afterReset.stagedPath,
        generation: afterReset.generation,
        byteCount: 7,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});

function request(
  namespace: string,
  destinationPath: string,
  sourcePath: string,
  reset = false,
  byteCount = 7,
) {
  return {
    device: simulator,
    target: { domain: "user_files" as const, namespace, reset },
    destinationPath,
    sourcePath,
    byteCount,
  };
}

class RecordingFixtureContainer implements IosFilesFixtureContainer {
  readonly resolvedDevices: string[] = [];
  readonly resetNamespaces: string[] = [];
  readonly copies: string[][] = [];

  async resolve(device: BootedDevice): Promise<IosFilesFixtureContainerResolution> {
    this.resolvedDevices.push(device.deviceId);
    return { dataRoot: "/sim/data", managedRoot: "/sim/data/Documents/automobile" };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async resetNamespace(
    _resolution: IosFilesFixtureContainerResolution,
    namespace: string,
  ): Promise<void> {
    this.resetNamespaces.push(namespace);
  }

  async putFile(
    _resolution: IosFilesFixtureContainerResolution,
    namespace: string,
    destinationPath: string,
    sourcePath: string,
  ): Promise<IosFilesStagedFixture> {
    this.copies.push([namespace, destinationPath, sourcePath]);
    return {
      stagedPath: `/sim/data/Documents/automobile/${namespace}/${destinationPath}`,
      generation: "generation-1",
    };
  }
}

class InstallableFixtureContainer extends RecordingFixtureContainer {
  available = false;

  override async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

class RecordingVisibilityVerifier implements DocumentPickerVisibilityVerifier {
  readonly destinations: string[] = [];

  constructor(private readonly status: "completed" | "unavailable") {}

  async verify(request: { destinationPath: string }) {
    this.destinations.push(request.destinationPath);
    return {
      type: "document_picker",
      status: this.status,
      reason:
        this.status === "completed"
          ? "verified"
          : "The exact fixture has not been observed by the document picker verifier.",
    } as const;
  }
}

function resolvedContainer(fileSystem: MemoryFixtureFileSystem) {
  return new SimctlIosFilesFixtureContainer(
    () => ({ executeCommandArgs: async () => result("/sim/provider-data") }),
    fileSystem,
  );
}

class MemoryFixtureFileSystem implements IosFilesFixtureFileSystem {
  readonly removed: string[] = [];
  private readonly files = new Map<string, Buffer>();
  private readonly directories = new Set<string>(["/"]);
  private readonly special = new Set<string>();

  async lstat(path: string): Promise<AppFileStats> {
    const key = this.key(path);
    if (this.special.has(key)) {
      return this.stats("special");
    }
    if (this.directories.has(key)) {
      return this.stats("directory");
    }
    const file = this.files.get(key);
    if (file) {
      return this.stats("file", file.byteLength);
    }
    const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }

  async mkdir(path: string): Promise<void> {
    this.ensureDirectory(path);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    const data = await this.readFileBuffer(sourcePath);
    this.ensureDirectory(dirname(destinationPath));
    this.files.set(this.key(destinationPath), data);
  }

  async writeFileBuffer(path: string, data: Buffer): Promise<void> {
    this.ensureDirectory(dirname(path));
    this.files.set(this.key(path), Buffer.from(data));
  }

  async mkdtemp(prefix: string): Promise<string> {
    const path = `${prefix}fake`;
    this.ensureDirectory(path);
    return path;
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const source = this.files.get(this.key(sourcePath));
    if (!source) {
      throw new Error(`ENOENT: ${sourcePath}`);
    }
    this.ensureDirectory(dirname(destinationPath));
    this.files.set(this.key(destinationPath), source);
    this.files.delete(this.key(sourcePath));
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const data = this.files.get(this.key(path));
    if (!data) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(data);
  }

  async rm(path: string): Promise<void> {
    const key = this.key(path);
    this.removed.push(key);
    const prefix = `${key}/`;
    for (const file of [...this.files.keys()]) {
      if (file === key || file.startsWith(prefix)) {
        this.files.delete(file);
      }
    }
    for (const directory of [...this.directories]) {
      if (directory === key || directory.startsWith(prefix)) {
        this.directories.delete(directory);
      }
    }
    for (const entry of [...this.special]) {
      if (entry === key || entry.startsWith(prefix)) {
        this.special.delete(entry);
      }
    }
  }

  async writeFile(path: string, value: string): Promise<void> {
    this.ensureDirectory(dirname(path));
    this.files.set(this.key(path), Buffer.from(value));
  }

  async readText(path: string): Promise<string> {
    return (await this.readFileBuffer(path)).toString("utf8");
  }

  has(path: string): boolean {
    return this.files.has(this.key(path));
  }

  addSpecial(path: string): void {
    this.ensureDirectory(dirname(path));
    this.special.add(this.key(path));
  }

  private ensureDirectory(path: string): void {
    const key = this.key(path);
    const parts = key.split("/").filter(Boolean);
    let current = "/";
    for (const part of parts) {
      current = current === "/" ? `/${part}` : `${current}/${part}`;
      this.directories.add(current);
    }
  }

  private key(path: string): string {
    return normalize(path).replace(/\\/g, "/");
  }

  private stats(kind: "file" | "directory" | "special", size = 0): AppFileStats {
    return {
      size,
      mtime: new Date("2026-08-28T00:00:00Z"),
      isFile: () => kind === "file",
      isDirectory: () => kind === "directory",
    };
  }
}
