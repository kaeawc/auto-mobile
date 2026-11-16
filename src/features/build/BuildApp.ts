import { stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { sortedReaddir } from "../../utils/io";
import { logger } from "../../utils/logger";

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
  readonly executor: HostCommandExecutor;
  readonly fs: BuildFileSystem;
  readonly hostPlatform: NodeJS.Platform;
}

export const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;
const BUILD_MAX_BUFFER = 256 * 1024 * 1024;
const EXCERPT_MAX_LINES = 40;
const EXCERPT_MAX_LINE_CHARS = 500;
const APK_SEARCH_DEPTH = 3;

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

interface PlannedBuild {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly findArtifacts: () => Promise<string[]>;
  readonly artifactDescription: string;
}

export class BuildApp {
  constructor(
    private readonly dependencies: BuildAppDependencies = {
      executor: new DefaultHostCommandExecutor(),
      fs: nodeBuildFileSystem,
      hostPlatform: process.platform,
    },
  ) {}

  async build(request: BuildAppRequest, signal?: AbortSignal): Promise<BuildAppResult> {
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
    const artifactPaths = await plan.findArtifacts();
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
      await this.dependencies.executor.executeCommand(plan.file, plan.args, {
        cwd: plan.cwd,
        signal,
        timeoutMs: request.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
        maxBuffer: BUILD_MAX_BUFFER,
      });
      return null;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`buildApp ${plan.file} failed: ${errorMessage(error)}`);
      return this.describeFailure(plan, error);
    }
  }

  private describeFailure(
    plan: PlannedBuild,
    error: unknown,
  ): { success: false; errorCode: BuildAppErrorCode; error: string; logExcerpt?: string } {
    const raw = rawFailure(error);
    if (raw.code === "ENOENT") {
      return {
        success: false,
        errorCode: "build_tool_not_found",
        error: `${plan.file} was not found on this host.`,
      };
    }
    const logExcerpt = buildLogExcerpt(`${text(raw.stdout)}\n${text(raw.stderr)}`);
    if (raw.killed === true && typeof raw.code !== "number") {
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
    const productsDir = join(derivedDataPath, "Build", "Products", `${configuration}-${sdk}`);
    return {
      file: "xcodebuild",
      args: [
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
        "build",
      ],
      cwd: dirname(project),
      findArtifacts: async () =>
        await this.newestFirst(await this.childrenEndingWith(productsDir, ".app")),
      artifactDescription: `.app under ${productsDir}`,
    };
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
      file: gradlew,
      args: [`:${module}:assemble${capitalize(variant)}`, "--console=plain"],
      cwd: request.projectPath,
      findArtifacts: async () => await this.newestFirst(await this.variantApks(apkRoot, variant)),
      artifactDescription: `${variant} .apk under ${apkRoot}`,
    };
  }

  private async childrenEndingWith(dir: string, suffix: string): Promise<string[]> {
    if (!(await this.dependencies.fs.stat(dir))) {
      return [];
    }
    const entries = await this.dependencies.fs.readdir(dir);
    return entries.filter((entry) => entry.endsWith(suffix)).map((entry) => join(dir, entry));
  }

  /** APKs whose directory under `outputs/apk` spells the variant, e.g. free/debug for freeDebug. */
  private async variantApks(apkRoot: string, variant: string): Promise<string[]> {
    const apks = await this.walkFiles(apkRoot, ".apk", APK_SEARCH_DEPTH);
    const wanted = variant.toLowerCase();
    return apks.filter(
      (apk) => relative(apkRoot, dirname(apk)).split(sep).join("").toLowerCase() === wanted,
    );
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
