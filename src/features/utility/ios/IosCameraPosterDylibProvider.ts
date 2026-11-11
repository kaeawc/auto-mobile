import { ENV, readEnvRaw } from "../../../config/env";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { SingleFlight } from "../../../utils/cache/SingleFlight";
import { formatCommandError } from "../../../utils/CommandError";
import { DefaultFileSystem, type FileSystem } from "../../../utils/filesystem/DefaultFileSystem";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../../utils/HostCommandExecutor";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { logger } from "../../../utils/logger";
import { getTempDir } from "../../../utils/tempDir";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";

export interface IosCameraPosterDylibProvider {
  ensure(): Promise<string>;
}

type PosterFileSystem = Pick<
  FileSystem,
  "existsSync" | "readFileBuffer" | "ensureDir" | "rename" | "unlink" | "stat"
>;
export interface IosCameraPosterDylibDependencies {
  fileSystem?: PosterFileSystem;
  runner?: HostCommandExecutor;
  idGenerator?: IdGenerator;
  env?: NodeJS.ProcessEnv;
  directory?: () => string;
  sourcePaths?: string[];
  /** Where this module runs from; its ancestors are searched for the packaged or checkout source. */
  moduleDirectory?: string;
}

/** Shipped in the npm package (package.json `files`) and present in a repo checkout. */
export const IOS_CAMERA_POSTER_SOURCE =
  "ios/CameraPosterInjection/Injection/CameraPosterInjection.m";
/**
 * Both simulator slices: Apple silicon and Intel hosts, and an arm64 host whose Node runs under
 * Rosetta (where process.arch would name the wrong simulator architecture).
 */
export const IOS_CAMERA_POSTER_ARCHS = ["arm64", "x86_64"] as const;
/** Part of the cache directory name, so a build with other slices is never reused. */
const BUILD_FLAVOR = "sim-universal";
const XCODE_HINT =
  "Install Xcode and run xcode-select --install, or set AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB to a prebuilt libAMCameraPoster.dylib";

/** Source-addressed, atomic simulator dylib builds; no compiler is invoked until a poster launch. */
export class DefaultIosCameraPosterDylibProvider implements IosCameraPosterDylibProvider {
  private readonly fs: PosterFileSystem;
  private readonly runner: HostCommandExecutor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly flights = new SingleFlight<string, string>();

  constructor(private readonly deps: IosCameraPosterDylibDependencies = {}) {
    this.fs = deps.fileSystem ?? new DefaultFileSystem();
    this.runner = deps.runner ?? new DefaultHostCommandExecutor();
    this.env = deps.env ?? process.env;
  }

  async ensure(): Promise<string> {
    try {
      const override = readEnvRaw(ENV.IOS_CAMERA_POSTER_DYLIB, this.env);
      if (override !== undefined) {
        const path = resolvePathFromDaemonLaunchWorkingDirectory(override, this.env);
        if (!override || !(await this.isFile(path))) {
          throw new ActionableError(
            `AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB does not name an existing dylib: ${path}. Set it to a prebuilt libAMCameraPoster.dylib.`,
          );
        }
        return path;
      }
      const source = await this.findSource();
      const digest = createHash("sha256")
        .update(await this.fs.readFileBuffer(source))
        .digest("hex")
        .slice(0, 12);
      const directory = join(
        (this.deps.directory ?? (() => getTempDir("ios-camera-poster")))(),
        `${digest}-${BUILD_FLAVOR}`,
      );
      const output = join(directory, "libAMCameraPoster.dylib");
      return await this.flights.run(output, () => this.build(source, directory, output));
    } catch (error) {
      throw toActionableError(error, "Unable to prepare the iOS Simulator camera poster dylib");
    }
  }

  private async isFile(path: string): Promise<boolean> {
    if (!this.fs.existsSync(path)) {
      return false;
    }
    return (await this.fs.stat(path)).isFile?.() !== false;
  }

  private async findSource(): Promise<string> {
    const override = readEnvRaw(ENV.IOS_CAMERA_POSTER_SOURCE, this.env);
    const candidates =
      override !== undefined
        ? [override]
        : (this.deps.sourcePaths ?? [
            ...sourcePathsFromModule(
              this.deps.moduleDirectory ?? dirname(fileURLToPath(import.meta.url)),
            ),
            resolvePathFromDaemonLaunchWorkingDirectory(IOS_CAMERA_POSTER_SOURCE, this.env),
          ]);
    for (const candidate of candidates) {
      const path = resolvePathFromDaemonLaunchWorkingDirectory(candidate, this.env);
      if (await this.isFile(path)) {
        return path;
      }
    }
    throw new ActionableError(
      `iOS camera poster source not found (${IOS_CAMERA_POSTER_SOURCE} beside the installed package or in a repo checkout). Reinstall the package, set AUTOMOBILE_IOS_CAMERA_POSTER_SOURCE to CameraPosterInjection.m, or set AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB to a prebuilt libAMCameraPoster.dylib.`,
    );
  }

  private async build(source: string, directory: string, output: string): Promise<string> {
    if (await this.isFile(output)) {
      return output;
    }
    try {
      await this.runner.executeCommand("xcrun", ["--sdk", "iphonesimulator", "--find", "clang"]);
    } catch (error) {
      throw new ActionableError(
        `iOS camera poster compiler unavailable. ${XCODE_HINT}. ${formatCommandError(error, { command: "xcrun" })}`,
        { cause: error },
      );
    }
    await this.fs.ensureDir(directory);
    const partial = `${output}.${(this.deps.idGenerator ?? defaultIdGenerator).next()}.tmp`;
    try {
      await this.runBuildCommand("xcrun", [
        "--sdk",
        "iphonesimulator",
        "clang",
        ...IOS_CAMERA_POSTER_ARCHS.flatMap((arch) => ["-arch", arch]),
        "-dynamiclib",
        "-fobjc-arc",
        ...[
          "Foundation",
          "UIKit",
          "AVFoundation",
          "CoreImage",
          "CoreMedia",
          "CoreVideo",
          "ImageIO",
          "UniformTypeIdentifiers",
        ].flatMap((framework) => ["-framework", framework]),
        "-mios-simulator-version-min=17.0",
        source,
        "-o",
        partial,
      ]);
      await this.runBuildCommand("codesign", ["-f", "-s", "-", partial]);
      await this.fs.rename(partial, output);
      return output;
    } finally {
      if (this.fs.existsSync(partial)) {
        try {
          await this.fs.unlink(partial);
        } catch (error) {
          // An abandoned partial is never used as a cache entry.
          logger.warn("Failed to remove camera poster build partial", error);
        }
      }
    }
  }

  private async runBuildCommand(command: string, args: string[]): Promise<void> {
    try {
      await this.runner.executeCommand(command, args);
    } catch (error) {
      throw new ActionableError(
        `iOS camera poster compile/sign failed. ${XCODE_HINT}. ${formatCommandError(error, { command, args })}`,
        { cause: error },
      );
    }
  }
}

export const iosCameraPosterDylibProvider: IosCameraPosterDylibProvider =
  new DefaultIosCameraPosterDylibProvider();

/**
 * Walk ancestors so source modules and bundled dist/src chunks find the same file: the package
 * root of an installed package (`<root>/dist/src/...`) or a repo checkout.
 */
export function sourcePathsFromModule(moduleDirectory: string): string[] {
  const paths: string[] = [];
  let directory = moduleDirectory;
  while (true) {
    paths.push(join(directory, IOS_CAMERA_POSTER_SOURCE));
    const parent = dirname(directory);
    if (parent === directory) {
      return paths;
    }
    directory = parent;
  }
}
