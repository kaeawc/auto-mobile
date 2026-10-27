import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { ActionableError, type BootedDevice, toActionableError } from "../models";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../utils/HostCommandExecutor";
import type { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { getTempDir } from "../utils/tempDir";
import { logger } from "../utils/logger";
import {
  IOS_FILES_FIXTURE_INFO_PLIST,
  IOS_FILES_FIXTURE_SWIFT_SOURCE,
} from "./iosFilesFixtureSources";

const EXECUTABLE = "FilesFixture";
const BUILD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 30_000;

/** Installs the managed Files fixture app on a simulator that does not have it (#15404). */
export interface IosFilesFixtureInstaller {
  install(device: BootedDevice, signal?: AbortSignal): Promise<void>;
}

/** The few file operations a build needs, so tests need no disk. */
export interface FixtureBuildFileSystem {
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export const nodeFixtureBuildFileSystem: FixtureBuildFileSystem = {
  exists: async (path) =>
    nodeFs.access(path).then(
      () => true,
      () => false,
    ),
  mkdirp: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  writeText: (path, text) => nodeFs.writeFile(path, text, "utf8"),
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (path) => nodeFs.rm(path, { recursive: true, force: true }),
};

export interface HostBuiltIosFilesFixtureInstallerOptions {
  simctlFactory: (device: BootedDevice) => Pick<SimCtlClient, "executeCommandArgs">;
  host?: HostCommandExecutor;
  fileSystem?: FixtureBuildFileSystem;
  /** Resolved lazily so a data-dir override set after module load is honoured. */
  cacheDir?: () => string;
  arch?: string;
}

/**
 * Builds the fixture with `xcrun --sdk iphonesimulator swiftc` (about 3 s), caches the signed app by
 * source, SDK path and architecture digest, and installs it with `simctl install`. Fails with an
 * actionable error when Xcode's simulator SDK is missing, so the caller can keep its manual-install
 * guidance.
 */
export class HostBuiltIosFilesFixtureInstaller implements IosFilesFixtureInstaller {
  private readonly host: HostCommandExecutor;
  private readonly fileSystem: FixtureBuildFileSystem;
  private readonly cacheDir: () => string;
  private readonly arch: string;
  private readonly building = new Map<string, Promise<string>>();

  constructor(private readonly options: HostBuiltIosFilesFixtureInstallerOptions) {
    this.host = options.host ?? new DefaultHostCommandExecutor();
    this.fileSystem = options.fileSystem ?? nodeFixtureBuildFileSystem;
    this.cacheDir = options.cacheDir ?? (() => getTempDir("ios-files-fixture"));
    this.arch = options.arch ?? (process.arch === "arm64" ? "arm64" : "x86_64");
  }

  async install(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    try {
      const appPath = await this.ensureBuilt(signal);
      await this.options
        .simctlFactory(device)
        .executeCommandArgs(["install", device.deviceId, appPath], INSTALL_TIMEOUT_MS, signal);
    } catch (error) {
      throw toActionableError(error, "Failed to install the managed iOS Files fixture app");
    }
  }

  private ensureBuilt(signal?: AbortSignal): Promise<string> {
    const pending = this.building.get(this.arch);
    if (pending) {
      return pending;
    }
    const build = this.buildOnce(signal).finally(() => this.building.delete(this.arch));
    this.building.set(this.arch, build);
    return build;
  }

  private async buildOnce(signal?: AbortSignal): Promise<string> {
    const sdk = (
      await this.run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], signal)
    ).trim();
    if (sdk === "") {
      throw new ActionableError("xcrun did not report an iphonesimulator SDK path.");
    }
    const digest = createHash("sha256")
      .update(IOS_FILES_FIXTURE_SWIFT_SOURCE)
      .update("\0")
      .update(IOS_FILES_FIXTURE_INFO_PLIST)
      .update("\0")
      .update(sdk)
      .update("\0")
      .update(this.arch)
      .digest("hex")
      .slice(0, 16);
    const root = join(this.cacheDir(), digest);
    const app = join(root, "FilesFixture.app");
    if (await this.fileSystem.exists(join(app, EXECUTABLE))) {
      return app;
    }
    logger.info(`Building the managed iOS Files fixture app (${digest})`);
    const staging = `${root}.building`;
    const stagedApp = join(staging, "FilesFixture.app");
    await this.fileSystem.rm(staging);
    await this.fileSystem.mkdirp(stagedApp);
    const source = join(staging, "FilesFixture.swift");
    await this.fileSystem.writeText(source, IOS_FILES_FIXTURE_SWIFT_SOURCE);
    await this.fileSystem.writeText(join(stagedApp, "Info.plist"), IOS_FILES_FIXTURE_INFO_PLIST);
    await this.run(
      "xcrun",
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-sdk",
        sdk,
        "-target",
        `${this.arch}-apple-ios17.0-simulator`,
        "-parse-as-library",
        source,
        "-o",
        join(stagedApp, EXECUTABLE),
      ],
      signal,
    );
    await this.run("codesign", ["--force", "--sign", "-", stagedApp], signal);
    await this.fileSystem.rm(root);
    await this.fileSystem.rename(staging, root);
    return app;
  }

  private async run(file: string, args: string[], signal?: AbortSignal): Promise<string> {
    const result = await this.host.executeCommand(file, args, {
      timeoutMs: BUILD_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return result.stdout;
  }
}
