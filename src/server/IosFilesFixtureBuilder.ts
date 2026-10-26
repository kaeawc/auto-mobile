import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import type { HostCommandExecutor } from "../utils/HostCommandExecutor";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { IosFilesFixtureUnavailableError } from "./IosFilesFixtureUnavailableError";
import { IOS_FILES_FIXTURE_SOURCES } from "./iosFilesFixtureSources";

export const IOS_FILES_FIXTURE_APP_NAME = "FilesFixture";

export interface IosFilesFixtureSources {
  swift: string;
  infoPlistTemplate: string;
}

/** Produces the installable fixture bundle; `version` is the CFBundleVersion it carries. */
export interface IosFilesFixtureBuilder {
  /** Cheap and side-effect free: identifies the bundle `ensureBuilt` would produce. */
  version(signal?: AbortSignal): Promise<string>;
  /** Returns the path of a signed `.app`, building it once per version. */
  ensureBuilt(signal?: AbortSignal): Promise<string>;
}

export interface IosFilesFixtureBuildFileSystem {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export const nodeIosFilesFixtureBuildFileSystem: IosFilesFixtureBuildFileSystem = {
  exists: async (path) =>
    nodeFs.access(path).then(
      () => true,
      () => false,
    ),
  mkdir: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  mkdtemp: (prefix) => nodeFs.mkdtemp(prefix),
  writeFile: (path, content) => nodeFs.writeFile(path, content, "utf8"),
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (path) => nodeFs.rm(path, { recursive: true, force: true }),
};

const VERSION_PLACEHOLDER = "__BUNDLE_VERSION__";
const DEPLOYMENT_TARGET = "17.0";
const TOOL_TIMEOUT_MS = 120_000;

export interface SwiftcIosFilesFixtureBuilderOptions {
  host: HostCommandExecutor;
  /** Directory holding one subdirectory per built version. */
  cacheRoot: () => string;
  fileSystem?: IosFilesFixtureBuildFileSystem;
  sources?: IosFilesFixtureSources;
  /** Simulator architecture; Node reports `arm64` or `x64`. */
  hostArch?: string;
}

/**
 * Builds the fixture with the Xcode toolchain the simulator already requires
 * (`xcrun --sdk iphonesimulator swiftc`, about 1 s) and caches it by a digest of the sources
 * and SDK, so a new SDK or edited source rebuilds and everything else reuses the cached bundle.
 */
export class SwiftcIosFilesFixtureBuilder implements IosFilesFixtureBuilder {
  private readonly host: HostCommandExecutor;
  private readonly cacheRoot: () => string;
  private readonly fileSystem: IosFilesFixtureBuildFileSystem;
  private readonly sources: IosFilesFixtureSources;
  private readonly arch: string;
  private versionPromise: Promise<string> | undefined;
  private building: Promise<string> | undefined;

  constructor(options: SwiftcIosFilesFixtureBuilderOptions) {
    this.host = options.host;
    this.cacheRoot = options.cacheRoot;
    this.fileSystem = options.fileSystem ?? nodeIosFilesFixtureBuildFileSystem;
    this.sources = options.sources ?? IOS_FILES_FIXTURE_SOURCES;
    this.arch = (options.hostArch ?? process.arch) === "x64" ? "x86_64" : "arm64";
  }

  version(signal?: AbortSignal): Promise<string> {
    // A failed SDK query is not cached, so installing Xcode later recovers without a restart.
    this.versionPromise ??= this.computeVersion(signal).catch((error: unknown) => {
      this.versionPromise = undefined;
      throw error;
    });
    return this.versionPromise;
  }

  ensureBuilt(signal?: AbortSignal): Promise<string> {
    this.building ??= this.buildOnce(signal).finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async computeVersion(signal?: AbortSignal): Promise<string> {
    const sdkVersion = (await this.xcrun(["--show-sdk-version"], signal)).trim();
    if (!sdkVersion) {
      throw new IosFilesFixtureUnavailableError(
        "toolchain_unavailable",
        "Unable to determine the iOS Simulator SDK version. Install Xcode and run `xcode-select --switch` to it, then retry.",
      );
    }
    const digest = createHash("sha256")
      .update(JSON.stringify([this.sources.swift, this.sources.infoPlistTemplate, sdkVersion]))
      .update(this.arch)
      .digest("hex");
    // CFBundleVersion stays purely numeric; 48 bits keep accidental collisions negligible.
    return BigInt(`0x${digest.slice(0, 12)}`).toString(10);
  }

  private async xcrun(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.host.executeCommand(
        "xcrun",
        ["--sdk", "iphonesimulator", ...args],
        {
          timeoutMs: TOOL_TIMEOUT_MS,
          signal,
        },
      );
      return result.stdout;
    } catch (error) {
      throw new IosFilesFixtureUnavailableError(
        "toolchain_unavailable",
        `The Xcode iOS Simulator toolchain is unavailable (xcrun ${args.join(" ")}): ${errorMessage(error)}. Install Xcode and its command line tools, then retry.`,
        { cause: error },
      );
    }
  }

  private async buildOnce(signal?: AbortSignal): Promise<string> {
    const version = await this.version(signal);
    const finalApp = join(this.cacheRoot(), version, `${IOS_FILES_FIXTURE_APP_NAME}.app`);
    if (await this.isBuilt(finalApp)) {
      return finalApp;
    }
    await this.fileSystem.mkdir(this.cacheRoot());
    const workDir = await this.fileSystem.mkdtemp(join(this.cacheRoot(), ".build-"));
    try {
      await this.compile(workDir, version, signal);
      await this.fileSystem.mkdir(join(this.cacheRoot(), version));
      try {
        await this.fileSystem.rename(join(workDir, `${IOS_FILES_FIXTURE_APP_NAME}.app`), finalApp);
      } catch (error) {
        // Another daemon may have published the same version first; that bundle is equivalent.
        if (!(await this.isBuilt(finalApp))) {
          throw error;
        }
        logger.debug(`iOS Files fixture ${version} was published concurrently: ${error}`);
      }
      return finalApp;
    } catch (error) {
      if (error instanceof IosFilesFixtureUnavailableError) {
        throw error;
      }
      throw new IosFilesFixtureUnavailableError(
        "build_failed",
        `Failed to build the managed iOS Files fixture app: ${errorMessage(error)}`,
        { cause: error },
      );
    } finally {
      await this.fileSystem.rm(workDir).catch((error: unknown) => {
        // A leftover temporary build directory is harmless and is never reused.
        logger.debug(`Failed to remove iOS Files fixture build directory ${workDir}: ${error}`);
      });
    }
  }

  private isBuilt(app: string): Promise<boolean> {
    return this.fileSystem.exists(join(app, IOS_FILES_FIXTURE_APP_NAME));
  }

  private async compile(workDir: string, version: string, signal?: AbortSignal): Promise<void> {
    const app = join(workDir, `${IOS_FILES_FIXTURE_APP_NAME}.app`);
    const source = join(workDir, `${IOS_FILES_FIXTURE_APP_NAME}.swift`);
    await this.fileSystem.mkdir(app);
    await this.fileSystem.writeFile(source, this.sources.swift);
    await this.fileSystem.writeFile(
      join(app, "Info.plist"),
      this.sources.infoPlistTemplate.replace(VERSION_PLACEHOLDER, version),
    );
    const sdkPath = (await this.xcrun(["--show-sdk-path"], signal)).trim();
    await this.run(
      "xcrun",
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-sdk",
        sdkPath,
        "-target",
        `${this.arch}-apple-ios${DEPLOYMENT_TARGET}-simulator`,
        "-parse-as-library",
        source,
        "-o",
        join(app, IOS_FILES_FIXTURE_APP_NAME),
      ],
      signal,
    );
    await this.run("codesign", ["--force", "--sign", "-", app], signal);
  }

  private async run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
    await this.host.executeCommand(command, args, { timeoutMs: TOOL_TIMEOUT_MS, signal });
  }
}
