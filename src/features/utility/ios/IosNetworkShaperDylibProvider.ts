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
import { AMBIENT_ENV, readEnvTrimmed } from "../../../config/env";
import { logger } from "../../../utils/logger";
import { getTempDir } from "../../../utils/tempDir";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";
import { sourcePathsFromModule } from "./IosCameraPosterDylibProvider";

/** Builds (once per source version) the socket shaper the simulator boots with (#19045). */
export interface IosNetworkShaperDylibProvider {
  ensure(): Promise<string>;
}

/** Shipped in the npm package (package.json `files`) and present in a repo checkout. */
export const IOS_NETWORK_SHAPER_SOURCE = "ios/NetworkShaper/netshape.c";
/** Link stub for the runtime's private libdns_services, whose resolver results the shaper hooks. */
export const IOS_NETWORK_SHAPER_DNS_STUB = "ios/NetworkShaper/libdns_services.tbd";
/** Both simulator slices, as for the camera poster dylib. */
export const IOS_NETWORK_SHAPER_ARCHS = ["arm64", "x86_64"] as const;
export const IOS_NETWORK_SHAPER_DYLIB_NAME = "libAMNetworkShaper.dylib";
const BUILD_FLAVOR = "sim-universal";
/** The repository's Xcode pin (`select_pinned_xcode`), present in a repo checkout only. */
export const IOS_XCODE_PIN_SCRIPT = "scripts/ios/xcode_version.sh";
const XCODE_HINT = "Install Xcode and run xcode-select --install";

type ShaperFileSystem = Pick<
  FileSystem,
  "existsSync" | "readFileBuffer" | "ensureDir" | "rename" | "unlink" | "stat"
>;

export interface IosNetworkShaperDylibDependencies {
  fileSystem?: ShaperFileSystem;
  runner?: HostCommandExecutor;
  idGenerator?: IdGenerator;
  env?: NodeJS.ProcessEnv;
  directory?: () => string;
  /** Candidate directories holding `ios/NetworkShaper/`; defaults to the module's ancestors. */
  rootCandidates?: string[];
}

interface ShaperToolchain {
  /** The build environment with the selected DEVELOPER_DIR, or undefined for the active Xcode. */
  env?: NodeJS.ProcessEnv;
  /** clang's path and the simulator SDK build, folded into the build cache key. */
  identity: string;
}

/** Source-addressed, atomic simulator dylib builds; no compiler runs until a shaped boot. */
export class DefaultIosNetworkShaperDylibProvider implements IosNetworkShaperDylibProvider {
  private readonly fs: ShaperFileSystem;
  private readonly runner: HostCommandExecutor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly flights = new SingleFlight<string, string>();
  private toolchain?: Promise<ShaperToolchain>;

  constructor(private readonly deps: IosNetworkShaperDylibDependencies = {}) {
    this.fs = deps.fileSystem ?? new DefaultFileSystem();
    this.runner = deps.runner ?? new DefaultHostCommandExecutor();
    this.env = deps.env ?? process.env;
  }

  async ensure(): Promise<string> {
    try {
      const { source, stub } = await this.findSources();
      const toolchain = await this.resolveToolchain(source);
      const digest = createHash("sha256")
        .update(await this.fs.readFileBuffer(source))
        .update(await this.fs.readFileBuffer(stub))
        // A different Xcode or simulator SDK is a different build.
        .update(toolchain.identity)
        .digest("hex")
        .slice(0, 12);
      const directory = join(
        (this.deps.directory ?? (() => getTempDir("ios-network-shaper")))(),
        `${digest}-${BUILD_FLAVOR}`,
      );
      const output = join(directory, IOS_NETWORK_SHAPER_DYLIB_NAME);
      return await this.flights.run(output, () =>
        this.build({ source, stub }, toolchain, directory, output),
      );
    } catch (error) {
      throw toActionableError(error, "Unable to prepare the iOS Simulator network shaper dylib");
    }
  }

  private async isFile(path: string): Promise<boolean> {
    if (!this.fs.existsSync(path)) {
      return false;
    }
    return (await this.fs.stat(path)).isFile?.() !== false;
  }

  private async findSources(): Promise<{ source: string; stub: string }> {
    const sources = this.deps.rootCandidates
      ? this.deps.rootCandidates.map((root) => join(root, IOS_NETWORK_SHAPER_SOURCE))
      : [
          ...sourcePathsFromModule(
            dirname(fileURLToPath(import.meta.url)),
            IOS_NETWORK_SHAPER_SOURCE,
          ),
          resolvePathFromDaemonLaunchWorkingDirectory(IOS_NETWORK_SHAPER_SOURCE, this.env),
        ];
    for (const source of sources) {
      const stub = join(dirname(source), "libdns_services.tbd");
      if ((await this.isFile(source)) && (await this.isFile(stub))) {
        return { source, stub };
      }
    }
    throw new ActionableError(
      `iOS network shaper source not found (${IOS_NETWORK_SHAPER_SOURCE} and ${IOS_NETWORK_SHAPER_DNS_STUB} beside the installed package or in a repo checkout). Reinstall the package.`,
    );
  }

  /** Memoized per provider; a failed resolution is retried by the next call. */
  private resolveToolchain(source: string): Promise<ShaperToolchain> {
    this.toolchain ??= this.readToolchain(source).catch((error: unknown) => {
      this.toolchain = undefined;
      throw error;
    });
    return this.toolchain;
  }

  /**
   * The Xcode the build uses: the caller's DEVELOPER_DIR, else the repository pin in a repo
   * checkout (the same `select_pinned_xcode` local build scripts use), else the active Xcode.
   */
  private async readToolchain(source: string): Promise<ShaperToolchain> {
    const developerDir =
      readEnvTrimmed(AMBIENT_ENV.DEVELOPER_DIR, this.env) ||
      (await this.pinnedDeveloperDir(source));
    const env = developerDir ? { ...this.env, DEVELOPER_DIR: developerDir } : undefined;
    const options = env ? { env } : undefined;
    try {
      const clang = await this.runner.executeCommand(
        "xcrun",
        ["--sdk", "iphonesimulator", "--find", "clang"],
        options,
      );
      const sdk = await this.runner.executeCommand(
        "xcrun",
        ["--sdk", "iphonesimulator", "--show-sdk-build-version"],
        options,
      );
      return { env, identity: `${clang.stdout.trim()}\n${sdk.stdout.trim()}` };
    } catch (error) {
      throw new ActionableError(
        `iOS network shaper compiler unavailable. ${XCODE_HINT}. ${formatCommandError(error, { command: "xcrun" })}`,
        { cause: error },
      );
    }
  }

  private async pinnedDeveloperDir(source: string): Promise<string | undefined> {
    const script = join(dirname(dirname(dirname(source))), IOS_XCODE_PIN_SCRIPT);
    if (!(await this.isFile(script))) {
      return undefined;
    }
    try {
      // Unset, so the pin is chosen rather than echoed back.
      const env = { ...this.env };
      delete env.DEVELOPER_DIR;
      const result = await this.runner.executeCommand(
        "bash",
        [
          "-c",
          'source "$1" && select_pinned_xcode 2>/dev/null; printf %s "${DEVELOPER_DIR:-}"',
          "xcode-pin",
          script,
        ],
        { env },
      );
      return result.stdout.trim() || undefined;
    } catch (error) {
      // The active Xcode still builds a working shaper; the cache key records which one.
      logger.warn(`[NetworkShaper] Xcode pin lookup failed; using the active Xcode`, error);
      return undefined;
    }
  }

  private async build(
    { source, stub }: { source: string; stub: string },
    toolchain: ShaperToolchain,
    directory: string,
    output: string,
  ): Promise<string> {
    if (await this.isFile(output)) {
      return output;
    }
    await this.fs.ensureDir(directory);
    const partial = `${output}.${(this.deps.idGenerator ?? defaultIdGenerator).next()}.tmp`;
    try {
      await this.runBuildCommand(toolchain, "xcrun", [
        "--sdk",
        "iphonesimulator",
        "clang",
        ...IOS_NETWORK_SHAPER_ARCHS.flatMap((arch) => ["-arch", arch]),
        "-O2",
        "-dynamiclib",
        "-framework",
        "Network",
        "-framework",
        "SystemConfiguration",
        "-mios-simulator-version-min=15.0",
        stub,
        source,
        "-o",
        partial,
      ]);
      await this.runBuildCommand(toolchain, "codesign", ["-f", "-s", "-", partial]);
      await this.fs.rename(partial, output);
      return output;
    } finally {
      if (this.fs.existsSync(partial)) {
        try {
          await this.fs.unlink(partial);
        } catch (error) {
          // An abandoned partial is never used as a cache entry.
          logger.warn("Failed to remove network shaper build partial", error);
        }
      }
    }
  }

  private async runBuildCommand(
    toolchain: ShaperToolchain,
    command: string,
    args: string[],
  ): Promise<void> {
    try {
      await this.runner.executeCommand(
        command,
        args,
        toolchain.env ? { env: toolchain.env } : undefined,
      );
    } catch (error) {
      throw new ActionableError(
        `iOS network shaper compile/sign failed. ${XCODE_HINT}. ${formatCommandError(error, { command, args })}`,
        { cause: error },
      );
    }
  }
}
