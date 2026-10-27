import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  HostBuiltIosFilesFixtureInstaller,
  type FixtureBuildFileSystem,
} from "../../src/server/IosFilesFixtureInstaller";
import {
  IOS_FILES_FIXTURE_INFO_PLIST,
  IOS_FILES_FIXTURE_SWIFT_SOURCE,
} from "../../src/server/iosFilesFixtureSources";
import { IOS_FILES_FIXTURE_BUNDLE_ID } from "../../src/server/IosSimulatorUserFilesProvider";
import { SimctlIosFilesFixtureContainer } from "../../src/server/SimctlIosFilesFixtureContainer";
import { IosSimulatorUserFilesProvider } from "../../src/server/IosSimulatorUserFilesProvider";
import type { BootedDevice } from "../../src/models";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { simulatorDataContainer, simulatorOwnership } from "../helpers/simulatorContainerFixture";

const device: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "sim",
  platform: "ios",
};

class MemoryBuildFs implements FixtureBuildFileSystem {
  readonly paths = new Set<string>();
  readonly texts = new Map<string, string>();
  async exists(path: string) {
    return this.paths.has(path);
  }
  async mkdirp(path: string) {
    this.paths.add(path);
  }
  async writeText(path: string, text: string) {
    this.texts.set(path, text);
    this.paths.add(path);
  }
  async rename(from: string, to: string) {
    for (const path of [...this.paths]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.paths.delete(path);
        this.paths.add(to + path.slice(from.length));
      }
    }
    // The fake swiftc writes nothing; a completed build is what leaves the executable behind.
    this.paths.add(`${to}/FilesFixture.app/FilesFixture`);
  }
  async rm(path: string) {
    for (const entry of [...this.paths]) {
      if (entry === path || entry.startsWith(`${path}/`)) {
        this.paths.delete(entry);
      }
    }
  }
}

function installerHarness() {
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("--show-sdk-path", {
    stdout: "/Xcode/SDKs/iPhoneSimulator.sdk\n",
  } as never);
  const fileSystem = new MemoryBuildFs();
  const simctl = new FakeSimctl();
  const installer = new HostBuiltIosFilesFixtureInstaller({
    simctlFactory: () => simctl,
    host,
    fileSystem,
    cacheDir: () => "/cache",
    arch: "arm64",
  });
  return { host, fileSystem, simctl, installer };
}

describe("managed iOS Files fixture installer (#15404)", () => {
  test("the embedded sources match ios/FilesFixture", () => {
    expect(IOS_FILES_FIXTURE_SWIFT_SOURCE).toBe(
      readFileSync(new URL("../../ios/FilesFixture/FilesFixture.swift", import.meta.url), "utf8"),
    );
    expect(IOS_FILES_FIXTURE_INFO_PLIST).toBe(
      readFileSync(new URL("../../ios/FilesFixture/Info.plist", import.meta.url), "utf8"),
    );
    expect(IOS_FILES_FIXTURE_INFO_PLIST).toContain("UIFileSharingEnabled");
    expect(IOS_FILES_FIXTURE_INFO_PLIST).toContain("LSSupportsOpeningDocumentsInPlace");
    expect(IOS_FILES_FIXTURE_INFO_PLIST).toContain(IOS_FILES_FIXTURE_BUNDLE_ID);
  });

  test("builds, signs and installs the app, then reuses the cached build", async () => {
    const { host, simctl, installer } = installerHarness();

    await installer.install(device);
    await installer.install(device);

    const commands = host.getExecutedCommands();
    expect(commands.filter((command) => command.includes("swiftc"))).toHaveLength(1);
    expect(commands.filter((command) => command.startsWith("codesign"))).toHaveLength(1);
    expect(commands.find((command) => command.includes("swiftc"))).toContain(
      "arm64-apple-ios17.0-simulator",
    );
    const installs = simctl
      .getMethodCalls("executeCommandArgs")
      .filter((call) => (call.args as string[])[0] === "install");
    expect(installs).toHaveLength(2);
    expect((installs[0]!.args as string[])[1]).toBe(device.deviceId);
    expect((installs[0]!.args as string[])[2]).toMatch(
      /^\/cache\/[0-9a-f]{16}\/FilesFixture\.app$/,
    );
  });

  test("a failed build is an actionable install failure and caches nothing", async () => {
    const { host, fileSystem, installer } = installerHarness();
    host.setCommandError("swiftc", new Error("no SDK"));

    await expect(installer.install(device)).rejects.toThrow("Failed to install the managed iOS");
    expect(
      [...fileSystem.paths].some((path) => path.endsWith("FilesFixture.app/FilesFixture")),
    ).toBe(false);
  });

  test("a write installs the fixture once when its container is missing and reports provider_install", async () => {
    const simctl = new FakeSimctl();
    const args = ["get_app_container", device.deviceId, IOS_FILES_FIXTURE_BUNDLE_ID, "data"];
    simctl.setCommandArgsResultSequence(args, [
      new Error("No such file or directory"),
      { stdout: `${simulatorDataContainer(device.deviceId)}\n` },
    ]);
    const installs: string[] = [];
    const memory = new Map<string, Buffer>([["/host/in.txt", Buffer.from("x")]]);
    const fileSystem = {
      stat: async () => ({
        size: 1,
        mtime: new Date(0),
        isFile: () => true,
        isDirectory: () => false,
      }),
      lstat: async (path: string) => {
        if (path === "/host/in.txt") {
          return { size: 1, mtime: new Date(0), isFile: () => true, isDirectory: () => false };
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      mkdir: async () => {},
      copyFile: async (from: string, to: string) => {
        memory.set(to, memory.get(from)!);
      },
      rename: async (from: string, to: string) => {
        memory.set(to, memory.get(from)!);
      },
      rm: async () => {},
    };
    const container = new SimctlIosFilesFixtureContainer(
      () => simctl,
      fileSystem as never,
      simulatorOwnership,
      {
        install: async (target) => {
          installs.push(target.deviceId);
        },
      },
    );
    const provider = new IosSimulatorUserFilesProvider(container);

    const result = await provider.putFile({
      device,
      target: { domain: "user_files", namespace: "run-1" },
      sourcePath: "/host/in.txt",
      destinationPath: "a.txt",
      byteCount: 1,
    });

    expect(installs).toEqual([device.deviceId]);
    expect(result.effects?.map((effect) => effect.type)).toEqual([
      "provider_install",
      "host_stage",
      "document_picker",
    ]);
  });
});
