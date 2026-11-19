import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { sortedReaddir } from "../../utils/io";
import { logger } from "../../utils/logger";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { windowsBatchInvocation } from "../../utils/android-cmdline-tools/SdkManagerClient";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { DEFAULT_BUILD_TIMEOUT_MS } from "./buildAppTimeout";

export const BUILD_PLATFORMS = ["ios", "tvos", "watchos", "visionos", "android"] as const;
export type BuildPlatform = (typeof BUILD_PLATFORMS)[number];
type ApplePlatform = Exclude<BuildPlatform, "android">;

export const BUILD_APP_ERROR_CODES = [
  "invalid_request",
  "unsupported_host",
  "project_not_found",
  "build_tool_not_found",
  "build_failed",
  "build_timed_out",
  "artifact_not_found",
] as const;
export type BuildAppErrorCode = (typeof BUILD_APP_ERROR_CODES)[number];

export interface BuildAppRequest {
  readonly platform: BuildPlatform;
  /** Apple: a .xcodeproj, a .xcworkspace, or a directory holding one. Android: the Gradle root. */
  readonly projectPath: string;
  readonly scheme?: string;
  readonly configuration?: string;
  readonly derivedDataPath?: string;
  /** Apple: build for this simulator UDID instead of the generic simulator destination. */
  readonly simulatorUdid?: string;
  readonly module?: string;
  readonly variant?: string;
  readonly timeoutMs?: number;
}

export type BuildAppResult =
  | {
      readonly success: true;
      readonly platform: BuildPlatform;
      readonly artifactPath: string;
      readonly artifactPaths: string[];
      readonly command: string[];
    }
  | {
      readonly success: false;
      readonly platform: BuildPlatform;
      readonly errorCode: BuildAppErrorCode;
      readonly error: string;
      readonly command?: string[];
      readonly logExcerpt?: string;
    };

export interface BuildPathInfo {
  readonly isDirectory: boolean;
  readonly mtimeMs: number;
}

/** The file system slice the build needs: entry metadata and directory listings. */
export interface BuildFileSystem {
  /** `null` when the path does not exist. */
  stat(path: string): Promise<BuildPathInfo | null>;
  readdir(path: string): Promise<string[]>;
}

export interface BuildAppDependencies {
  /** Runs the Gradle wrapper. */
  readonly executor: HostCommandExecutor;
  /** Runs xcodebuild; production code reaches xcodebuild only through XcodebuildClient. */
  readonly xcodebuild: Pick<Xcodebuild, "executeCommand">;
  readonly fs: BuildFileSystem;
  readonly hostPlatform: NodeJS.Platform;
  /** Resolves a caller-relative path to an absolute one; defaults to the daemon launch directory. */
  readonly resolvePath?: (path: string) => string;
}

const BUILD_MAX_BUFFER = 256 * 1024 * 1024;
const EXCERPT_MAX_LINES = 40;
const EXCERPT_MAX_LINE_CHARS = 500;
const APK_SEARCH_DEPTH = 3;
const BUILD_SETTINGS_TIMEOUT_MS = 120_000;
const GRADLE_PROPERTIES_TIMEOUT_MS = 120_000;

const APPLE_SDK: Record<ApplePlatform, { sdk: string; destination: string }> = {
  ios: { sdk: "iphonesimulator", destination: "iOS Simulator" },
  tvos: { sdk: "appletvsimulator", destination: "tvOS Simulator" },
  watchos: { sdk: "watchsimulator", destination: "watchOS Simulator" },
  visionos: { sdk: "xrsimulator", destination: "visionOS Simulator" },
};

const FAILURE_LINE =
  /(\berror\b:|^e: |\*\* BUILD FAILED \*\*|What went wrong|^FAILURE:|^BUILD FAILED|^> )/i;

interface Refusal {
  readonly refused: BuildAppErrorCode;
  readonly message: string;
}

const refuse = (refused: BuildAppErrorCode, message: string): Refusal => ({ refused, message });
const isRefusal = (value: object): value is Refusal => "refused" in value;

/** Node-backed {@link BuildFileSystem}. */
export const nodeBuildFileSystem: BuildFileSystem = {
  async stat(path) {
    try {
      const info = await stat(path);
      return { isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw toActionableError(error, `buildApp could not read ${path}`);
      }
      // A missing path is an answer here, not a failure: callers branch on null.
      logger.debug(`buildApp stat ${path} failed: ${errorMessage(error)}`);
      return null;
    }
  },
  readdir: async (path) => await sortedReaddir(path),
};

/** Error-pattern lines from a build log, or its tail when none match. */
export function buildLogExcerpt(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const matched = [...new Set(lines.filter((line) => FAILURE_LINE.test(line.trim())))];
  const chosen = matched.length > 0 ? matched : lines.slice(-EXCERPT_MAX_LINES);
  return chosen
    .slice(0, EXCERPT_MAX_LINES)
    .map((line) =>
      line.length > EXCERPT_MAX_LINE_CHARS ? line.slice(0, EXCERPT_MAX_LINE_CHARS) : line,
    )
    .join("\n");
}

interface RawExecFailure {
  code?: unknown;
  killed?: boolean;
  signal?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

function rawFailure(error: unknown): RawExecFailure {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return typeof cause === "object" && cause !== null ? (cause as RawExecFailure) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : "";
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** XcodebuildClient refuses with this ActionableError when Xcode is not installed. */
function isXcodebuildUnavailable(error: unknown): boolean {
  return error instanceof ActionableError && error.message.includes("xcodebuild is not available");
}

/** XcodebuildClient's own timeout error, raised after it aborts the command. */
function isClientTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Command timed out after");
}

interface BuildSettingsEntry {
  readonly buildSettings?: {
    readonly TARGET_BUILD_DIR?: unknown;
    readonly FULL_PRODUCT_NAME?: unknown;
  };
}

/** `.app` product paths from `xcodebuild -showBuildSettings -json` output; [] when unparsable. */
export function appProductPaths(settingsJson: string): string[] {
  let entries: unknown;
  try {
    entries = JSON.parse(settingsJson);
  } catch (error) {
    logger.warn(`buildApp build settings are not JSON: ${errorMessage(error)}`);
    return [];
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  const paths = (entries as BuildSettingsEntry[]).flatMap((entry) => {
    const dir = entry?.buildSettings?.TARGET_BUILD_DIR;
    const name = entry?.buildSettings?.FULL_PRODUCT_NAME;
    return typeof dir === "string" && typeof name === "string" && name.endsWith(".app")
      ? [join(dir, name)]
      : [];
  });
  return [...new Set(paths)];
}

/**
 * The module's build directory from `gradlew :<module>:properties` output: its `buildDir`, or
 * `<projectDir>/build` when the report has no `buildDir` line. `undefined` when neither is an
 * absolute path.
 */
export function gradleBuildDirectory(report: string): string | undefined {
  const values = new Map(
    report.split(/\r?\n/).flatMap((line) => {
      const match = /^(buildDir|projectDir): (.+)$/.exec(line.trim());
      return match ? [[match[1], match[2].trim()] as const] : [];
    }),
  );
  const buildDir = values.get("buildDir");
  if (buildDir !== undefined && isAbsolute(buildDir)) {
    return buildDir;
  }
  const projectDir = values.get("projectDir");
  return projectDir !== undefined && isAbsolute(projectDir) ? join(projectDir, "build") : undefined;
}

interface PlannedBuild {
  readonly tool: "xcodebuild" | "gradle";
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly findArtifacts: (signal?: AbortSignal) => Promise<string[]>;
  readonly artifactDescription: string;
}

export class BuildApp {
  constructor(
    private readonly dependencies: BuildAppDependencies = {
      executor: new DefaultHostCommandExecutor(),
      xcodebuild: new XcodebuildClient(),
      fs: nodeBuildFileSystem,
      hostPlatform: process.platform,
    },
  ) {}

  async build(raw: BuildAppRequest, signal?: AbortSignal): Promise<BuildAppResult> {
    const request = this.absolutePaths(raw);
    const plan =
      request.platform === "android"
        ? await this.planAndroid(request)
        : await this.planApple(request, request.platform);
    if (isRefusal(plan)) {
      return {
        success: false,
        platform: request.platform,
        errorCode: plan.refused,
        error: plan.message,
      };
    }
    const command = [plan.file, ...plan.args];
    const failure = await this.run(plan, request, signal);
    if (failure) {
      return { ...failure, platform: request.platform, command };
    }
    const artifactPaths = await plan.findArtifacts(signal);
    if (artifactPaths.length === 0) {
      return {
        success: false,
        platform: request.platform,
        errorCode: "artifact_not_found",
        error: `The build succeeded but no ${plan.artifactDescription} was found.`,
        command,
      };
    }
    return {
      success: true,
      platform: request.platform,
      artifactPath: artifactPaths[0],
      artifactPaths,
      command,
    };
  }

  private absolutePaths(request: BuildAppRequest): BuildAppRequest {
    const resolve = this.dependencies.resolvePath ?? resolvePathFromDaemonLaunchWorkingDirectory;
    return {
      ...request,
      projectPath: resolve(request.projectPath),
      ...(request.derivedDataPath ? { derivedDataPath: resolve(request.derivedDataPath) } : {}),
    };
  }

  private async run(
    plan: PlannedBuild,
    request: BuildAppRequest,
    signal?: AbortSignal,
  ): Promise<{
    success: false;
    errorCode: BuildAppErrorCode;
    error: string;
    logExcerpt?: string;
  } | null> {
    try {
      const options = {
        signal,
        timeoutMs: request.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
        maxBuffer: BUILD_MAX_BUFFER,
      };
      await (plan.tool === "xcodebuild"
        ? this.dependencies.xcodebuild.executeCommand(plan.args, options)
        : this.runGradle(plan, options));
      return null;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`buildApp ${plan.file} failed: ${errorMessage(error)}`);
      return this.describeFailure(plan, error);
    }
  }

  /** Node cannot execFile a .bat, so gradlew.bat runs through the command processor. */
  private async runGradle(
    plan: PlannedBuild,
    options: { signal?: AbortSignal; timeoutMs: number; maxBuffer: number },
  ): Promise<unknown> {
    const invocation = windowsBatchInvocation(plan.file, plan.args);
    return await this.dependencies.executor.executeCommand(invocation.command, invocation.args, {
      ...options,
      cwd: plan.cwd,
    });
  }

  private describeFailure(
    plan: PlannedBuild,
    error: unknown,
  ): { success: false; errorCode: BuildAppErrorCode; error: string; logExcerpt?: string } {
    const raw = rawFailure(error);
    if (raw.code === "ENOENT" || isXcodebuildUnavailable(error)) {
      return {
        success: false,
        errorCode: "build_tool_not_found",
        error: `${plan.file} was not found on this host.`,
      };
    }
    const logExcerpt = buildLogExcerpt(`${text(raw.stdout)}\n${text(raw.stderr)}`);
    if ((raw.killed === true && typeof raw.code !== "number") || isClientTimeout(error)) {
      return {
        success: false,
        errorCode: "build_timed_out",
        error: `${basename(plan.file)} did not finish before the build timeout and was stopped.`,
        ...(logExcerpt ? { logExcerpt } : {}),
      };
    }
    const exit = typeof raw.code === "number" ? ` with exit code ${raw.code}` : "";
    return {
      success: false,
      errorCode: "build_failed",
      error: `${basename(plan.file)} failed${exit}; see logExcerpt.`,
      ...(logExcerpt ? { logExcerpt } : {}),
    };
  }

  private async planApple(
    request: BuildAppRequest,
    platform: ApplePlatform,
  ): Promise<PlannedBuild | Refusal> {
    if (this.dependencies.hostPlatform !== "darwin") {
      return refuse("unsupported_host", `Building for ${platform} needs Xcode on macOS.`);
    }
    if (!request.scheme) {
      return refuse("invalid_request", `scheme is required to build for ${platform}.`);
    }
    const project = await this.resolveXcodeProject(request.projectPath);
    if (typeof project !== "string") {
      return project;
    }
    const configuration = request.configuration ?? "Debug";
    const { sdk, destination } = APPLE_SDK[platform];
    const derivedDataPath =
      request.derivedDataPath ?? join(dirname(project), "build", "AutoMobileDerivedData");
    const buildArgs = [
      project.endsWith(".xcworkspace") ? "-workspace" : "-project",
      project,
      "-scheme",
      request.scheme,
      "-configuration",
      configuration,
      "-sdk",
      sdk,
      "-destination",
      request.simulatorUdid
        ? `platform=${destination},id=${request.simulatorUdid}`
        : `generic/platform=${destination}`,
      "-derivedDataPath",
      derivedDataPath,
      "CODE_SIGNING_ALLOWED=NO",
    ];
    return {
      tool: "xcodebuild",
      file: "xcodebuild",
      args: [...buildArgs, "build"],
      cwd: dirname(project),
      findArtifacts: async (signal) =>
        await this.schemeApps([...buildArgs, "-showBuildSettings", "-json"], signal),
      artifactDescription: `.app product for scheme ${request.scheme} in its build settings`,
    };
  }

  /** The scheme's own .app products, read from `xcodebuild -showBuildSettings -json`. */
  private async schemeApps(args: string[], signal?: AbortSignal): Promise<string[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.dependencies.xcodebuild.executeCommand(args, {
        signal,
        timeoutMs: BUILD_SETTINGS_TIMEOUT_MS,
        maxBuffer: BUILD_MAX_BUFFER,
      }));
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`buildApp could not read build settings: ${errorMessage(error)}`);
      return [];
    }
    const apps = appProductPaths(stdout);
    const present = await Promise.all(
      apps.map(async (path) => ((await this.dependencies.fs.stat(path)) ? path : null)),
    );
    return present.filter((path): path is string => path !== null);
  }

  private async resolveXcodeProject(projectPath: string): Promise<string | Refusal> {
    const info = await this.dependencies.fs.stat(projectPath);
    if (!info) {
      return refuse("project_not_found", `${projectPath} does not exist.`);
    }
    if (projectPath.endsWith(".xcodeproj") || projectPath.endsWith(".xcworkspace")) {
      return projectPath;
    }
    if (!info.isDirectory) {
      return refuse(
        "invalid_request",
        `${projectPath} is not a .xcodeproj, a .xcworkspace, or a directory holding one.`,
      );
    }
    const entries = await this.dependencies.fs.readdir(projectPath);
    const workspaces = entries.filter((entry) => entry.endsWith(".xcworkspace"));
    const projects = entries.filter((entry) => entry.endsWith(".xcodeproj"));
    const candidates = workspaces.length > 0 ? workspaces : projects;
    if (candidates.length !== 1) {
      return refuse(
        candidates.length === 0 ? "project_not_found" : "invalid_request",
        candidates.length === 0
          ? `No .xcworkspace or .xcodeproj in ${projectPath}.`
          : `${projectPath} holds ${candidates.join(", ")}; pass one as projectPath.`,
      );
    }
    return join(projectPath, candidates[0]);
  }

  private async planAndroid(request: BuildAppRequest): Promise<PlannedBuild | Refusal> {
    const wrapper = this.dependencies.hostPlatform === "win32" ? "gradlew.bat" : "gradlew";
    const gradlew = join(request.projectPath, wrapper);
    if (!(await this.dependencies.fs.stat(gradlew))) {
      return refuse(
        "project_not_found",
        `${gradlew} does not exist; projectPath must be the Gradle root that holds the wrapper.`,
      );
    }
    const module = (request.module ?? "app").replace(/^:/, "");
    const variant = request.variant ?? "debug";
    const apkRoot = join(request.projectPath, ...module.split(":"), "build", "outputs", "apk");
    return {
      tool: "gradle",
      file: gradlew,
      args: [`:${module}:assemble${capitalize(variant)}`, "--console=plain"],
      cwd: request.projectPath,
      findArtifacts: async (signal) => {
        const apks = await this.variantApks(apkRoot, variant);
        if (apks.length > 0) {
          return await this.newestFirst(apks);
        }
        // A settings-relocated projectDir builds elsewhere; ask Gradle where.
        const reported = await this.reportedApkRoot(gradlew, request.projectPath, module, signal);
        return reported === undefined || reported === apkRoot
          ? []
          : await this.newestFirst(await this.variantApks(reported, variant));
      },
      artifactDescription: `signed ${variant} .apk under ${apkRoot} or the module's Gradle build directory (an *-unsigned.apk needs a signingConfig for that build type before installApp can install it)`,
    };
  }

  /** The module's `outputs/apk` under the build directory Gradle's `properties` report names. */
  private async reportedApkRoot(
    gradlew: string,
    projectPath: string,
    module: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const invocation = windowsBatchInvocation(gradlew, [
      `:${module}:properties`,
      "--console=plain",
      "-q",
    ]);
    let stdout: string;
    try {
      ({ stdout } = await this.dependencies.executor.executeCommand(
        invocation.command,
        invocation.args,
        {
          cwd: projectPath,
          signal,
          timeoutMs: GRADLE_PROPERTIES_TIMEOUT_MS,
          maxBuffer: BUILD_MAX_BUFFER,
        },
      ));
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`buildApp could not read :${module} Gradle properties: ${errorMessage(error)}`);
      return undefined;
    }
    const buildDir = gradleBuildDirectory(stdout);
    return buildDir === undefined ? undefined : join(buildDir, "outputs", "apk");
  }

  /**
   * Signed APKs for the variant under `outputs/apk`. The directory spells the variant
   * (free/debug for freeDebug); a bare build type such as debug also matches every
   * flavor's output, since assembleDebug builds them all.
   */
  private async variantApks(apkRoot: string, variant: string): Promise<string[]> {
    const apks = await this.walkFiles(apkRoot, ".apk", APK_SEARCH_DEPTH);
    const wanted = variant.toLowerCase();
    return apks.filter((apk) => {
      const dirs = relative(apkRoot, dirname(apk)).split(sep);
      const matches =
        dirs.join("").toLowerCase() === wanted || dirs.at(-1)?.toLowerCase() === wanted;
      return matches && !basename(apk).endsWith("-unsigned.apk");
    });
  }

  private async walkFiles(dir: string, suffix: string, depth: number): Promise<string[]> {
    const info = await this.dependencies.fs.stat(dir);
    if (!info?.isDirectory || depth < 0) {
      return [];
    }
    const entries = await this.dependencies.fs.readdir(dir);
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry);
        return entry.endsWith(suffix) ? [path] : await this.walkFiles(path, suffix, depth - 1);
      }),
    );
    return nested.flat();
  }

  private async newestFirst(paths: string[]): Promise<string[]> {
    const stamped = await Promise.all(
      paths.map(async (path) => ({
        path,
        mtimeMs: (await this.dependencies.fs.stat(path))?.mtimeMs ?? 0,
      })),
    );
    return stamped.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path);
  }
}
