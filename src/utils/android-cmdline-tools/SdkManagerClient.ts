import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";
import { redactAndroidCommandOutput } from "./redactAndroidCommandOutput";
import {
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  getCmdlineToolsRoot,
  isHomebrewToolsPath,
  validateRequiredTools,
  type AndroidToolsLocation,
} from "./detection";

const SDK_ROOT_MARKERS = ["system-images", "platforms", "platform-tools", "build-tools"];
const DEFAULT_MAX_OUTPUT_CHARS = 16_384;
const UNBOUNDED_STDOUT_CHARS = Number.MAX_SAFE_INTEGER;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const LOCAL_COMMAND_TIMEOUT_MS = 60_000;
// `--list` downloads repository manifests from dl.google.com on a cold cache, so it needs a
// network-sized budget rather than the local-command one.
const CATALOGUE_FETCH_TIMEOUT_MS = 300_000;
const PACKAGE_INSTALL_TIMEOUT_MS = 600_000;

export interface SdkManagerExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxOutputChars?: number;
  /** Use a previously selected command-line-tools installation. */
  location?: AndroidToolsLocation;
}

export interface SdkManagerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outputTruncated: boolean;
}

export interface SdkManagerClientDependencies {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  existsSync: typeof existsSync;
  logger: Pick<typeof logger, "info" | "warn" | "error">;
  detectAndroidCommandLineTools: typeof detectAndroidCommandLineTools;
  getAndroidHomeWithSystemImages: typeof getAndroidHomeWithSystemImages;
  getBestAndroidToolsLocation: typeof getBestAndroidToolsLocation;
  validateRequiredTools: typeof validateRequiredTools;
  timer: Timer;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function defaults(): SdkManagerClientDependencies {
  return {
    spawn,
    existsSync,
    logger,
    detectAndroidCommandLineTools,
    getAndroidHomeWithSystemImages,
    getBestAndroidToolsLocation,
    validateRequiredTools,
    timer: defaultTimer,
    environment: process.env,
    platform: process.platform,
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function appendBounded(
  current: string,
  next: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const available = maximum - current.length;
  if (available <= 0) {
    return { value: current, truncated: next.length > 0 };
  }
  if (next.length <= available) {
    return { value: current + next, truncated: false };
  }
  return { value: current + next.slice(0, available), truncated: true };
}

function quoteForWindowsCmd(value: string): string {
  if (/[\r\n"]/.test(value)) {
    throw new Error("sdkmanager arguments cannot contain Windows command-line quotes or newlines");
  }
  return `"${value.replace(/%/g, "%%")}"`;
}

export class SdkManagerClient {
  private static readonly homebrewWarningLoggers = new WeakSet<object>();

  constructor(private readonly dependencies: SdkManagerClientDependencies = defaults()) {}

  async list(options: SdkManagerExecutionOptions = {}): Promise<SdkManagerCommandResult> {
    return this.run(
      ["--list"],
      {
        timeoutMs: CATALOGUE_FETCH_TIMEOUT_MS,
        maxStdoutChars: UNBOUNDED_STDOUT_CHARS,
      },
      options,
    );
  }

  /** Return the installed sdkmanager command-line tools version. */
  async getVersion(options: SdkManagerExecutionOptions = {}): Promise<SdkManagerCommandResult> {
    return this.run(
      ["--version"],
      {
        timeoutMs: LOCAL_COMMAND_TIMEOUT_MS,
        maxStdoutChars: 1_024,
      },
      options,
      true,
    );
  }

  async acceptLicenses(options: SdkManagerExecutionOptions = {}): Promise<SdkManagerCommandResult> {
    return this.run(
      ["--licenses"],
      { input: "y\n".repeat(20), timeoutMs: LOCAL_COMMAND_TIMEOUT_MS },
      options,
    );
  }

  async installPackage(
    packageName: string,
    options: SdkManagerExecutionOptions & { acceptLicenses?: boolean } = {},
  ): Promise<SdkManagerCommandResult> {
    return this.run(
      [packageName],
      {
        input: options.acceptLicenses ? "y\n".repeat(10) : undefined,
        timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
      },
      options,
    );
  }

  private async run(
    args: string[],
    defaultsForCommand: { input?: string; timeoutMs: number; maxStdoutChars?: number },
    options: SdkManagerExecutionOptions,
    allowBootstrapRoot = false,
  ): Promise<SdkManagerCommandResult> {
    const { path, env } = await this.resolve(allowBootstrapRoot, options.location);
    return this.execute(path, args, { ...defaultsForCommand, env }, options);
  }

  private async resolve(
    allowBootstrapRoot = false,
    selectedLocation?: AndroidToolsLocation,
  ): Promise<{ path: string; env: NodeJS.ProcessEnv }> {
    const locations = selectedLocation
      ? [selectedLocation]
      : await this.dependencies.detectAndroidCommandLineTools();
    const location = selectedLocation ?? this.dependencies.getBestAndroidToolsLocation(locations);
    if (!location) {
      throw new Error(
        "Android command line tools not found. Tool installation functionality has been removed. Please install Android SDK Command-line Tools and set ANDROID_HOME or ANDROID_SDK_ROOT to the SDK root.",
      );
    }
    const validation = this.dependencies.validateRequiredTools(location, ["sdkmanager"]);
    if (!validation.valid) {
      throw new Error(
        `Missing required tools: ${validation.missing.join(", ")}. Tool installation functionality has been removed. Install Android SDK Command-line Tools under ANDROID_HOME/cmdline-tools/latest.`,
      );
    }
    const path = this.resolveExecutable(location);
    const sdkRoot =
      this.resolveSdkRoot(location) ??
      (allowBootstrapRoot ? this.stripCmdlineToolsPath(location.path) : undefined);
    if (!sdkRoot) {
      throw new Error(
        `Unable to resolve the Android SDK root for sdkmanager at ${path}. Set ANDROID_HOME or ANDROID_SDK_ROOT to the SDK root containing platforms or system-images.`,
      );
    }
    this.warnHomebrewMismatch(location, sdkRoot);
    return {
      path,
      env: { ...this.dependencies.environment, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
    };
  }

  private resolveExecutable(location: AndroidToolsLocation): string {
    const executable = join(location.path, "bin", "sdkmanager");
    if (this.dependencies.existsSync(executable)) {
      return executable;
    }
    const batch = join(location.path, "bin", "sdkmanager.bat");
    if (this.dependencies.existsSync(batch)) {
      return batch;
    }
    throw new Error(
      `SDK manager not found at ${location.path}. Install Android SDK Command-line Tools under ANDROID_HOME/cmdline-tools/latest.`,
    );
  }

  private resolveSdkRoot(location: AndroidToolsLocation): string | undefined {
    const environment = this.dependencies.environment;
    const candidates = [
      environment.ANDROID_SDK_ROOT,
      environment.ANDROID_HOME,
      environment.ANDROID_SDK_HOME,
      this.stripCmdlineToolsPath(location.path),
      location.path,
      resolve(location.path, ".."),
      resolve(location.path, "..", ".."),
      ...this.typicalSdkPaths(),
    ].filter(Boolean) as string[];
    return (
      candidates.find((candidate) =>
        this.dependencies.existsSync(join(candidate, "system-images")),
      ) ?? candidates.find((candidate) => this.looksLikeSdkRoot(candidate))
    );
  }

  private stripCmdlineToolsPath(path: string): string | undefined {
    const normalized = normalizePath(path);
    return normalized.endsWith("/cmdline-tools/latest")
      ? normalized.replace(/\/cmdline-tools\/latest$/, "")
      : undefined;
  }

  private typicalSdkPaths(): string[] {
    const home = this.dependencies.environment.HOME ?? this.dependencies.environment.USERPROFILE;
    if (this.dependencies.platform === "darwin") {
      return [
        ...(home ? [join(home, "Library/Android/sdk")] : []),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
      ];
    }
    if (this.dependencies.platform === "linux") {
      return [
        ...(home ? [join(home, "Android/Sdk")] : []),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
      ];
    }
    if (this.dependencies.platform === "win32") {
      return [
        ...(home ? [join(home, "AppData/Local/Android/Sdk")] : []),
        "C:/Android/Sdk",
        "C:/android-sdk",
      ];
    }
    return [];
  }

  private looksLikeSdkRoot(path: string): boolean {
    return (
      this.dependencies.existsSync(path) &&
      SDK_ROOT_MARKERS.filter((marker) => this.dependencies.existsSync(join(path, marker)))
        .length >= 2
    );
  }

  private warnHomebrewMismatch(location: AndroidToolsLocation, sdkRoot: string): void {
    if (
      !isHomebrewToolsPath(location.path) ||
      SdkManagerClient.homebrewWarningLoggers.has(this.dependencies.logger)
    ) {
      return;
    }
    const info = this.dependencies.getAndroidHomeWithSystemImages();
    if (
      !info ||
      normalizePath(getCmdlineToolsRoot(location.path)) === normalizePath(info.androidHome)
    ) {
      return;
    }
    this.dependencies.logger.warn(
      `Warning: Homebrew Android cmdline-tools detected, but system images are in ANDROID_HOME. sdkmanager location: ${location.path} ANDROID_HOME: ${info.androidHome} Effective SDK root: ${sdkRoot}. Fix: ensure cmdline-tools are present under ANDROID_HOME.`,
    );
    SdkManagerClient.homebrewWarningLoggers.add(this.dependencies.logger);
  }

  private execute(
    path: string,
    args: string[],
    inputOptions: {
      input?: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxStdoutChars?: number;
    },
    options: SdkManagerExecutionOptions,
  ): Promise<SdkManagerCommandResult> {
    const maxStdoutChars =
      options.maxOutputChars ?? inputOptions.maxStdoutChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const maxStderrChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const timeoutMs = options.timeoutMs ?? inputOptions.timeoutMs;
    const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    return new Promise((resolvePromise, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("sdkmanager command cancelled"));
        return;
      }
      const invocation = this.windowsBatchInvocation(path, args, inputOptions.env);
      const child = this.dependencies.spawn(invocation.command, invocation.args, {
        env: inputOptions.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      let settled = false;
      let terminationError: Error | undefined;
      let terminationTimeout: NodeJS.Timeout | undefined;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        this.dependencies.timer.clearTimeout(timeout);
        if (terminationTimeout) {
          this.dependencies.timer.clearTimeout(terminationTimeout);
        }
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const terminate = (error: Error) => {
        if (terminationError) {
          return;
        }
        terminationError = error;
        child.kill("SIGTERM");
        terminationTimeout = this.dependencies.timer.setTimeout(
          () =>
            settle(() => {
              child.kill("SIGKILL");
              reject(error);
            }),
          terminationGraceMs,
        );
      };
      const onAbort = () => terminate(new Error("sdkmanager command cancelled"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = this.dependencies.timer.setTimeout(() => {
        terminate(new Error(`sdkmanager command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.dependencies.logger.info(`Executing: ${path} ${args.join(" ")}`);
      child.stdout?.on("data", (data) => {
        const appended = appendBounded(stdout, data.toString(), maxStdoutChars);
        stdout = appended.value;
        outputTruncated ||= appended.truncated;
      });
      child.stderr?.on("data", (data) => {
        const appended = appendBounded(stderr, data.toString(), maxStderrChars);
        stderr = appended.value;
        outputTruncated ||= appended.truncated;
      });
      child.on("close", (code) =>
        settle(() => {
          if (terminationError) {
            reject(terminationError);
            return;
          }
          const childHome = inputOptions.env.HOME ?? inputOptions.env.USERPROFILE;
          resolvePromise({
            stdout: redactAndroidCommandOutput(stdout, childHome),
            stderr: redactAndroidCommandOutput(stderr, childHome),
            exitCode: code,
            outputTruncated,
          });
        }),
      );
      child.on("error", (error) =>
        settle(() => reject(new Error(`Failed to spawn command: sdkmanager: ${error.message}`))),
      );
      if (inputOptions.input) {
        child.stdin?.write(inputOptions.input);
        child.stdin?.end();
      }
    });
  }

  private windowsBatchInvocation(
    path: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
  ): { command: string; args: string[] } {
    if (this.dependencies.platform !== "win32" || !path.toLowerCase().endsWith(".bat")) {
      return { command: path, args };
    }
    const command = `"${[quoteForWindowsCmd(path), ...args.map(quoteForWindowsCmd)].join(" ")}"`;
    return {
      command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", command],
    };
  }
}

/** Read and normalize the installed sdkmanager version for diagnostics. */
export async function readSdkManagerVersion(
  client: Pick<SdkManagerClient, "getVersion"> = new SdkManagerClient(),
  location?: AndroidToolsLocation,
): Promise<string | null> {
  const result = await client.getVersion(location ? { location } : {});
  if (result.exitCode !== 0) {
    logger.debug(
      `sdkmanager --version failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
    return null;
  }
  let version: string | null = null;
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = line.trim().match(/^(\d+(?:\.\d+){0,2})$/);
    if (match) {
      version = match[1];
    }
  }
  return version;
}
