import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  SwiftcIosFilesFixtureBuilder,
  type IosFilesFixtureBuildFileSystem,
  type IosFilesFixtureBuilder,
} from "../../src/server/IosFilesFixtureBuilder";
import { IosFilesFixtureUnavailableError } from "../../src/server/IosFilesFixtureUnavailableError";
import {
  SimctlIosFilesFixtureInstaller,
  type IosFilesFixtureInstallOutcome,
  type IosFilesFixtureInstaller,
} from "../../src/server/IosFilesFixtureInstaller";
import {
  IOS_FILES_FIXTURE_BUNDLE_ID,
  IosSimulatorUserFilesProvider,
  type IosFilesFixtureContainer,
} from "../../src/server/IosSimulatorUserFilesProvider";
import type { PutAppFileProviderRequest } from "../../src/server/appFileService";
import { IOS_FILES_FIXTURE_SOURCES } from "../../src/server/iosFilesFixtureSources";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeSimctl } from "../fakes/FakeSimctl";

const device: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "fixture simulator",
  platform: "ios",
};
const other: BootedDevice = { ...device, deviceId: "11111111-2222-3333-4444-555555555555" };
const physical: BootedDevice = { ...device, deviceId: "00008110-000A1B2C3D4E5F60" };

const sources = { swift: "// swift", infoPlistTemplate: "<string>__BUNDLE_VERSION__</string>" };
const cacheRoot = "/cache/ios-files-fixture";

class MemoryBuildFileSystem implements IosFilesFixtureBuildFileSystem {
  readonly files = new Map<string, string>();
  readonly operations: string[] = [];
  private tempIndex = 0;
  async exists(path: string) {
    return this.files.has(path) || [...this.files.keys()].some((key) => key.startsWith(`${path}/`));
  }
  async mkdir(path: string) {
    this.operations.push(`mkdir ${path}`);
  }
  async mkdtemp(prefix: string) {
    return `${prefix}${++this.tempIndex}`;
  }
  async writeFile(path: string, content: string) {
    this.files.set(path, content);
  }
  async rename(from: string, to: string) {
    this.operations.push(`rename ${from} ${to}`);
    for (const [key, value] of [...this.files]) {
      if (key.startsWith(`${from}/`)) {
        this.files.set(`${to}${key.slice(from.length)}`, value);
        this.files.delete(key);
      }
    }
  }
  async rm(path: string) {
    this.operations.push(`rm ${path}`);
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.files.delete(key);
      }
    }
  }
}

/** Models swiftc by creating the output executable the builder verifies. */
class FakeToolchain extends FakeHostCommandExecutor {
  constructor(
    private readonly fs: MemoryBuildFileSystem,
    sdkVersion = "26.5",
  ) {
    super();
    this.setCommandResponse("--show-sdk-version", {
      stdout: `${sdkVersion}\n`,
      stderr: "",
    } as never);
    this.setCommandResponse("--show-sdk-path", {
      stdout: "/Xcode/iPhoneSimulator.sdk\n",
      stderr: "",
    } as never);
  }
  override async executeCommand(
    ...args: Parameters<FakeHostCommandExecutor["executeCommand"]>
  ): ReturnType<FakeHostCommandExecutor["executeCommand"]> {
    const result = await super.executeCommand(...args);
    const output = args[1]?.indexOf("-o");
    if (output !== undefined && output >= 0) {
      await this.fs.writeFile(args[1]![output + 1]!, "binary");
    }
    return result;
  }
}

function builderFor(fs: MemoryBuildFileSystem, host: FakeHostCommandExecutor, hostArch = "arm64") {
  return new SwiftcIosFilesFixtureBuilder({
    host,
    fileSystem: fs,
    sources,
    cacheRoot: () => cacheRoot,
    hostArch,
  });
}

describe("embedded Files fixture sources", () => {
  test("enable Files sharing and carry the replaceable bundle version", () => {
    const plist = IOS_FILES_FIXTURE_SOURCES.infoPlistTemplate;
    expect(plist).toContain(IOS_FILES_FIXTURE_BUNDLE_ID);
    expect(plist).toContain("<key>UIFileSharingEnabled</key><true/>");
    expect(plist).toContain("<key>LSSupportsOpeningDocumentsInPlace</key><true/>");
    expect(plist.match(/__BUNDLE_VERSION__/g)).toHaveLength(1);
    expect(IOS_FILES_FIXTURE_SOURCES.swift).toContain("@main");
  });
});

describe("SwiftcIosFilesFixtureBuilder", () => {
  test("builds once, signs ad hoc, and reuses the cached bundle", async () => {
    const fs = new MemoryBuildFileSystem();
    const host = new FakeToolchain(fs);
    const builder = builderFor(fs, host);
    const version = await builder.version();
    expect(version).toMatch(/^\d+$/);

    const app = await builder.ensureBuilt();
    expect(app).toBe(join(cacheRoot, version, "FilesFixture.app"));
    expect(fs.files.get(join(app, "Info.plist"))).toBe(`<string>${version}</string>`);
    const commands = host.getExecutedCommands();
    expect(
      commands.some((c) => c.startsWith("xcrun --sdk iphonesimulator swiftc -sdk /Xcode/")),
    ).toBe(true);
    expect(commands.some((c) => c.includes("-target arm64-apple-ios17.0-simulator"))).toBe(true);
    expect(commands.at(-1)).toStartWith("codesign --force --sign -");
    expect(fs.operations.filter((op) => op.startsWith("rm "))).toHaveLength(1);

    const before = host.getExecutedCommands().length;
    expect(await builderFor(fs, host).ensureBuilt()).toBe(app);
    expect(
      host
        .getExecutedCommands()
        .slice(before)
        .filter((c) => c.includes("swiftc")),
    ).toHaveLength(0);
  });

  test("version follows the SDK, architecture and sources", async () => {
    const fs = new MemoryBuildFileSystem();
    const base = await builderFor(fs, new FakeToolchain(fs, "26.5")).version();
    expect(await builderFor(fs, new FakeToolchain(fs, "26.5")).version()).toBe(base);
    expect(await builderFor(fs, new FakeToolchain(fs, "27.0")).version()).not.toBe(base);
    expect(await builderFor(fs, new FakeToolchain(fs, "26.5"), "x64").version()).not.toBe(base);
    const edited = new SwiftcIosFilesFixtureBuilder({
      host: new FakeToolchain(fs),
      fileSystem: fs,
      sources: { ...sources, swift: "// edited" },
      cacheRoot: () => cacheRoot,
      hostArch: "arm64",
    });
    expect(await edited.version()).not.toBe(base);
  });

  test("concurrent builds share one compilation", async () => {
    const fs = new MemoryBuildFileSystem();
    const host = new FakeToolchain(fs);
    const builder = builderFor(fs, host);
    const [first, second] = await Promise.all([builder.ensureBuilt(), builder.ensureBuilt()]);
    expect(first).toBe(second);
    expect(host.getExecutedCommands().filter((c) => c.includes("swiftc"))).toHaveLength(1);
  });

  test("reports an unavailable toolchain as a typed error, then recovers", async () => {
    const fs = new MemoryBuildFileSystem();
    const host = new FakeToolchain(fs);
    host.setCommandError("--show-sdk-version", new Error("xcrun: not found"));
    const builder = builderFor(fs, host);
    const error = await builder.version().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IosFilesFixtureUnavailableError);
    expect((error as IosFilesFixtureUnavailableError).reason).toBe("toolchain_unavailable");
    expect((error as Error).message).toContain("Install Xcode");

    const healthy = new FakeToolchain(fs);
    const recovered = builderFor(fs, healthy);
    expect(await recovered.version()).toMatch(/^\d+$/);
  });

  test("a compile failure is typed and leaves no cached bundle or temp directory", async () => {
    const fs = new MemoryBuildFileSystem();
    const host = new FakeToolchain(fs);
    host.setCommandError("swiftc", new Error("error: expected declaration"));
    const builder = builderFor(fs, host);
    const error = await builder.ensureBuilt().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IosFilesFixtureUnavailableError);
    expect((error as IosFilesFixtureUnavailableError).reason).toBe("build_failed");
    expect((error as Error).message).toContain("expected declaration");
    expect(fs.files.size).toBe(0);
    expect(fs.operations.some((op) => op.startsWith("rename "))).toBe(false);
  });
});

class FakeBuilder implements IosFilesFixtureBuilder {
  builds = 0;
  failure?: Error;
  constructor(readonly currentVersion = "42") {}
  async version() {
    return this.currentVersion;
  }
  async ensureBuilt() {
    this.builds++;
    if (this.failure) {
      throw this.failure;
    }
    return "/cache/FilesFixture.app";
  }
}

function installedRecord(version: string | undefined) {
  return {
    CFBundleIdentifier: IOS_FILES_FIXTURE_BUNDLE_ID,
    ...(version === undefined ? {} : { CFBundleVersion: version }),
  };
}

describe("SimctlIosFilesFixtureInstaller", () => {
  test("installs on a fresh simulator", async () => {
    const simctl = new FakeSimctl();
    const builder = new FakeBuilder();
    const installer = new SimctlIosFilesFixtureInstaller(builder, () => simctl);
    expect(await installer.ensureInstalled(device)).toBe("installed");
    expect(simctl.getMethodCalls("installApp")).toEqual([
      expect.objectContaining({ appPath: "/cache/FilesFixture.app", deviceId: device.deviceId }),
    ]);
  });

  test("an erased simulator is reinstalled automatically", async () => {
    const simctl = new FakeSimctl();
    const installer = new SimctlIosFilesFixtureInstaller(new FakeBuilder(), () => simctl);
    simctl.setInstalledApps([installedRecord("42")]);
    expect(await installer.ensureInstalled(device)).toBe("current");
    simctl.setInstalledApps([]);
    expect(await installer.ensureInstalled(device)).toBe("installed");
    expect(simctl.getMethodCalls("installApp")).toHaveLength(1);
  });

  test("skips build and install when the installed version matches", async () => {
    const simctl = new FakeSimctl();
    const builder = new FakeBuilder();
    simctl.setInstalledApps([installedRecord("42")]);
    const installer = new SimctlIosFilesFixtureInstaller(builder, () => simctl);
    expect(await installer.ensureInstalled(device)).toBe("current");
    expect(builder.builds).toBe(0);
    expect(simctl.getMethodCalls("installApp")).toEqual([]);
  });

  test.each([["41"], [undefined]])("updates a stale or unversioned install (%p)", async (stale) => {
    const simctl = new FakeSimctl();
    simctl.setInstalledApps([installedRecord(stale)]);
    const installer = new SimctlIosFilesFixtureInstaller(new FakeBuilder(), () => simctl);
    expect(await installer.ensureInstalled(device)).toBe("updated");
  });

  test("concurrent writes to one simulator share a single install", async () => {
    const simctl = new FakeSimctl();
    const builder = new FakeBuilder();
    const installer = new SimctlIosFilesFixtureInstaller(builder, () => simctl);
    const outcomes = await Promise.all([
      installer.ensureInstalled(device),
      installer.ensureInstalled(device),
    ]);
    expect(outcomes).toEqual(["installed", "installed"]);
    expect(simctl.getMethodCalls("installApp")).toHaveLength(1);
  });

  test("rejects a physical device before any build or simctl call", () => {
    const simctl = new FakeSimctl();
    const builder = new FakeBuilder();
    const installer = new SimctlIosFilesFixtureInstaller(builder, () => simctl);
    expect(() => installer.ensureInstalled(physical)).toThrow("only supported on iOS Simulators");
    expect(builder.builds).toBe(0);
    expect(simctl.getMethodCalls("listAppsOrThrow")).toEqual([]);
  });

  test("an unavailable toolchain propagates its typed error without installing", async () => {
    const simctl = new FakeSimctl();
    const builder = new FakeBuilder();
    builder.failure = new IosFilesFixtureUnavailableError("build_failed", "no Xcode");
    const installer = new SimctlIosFilesFixtureInstaller(builder, () => simctl);
    await expect(installer.ensureInstalled(device)).rejects.toThrow("no Xcode");
    expect(simctl.getMethodCalls("installApp")).toEqual([]);
  });

  test("a failed listing or install is a typed install_failed error", async () => {
    const listing = new FakeSimctl();
    listing.setListAppsError(new Error("simctl timed out"));
    const listError = await new SimctlIosFilesFixtureInstaller(new FakeBuilder(), () => listing)
      .ensureInstalled(device)
      .catch((e: unknown) => e);
    expect(listError).toBeInstanceOf(IosFilesFixtureUnavailableError);
    expect((listError as IosFilesFixtureUnavailableError).reason).toBe("install_failed");

    const install = new FakeSimctl();
    install.installApp = async () => {
      throw new Error("simulator not booted");
    };
    const installError = await new SimctlIosFilesFixtureInstaller(new FakeBuilder(), () => install)
      .ensureInstalled(device)
      .catch((e: unknown) => e);
    expect(installError).toBeInstanceOf(IosFilesFixtureUnavailableError);
    expect((installError as Error).message).toContain("simulator not booted");
  });

  test("isInstalled is read-only and reports unknown when the listing fails", async () => {
    const simctl = new FakeSimctl();
    const builder = new FakeBuilder();
    const installer = new SimctlIosFilesFixtureInstaller(builder, () => simctl);
    expect(await installer.isInstalled(device)).toBe(false);
    simctl.setInstalledApps([installedRecord("1")]);
    expect(await installer.isInstalled(device)).toBe(true);
    simctl.setListAppsError(new Error("boom"));
    expect(await installer.isInstalled(device)).toBeUndefined();
    expect(builder.builds).toBe(0);
    expect(simctl.getMethodCalls("installApp")).toEqual([]);
  });
});

class RecordingContainer implements IosFilesFixtureContainer {
  readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
  }
  async stageFiles() {
    this.order.push("stage");
  }
}

class FakeInstaller implements IosFilesFixtureInstaller {
  readonly calls: string[] = [];
  outcome: IosFilesFixtureInstallOutcome = "installed";
  failure?: Error;
  constructor(private readonly order: string[]) {}
  async ensureInstalled(target: BootedDevice) {
    this.order.push("install");
    this.calls.push(target.deviceId);
    if (this.failure) {
      throw this.failure;
    }
    return this.outcome;
  }
  async isInstalled() {
    return true;
  }
}

function put(target: BootedDevice, destinationPath: string): PutAppFileProviderRequest {
  return {
    device: target,
    target: { domain: "user_files", namespace: "run-42" },
    sourcePath: "/host/input.txt",
    destinationPath,
    byteCount: 1,
  };
}

describe("IosSimulatorUserFilesProvider fixture install", () => {
  test("installs before staging and reports one provider_install effect per device", async () => {
    const order: string[] = [];
    const installer = new FakeInstaller(order);
    const provider = new IosSimulatorUserFilesProvider(
      new RecordingContainer(order),
      undefined,
      installer,
    );
    const results = await provider.putFiles([
      put(device, "a.txt"),
      put(device, "b.txt"),
      put(other, "c.txt"),
    ]);
    expect(order).toEqual(["install", "install", "stage"]);
    expect(installer.calls).toEqual([device.deviceId, other.deviceId]);
    const types = results.map((result) => result.effects?.map((effect) => effect.type));
    expect(types).toEqual([
      ["provider_install", "host_stage", "document_picker"],
      ["host_stage", "document_picker"],
      ["provider_install", "host_stage", "document_picker"],
    ]);
    expect(results[0]!.effects![0]).toEqual({ type: "provider_install", status: "completed" });
  });

  test("an already-current fixture adds no install effect", async () => {
    const order: string[] = [];
    const installer = new FakeInstaller(order);
    installer.outcome = "current";
    const provider = new IosSimulatorUserFilesProvider(
      new RecordingContainer(order),
      undefined,
      installer,
    );
    const result = await provider.putFile(put(device, "a.txt"));
    expect(result.effects?.map((effect) => effect.type)).toEqual(["host_stage", "document_picker"]);
  });

  test("an install failure surfaces and nothing is staged", async () => {
    const order: string[] = [];
    const installer = new FakeInstaller(order);
    installer.failure = new IosFilesFixtureUnavailableError("build_failed", "no Xcode");
    const provider = new IosSimulatorUserFilesProvider(
      new RecordingContainer(order),
      undefined,
      installer,
    );
    await expect(provider.putFile(put(device, "a.txt"))).rejects.toThrow("no Xcode");
    expect(order).toEqual(["install"]);
  });

  test("a physical device is rejected before the installer runs", async () => {
    const order: string[] = [];
    const installer = new FakeInstaller(order);
    const provider = new IosSimulatorUserFilesProvider(
      new RecordingContainer(order),
      undefined,
      installer,
    );
    await expect(provider.putFile(put(physical, "a.txt"))).rejects.toBeInstanceOf(ActionableError);
    expect(order).toEqual([]);
  });
});
