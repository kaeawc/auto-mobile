import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMBIENT_ENV, readEnvTrimmed } from "../../../config/env";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { SimHidCompileError } from "./SimHidCompileError";
import { SingleFlight } from "../../cache/SingleFlight";
import { commandFailureDetails, formatCommandError } from "../../CommandError";
import { DefaultFileSystem, type FileSystem } from "../../filesystem/DefaultFileSystem";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../../HostCommandExecutor";
import { defaultIdGenerator, type IdGenerator } from "../../IdGenerator";
import { logger } from "../../logger";
import { getTempDir } from "../../tempDir";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../workingDirectory";

/** A built helper and the environment (DEVELOPER_DIR) it must run with. */
export interface SimHidHelperBuild {
  path: string;
  env: NodeJS.ProcessEnv;
}

/** Compiles (once per source and toolchain) the SimulatorKit HID helper (#19118). */
export interface SimHidHelperProvider {
  ensure(): Promise<SimHidHelperBuild>;
}

/**
 * Shipped in the npm package (package.json `files`) and present in a repo checkout. The daemon
 * compiles them as one module; `swift build` in ios/sim-hid builds the same files as a package.
 */
export const SIM_HID_SOURCES: readonly string[] = [
  "ios/sim-hid/Sources/SimHidCore/SimHidCommand.swift",
  "ios/sim-hid/Sources/SimHidCore/SimHidKeyboard.swift",
  "ios/sim-hid/Sources/SimHidCore/SimHidPlanner.swift",
  "ios/sim-hid/Sources/SimHidCore/SimHidServer.swift",
  "ios/sim-hid/Sources/SimHidHelper/SimulatorKitHIDBackend.swift",
  "ios/sim-hid/Sources/SimHidHelper/main.swift",
];
export const SIM_HID_HELPER_NAME = "sim-hid-helper";
const XCODE_HINT = "Install Xcode and run xcode-select --install";

type HelperFileSystem = Pick<
  FileSystem,
  "existsSync" | "readFileBuffer" | "ensureDir" | "rename" | "unlink"
>;

export interface SimHidHelperProviderDependencies {
  fileSystem?: HelperFileSystem;
  runner?: HostCommandExecutor;
  idGenerator?: IdGenerator;
  env?: NodeJS.ProcessEnv;
  directory?: () => string;
  /** Candidate roots holding `ios/sim-hid/`; defaults to the module's ancestors and the launch dir. */
  rootCandidates?: string[];
}

function ancestorRoots(moduleDirectory: string): string[] {
  const roots: string[] = [];
  let directory = moduleDirectory;
  while (true) {
    roots.push(directory);
    const parent = dirname(directory);
    if (parent === directory) {
      return roots;
    }
    directory = parent;
  }
}

/** Source-addressed, atomic helper builds; no compiler runs until a simulator needs raw input. */
export class DefaultSimHidHelperProvider implements SimHidHelperProvider {
  private readonly fs: HelperFileSystem;
  private readonly runner: HostCommandExecutor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly flights = new SingleFlight<string, SimHidHelperBuild>();

  constructor(private readonly deps: SimHidHelperProviderDependencies = {}) {
    this.fs = deps.fileSystem ?? new DefaultFileSystem();
    this.runner = deps.runner ?? new DefaultHostCommandExecutor();
    this.env = deps.env ?? process.env;
  }

  async ensure(): Promise<SimHidHelperBuild> {
    try {
      const sources = this.findSources();
      const env = await this.toolchainEnv();
      const swiftc = await this.run(env, "xcrun", ["--find", "swiftc"]);
      const hash = createHash("sha256").update(swiftc.trim());
      for (const source of sources) {
        hash.update(await this.fs.readFileBuffer(source));
      }
      const directory = join(
        (this.deps.directory ?? (() => getTempDir("ios-sim-hid")))(),
        hash.digest("hex").slice(0, 12),
      );
      const output = join(directory, SIM_HID_HELPER_NAME);
      return await this.flights.run(output, () => this.build(sources, env, directory, output));
    } catch (error) {
      throw toActionableError(error, "Unable to prepare the iOS Simulator HID helper");
    }
  }

  private findSources(): string[] {
    const roots = this.deps.rootCandidates ?? [
      ...ancestorRoots(dirname(fileURLToPath(import.meta.url))),
      resolvePathFromDaemonLaunchWorkingDirectory(".", this.env),
    ];
    for (const root of roots) {
      const sources = SIM_HID_SOURCES.map((source) => join(root, source));
      if (sources.every((source) => this.fs.existsSync(source))) {
        return sources;
      }
    }
    throw new ActionableError(
      "iOS Simulator HID helper sources (ios/sim-hid/Sources) were not found beside the installed package or in a repo checkout. Reinstall the package.",
    );
  }

  /** The caller's DEVELOPER_DIR, else the active Xcode, pinned so build and run use one Xcode. */
  private async toolchainEnv(): Promise<NodeJS.ProcessEnv> {
    const configured = readEnvTrimmed(AMBIENT_ENV.DEVELOPER_DIR, this.env);
    if (configured) {
      return { ...this.env, DEVELOPER_DIR: configured };
    }
    const active = (await this.run(this.env, "xcode-select", ["-p"])).trim();
    if (!active) {
      throw new ActionableError(`xcode-select -p printed no Xcode path. ${XCODE_HINT}.`);
    }
    return { ...this.env, DEVELOPER_DIR: active };
  }

  private async build(
    sources: string[],
    env: NodeJS.ProcessEnv,
    directory: string,
    output: string,
  ): Promise<SimHidHelperBuild> {
    if (this.fs.existsSync(output)) {
      return { path: output, env };
    }
    await this.fs.ensureDir(directory);
    const partial = `${output}.${(this.deps.idGenerator ?? defaultIdGenerator).next()}.tmp`;
    try {
      await this.run(
        env,
        "xcrun",
        [
          "swiftc",
          "-O",
          "-swift-version",
          "6",
          "-module-name",
          "SimHidHelper",
          ...sources,
          "-o",
          partial,
        ],
        true,
      );
      await this.run(env, "codesign", ["-f", "-s", "-", partial]);
      await this.fs.rename(partial, output);
      return { path: output, env };
    } finally {
      if (this.fs.existsSync(partial)) {
        try {
          await this.fs.unlink(partial);
        } catch (error) {
          // An abandoned partial is never used as a cache entry.
          logger.warn("Failed to remove a sim-hid-helper build partial", error);
        }
      }
    }
  }

  private async run(
    env: NodeJS.ProcessEnv,
    command: string,
    args: string[],
    compile = false,
  ): Promise<string> {
    try {
      return (await this.runner.executeCommand(command, args, { env })).stdout;
    } catch (error) {
      const { exitCode, stderr } = commandFailureDetails(error);
      const compileFailed = compile && exitCode !== undefined && exitCode !== 0 && stderr.trim();
      throw new (compileFailed ? SimHidCompileError : ActionableError)(
        `iOS Simulator HID helper build step failed. ${XCODE_HINT}. ${formatCommandError(error, { command, args })}`,
        { cause: error },
      );
    }
  }
}
