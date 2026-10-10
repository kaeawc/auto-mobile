import { trackAmbient } from "../PerfContext";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ActionableError } from "../../models";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";
import { AndroidCommandTerminatedError, runAndroidCommand } from "./runAndroidCommand";
import { resolveAndroidSdkRoot } from "./androidSdkRoot";
import {
  DefaultHostCommandExecutor,
  type HostChildProcess as ChildProcess,
  type HostProcessExecutor,
  type HostSpawnOptions as SpawnOptions,
} from "../HostCommandExecutor";
import {
  detectAndroidCommandLineTools,
  getAndroidHomeWithSystemImages,
  getBestAndroidToolsLocation,
  getCmdlineToolsRoot,
  isHomebrewToolsPath,
  validateRequiredTools,
  type AndroidToolsLocation,
} from "./detection";
import type { AvdInfo, CreateAvdParams, DeviceProfile } from "./avdmanager";

export interface AvdManagerExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AvdManagerClientDependencies {
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

const SDK_ROOT_MARKERS = ["system-images", "platforms", "platform-tools", "build-tools"];
const OLD_TOOLS_BIN_MARKER = "/tools/bin/";
const CMDLINE_TOOLS_MARKER = "/cmdline-tools/";
const JAXB_ERROR_MARKERS = [
  "javax/xml/bind/annotation/XmlSchema",
  "javax.xml.bind.annotation.XmlSchema",
  "javax/xml/bind",
  "javax.xml.bind",
];
const TERMINATION_ESCALATION_MS = 1_000;
const DEFAULT_MAX_OUTPUT_CHARS = 16_384;
// Parsed lists can legitimately exceed 16 KiB; retain up to 1 MiB before refusing partial output.
const MAX_LIST_STDOUT_CHARS = 1_048_576;

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough, so this is behavior-identical; the
// client's own stdin-piping and process orchestration are unchanged, and tests
// still inject `dependencies.spawn`.
const avdManagerHostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

function defaults(): AvdManagerClientDependencies {
  return {
    spawn: (command, args, options) => avdManagerHostProcessExecutor.spawn(command, args, options),
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

function getFailureSummary(result: CommandResult): string {
  const stderr = result.stderr.trim();
  const summary = stderr || result.stdout.trim() || "Unknown error";
  const truncated = stderr ? result.stderrTruncated : result.stdoutTruncated;
  return summary + (truncated ? "\n[output truncated]" : "");
}

function quoteForWindowsCmd(value: string): string {
  if (/[\r\n"]/.test(value)) {
    throw new Error("avdmanager arguments cannot contain Windows command-line quotes or newlines");
  }
  return `"${value.replace(/%/g, "%%")}"`;
}

function incompatibleMessage(path: string, output: string): string | null {
  const normalized = normalizePath(output);
  const jaxb = JAXB_ERROR_MARKERS.some((marker) => normalized.includes(marker));
  const deprecated =
    normalizePath(path).includes(OLD_TOOLS_BIN_MARKER) &&
    !normalizePath(path).includes(CMDLINE_TOOLS_MARKER);
  if (!jaxb && !deprecated) {
    return null;
  }

  const header = jaxb
    ? "Error: Android SDK tools are outdated and incompatible with Java 11+."
    : "Error: Detected deprecated Android SDK Tools (tools/bin).";
  const issue = jaxb
    ? 'Issue: Detected javax.xml.bind (JAXB) errors. This usually means the deprecated "Android SDK Tools" package (tools/bin) is in use.'
    : 'Issue: Old "Android SDK Tools" package (deprecated since 2017).';
  return [
    header,
    "",
    `Current avdmanager: ${path}`,
    issue,
    "",
    "Fix:",
    '1. Download "Android SDK Command-line Tools" from:',
    "   https://developer.android.com/studio#command-line-tools-only",
    "2. Extract to: $ANDROID_SDK_ROOT/cmdline-tools/latest/",
    "3. Ensure ANDROID_SDK_ROOT/ANDROID_HOME point to your SDK root and remove tools/bin from PATH.",
  ].join("\n");
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface AvdInventory {
  valid: AvdInfo[];
  unloadable: Array<{ name: string; path: string; error: string }>;
}

function createAvdArgs(params: CreateAvdParams): string[] {
  const args = ["create", "avd", "-n", params.name, "-k", params.package];
  if (params.device) {
    args.push("-d", params.device);
  }
  if (params.force) {
    args.push("--force");
  }
  for (const [flag, value] of [
    ["-p", params.path],
    ["-t", params.tag],
    ["--abi", params.abi],
  ] as const) {
    if (value) {
      args.push(flag, value);
    }
  }
  return args;
}

/**
 * `avdmanager create avd` was killed (timeout or signal) before it reported an
 * outcome, so the AVD may exist half-written. Unlike a clean non-zero exit
 * (`success: false`), the caller must treat the AVD as possibly created and
 * roll it back (#11155).
 */
export class AvdCreateInterruptedError extends ActionableError {
  constructor(
    public readonly avdName: string,
    detail: string,
  ) {
    super(`Failed to create AVD ${avdName}: ${detail}. The AVD may have been partially created.`);
    this.name = "AvdCreateInterruptedError";
  }
}

export class AvdManagerClient {
  private static readonly homebrewWarningLoggers = new WeakSet<object>();

  constructor(private readonly dependencies: AvdManagerClientDependencies = defaults()) {}

  async listDeviceImages(options: AvdManagerExecutionOptions = {}): Promise<AvdInfo[]> {
    return (await this.listAvdInventory(options)).valid;
  }

  /** Include unloadable AVD diagnostics separately from startable images. */
  async listAvdInventory(options: AvdManagerExecutionOptions = {}): Promise<AvdInventory> {
    const { path, env } = await this.resolve();
    const result = await this.execute(
      path,
      ["list", "avd"],
      { env, timeoutMs: options.timeoutMs ?? 60_000, maxStdoutChars: MAX_LIST_STDOUT_CHARS },
      options,
    );
    this.throwIfUnsuccessful("Failed to list AVDs", path, result);
    this.throwIfListTruncated("list avd", result);
    return this.parseAvdList(result.stdout);
  }

  async createAvd(
    params: CreateAvdParams,
    options: AvdManagerExecutionOptions = {},
  ): Promise<{ success: boolean; message: string; avdName?: string }> {
    try {
      const { path, env } = await this.resolve();
      const result = await this.execute(
        path,
        createAvdArgs(params),
        { input: "\n", env, timeoutMs: options.timeoutMs ?? 300_000 },
        options,
      );
      if (result.exitCode === 0) {
        return {
          success: true,
          message: `AVD ${params.name} created successfully`,
          avdName: params.name,
        };
      }
      if (result.exitCode === null) {
        // Killed by a signal before it reported an outcome; not a clean rejection.
        throw new AvdCreateInterruptedError(
          params.name,
          `avdmanager was killed: ${getFailureSummary(result)}`,
        );
      }
      return {
        success: false,
        message:
          incompatibleMessage(path, `${result.stderr}\n${result.stdout}`) ??
          `AVD creation failed: ${getFailureSummary(result)}`,
      };
    } catch (error) {
      if (options.signal?.aborted || error instanceof AvdCreateInterruptedError) {
        throw error;
      }
      if (error instanceof AndroidCommandTerminatedError) {
        // A timed-out create was killed mid-write and may have left the AVD (#11155).
        throw new AvdCreateInterruptedError(params.name, error.message);
      }
      const message = `Failed to create AVD ${params.name}: ${(error as Error).message}`;
      this.dependencies.logger.warn(message, error);
      return { success: false, message };
    }
  }

  async deleteAvd(
    name: string,
    options: AvdManagerExecutionOptions = {},
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { path, env } = await this.resolve();
      const result = await this.execute(
        path,
        ["delete", "avd", "-n", name],
        { env, timeoutMs: options.timeoutMs ?? 60_000 },
        options,
      );
      if (result.exitCode === 0) {
        return { success: true, message: `AVD ${name} deleted successfully` };
      }
      return {
        success: false,
        message:
          incompatibleMessage(path, `${result.stderr}\n${result.stdout}`) ??
          `AVD deletion failed: ${getFailureSummary(result)}`,
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      const message = `Failed to delete AVD ${name}: ${(error as Error).message}`;
      this.dependencies.logger.warn(message, error);
      return { success: false, message };
    }
  }

  async listDevices(options: AvdManagerExecutionOptions = {}): Promise<DeviceProfile[]> {
    const { path, env } = await this.resolve();
    const result = await this.execute(
      path,
      ["list", "device"],
      { env, timeoutMs: options.timeoutMs ?? 60_000, maxStdoutChars: MAX_LIST_STDOUT_CHARS },
      options,
    );
    this.throwIfUnsuccessful("Failed to list devices", path, result);
    this.throwIfListTruncated("list device", result);
    return this.parseDeviceList(result.stdout);
  }

  private async resolve(): Promise<{ path: string; env?: NodeJS.ProcessEnv }> {
    const locations = await this.dependencies.detectAndroidCommandLineTools();
    const location = this.dependencies.getBestAndroidToolsLocation(locations);
    if (!location) {
      throw new Error(
        "Android command line tools not found. Tool installation functionality has been removed. Please install Android SDK manually from https://developer.android.com/studio or using Homebrew: brew install --cask android-commandlinetools",
      );
    }
    const validation = this.dependencies.validateRequiredTools(location, ["avdmanager"]);
    if (!validation.valid) {
      throw new Error(
        `Missing required tools: ${validation.missing.join(", ")}. Tool installation functionality has been removed. Please install Android SDK manually.`,
      );
    }
    this.warnHomebrewMismatch(location);
    return { path: this.resolveExecutable(location), env: this.getAndroidSdkEnv(location) };
  }

  private resolveExecutable(location: AndroidToolsLocation): string {
    const executable = join(location.path, "bin", "avdmanager");
    if (this.dependencies.existsSync(executable)) {
      return executable;
    }
    const batch = join(location.path, "bin", "avdmanager.bat");
    if (this.dependencies.existsSync(batch)) {
      return batch;
    }
    throw new Error(`AVD manager not found at ${location.path}`);
  }

  private getAndroidSdkEnv(location: AndroidToolsLocation): NodeJS.ProcessEnv | undefined {
    const env = this.dependencies.environment;
    const environmentSdkRoot = resolveAndroidSdkRoot(
      env,
      (candidate) =>
        this.dependencies.existsSync(join(candidate, "system-images")) ||
        this.looksLikeSdkRoot(candidate),
    );
    if (environmentSdkRoot) {
      return { ...env, ANDROID_HOME: environmentSdkRoot, ANDROID_SDK_ROOT: environmentSdkRoot };
    }

    const candidates = [
      this.stripCmdlineToolsPath(location.path),
      location.path,
      resolve(location.path, ".."),
      resolve(location.path, "..", ".."),
      ...this.typicalSdkPaths(),
    ].filter(Boolean) as string[];
    const sdkRoot =
      candidates.find((candidate) =>
        this.dependencies.existsSync(join(candidate, "system-images")),
      ) ?? candidates.find((candidate) => this.looksLikeSdkRoot(candidate));
    return sdkRoot ? { ...env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot } : undefined;
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

  private warnHomebrewMismatch(location: AndroidToolsLocation): void {
    if (!isHomebrewToolsPath(location.path)) {
      return;
    }
    const info = this.dependencies.getAndroidHomeWithSystemImages();
    if (
      !info ||
      normalizePath(getCmdlineToolsRoot(location.path)) === normalizePath(info.androidHome)
    ) {
      return;
    }
    if (AvdManagerClient.homebrewWarningLoggers.has(this.dependencies.logger)) {
      return;
    }
    this.dependencies.logger.warn(
      `Warning: Homebrew Android cmdline-tools detected, but system images are in ANDROID_HOME. avdmanager may report missing system images because Homebrew sets com.android.sdkmanager.toolsdir to its own root. avdmanager location: ${location.path} ANDROID_HOME: ${info.androidHome} System images: ${info.systemImagesPath} Fix: ensure cmdline-tools are present under ANDROID_HOME.`,
    );
    AvdManagerClient.homebrewWarningLoggers.add(this.dependencies.logger);
  }

  private execute(
    path: string,
    args: string[],
    inputOptions: {
      input?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxStdoutChars?: number;
    },
    options: AvdManagerExecutionOptions,
  ): Promise<CommandResult> {
    // One span per avdmanager invocation, named by the leading subcommand so
    // spans aggregate (e.g. `avdmanager create`), recorded against the ambient
    // device-lifecycle tracker when one is in scope (see PerfContext).
    return trackAmbient(`avdmanager ${args.slice(0, 2).join(" ")}`.trimEnd(), () =>
      this.executeInner(path, args, inputOptions, options),
    );
  }

  private async executeInner(
    path: string,
    args: string[],
    inputOptions: {
      input?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxStdoutChars?: number;
    },
    options: AvdManagerExecutionOptions,
  ): Promise<CommandResult> {
    // Preserve pre-abort ordering: Windows argument validation must not run when cancelled.
    if (options.signal?.aborted) {
      throw new Error("avdmanager command cancelled");
    }
    const invocation = this.windowsBatchInvocation(path, args, inputOptions.env);
    return runAndroidCommand(this.dependencies, {
      ...invocation,
      env: inputOptions.env,
      input: inputOptions.input,
      signal: options.signal,
      timeoutMs: inputOptions.timeoutMs,
      maxStdoutChars: inputOptions.maxStdoutChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      maxStderrChars: DEFAULT_MAX_OUTPUT_CHARS,
      name: "avdmanager",
      spawnErrorPrefix: "Failed to spawn avdmanager: ",
      terminationGraceMs: TERMINATION_ESCALATION_MS,
      forcedSettlementDelayMs: TERMINATION_ESCALATION_MS,
      onStart: () => this.dependencies.logger.info(`Executing: ${path} ${args.join(" ")}`),
      onOutput: (stream, output) => {
        if (output.trim()) {
          const level = stream === "stdout" ? "info" : "warn";
          this.dependencies.logger[level](`[${path}] ${output.trim()}`);
        }
      },
    });
  }

  private windowsBatchInvocation(
    path: string,
    args: string[],
    environment?: NodeJS.ProcessEnv,
  ): { command: string; args: string[] } {
    if (this.dependencies.platform !== "win32" || !path.toLowerCase().endsWith(".bat")) {
      return { command: path, args };
    }

    const command = `"${[quoteForWindowsCmd(path), ...args.map(quoteForWindowsCmd)].join(" ")}"`;
    return {
      command: environment?.ComSpec ?? environment?.COMSPEC ?? "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", command],
    };
  }

  private throwIfUnsuccessful(prefix: string, path: string, result: CommandResult): void {
    if (result.exitCode === 0) {
      return;
    }
    const compatibility = incompatibleMessage(path, `${result.stderr}\n${result.stdout}`);
    throw compatibility
      ? new ActionableError(compatibility)
      : new Error(`${prefix}: ${getFailureSummary(result)}`);
  }

  private throwIfListTruncated(command: string, result: CommandResult): void {
    if (result.stdoutTruncated) {
      throw new ActionableError(
        `avdmanager ${command} output exceeded ${MAX_LIST_STDOUT_CHARS} characters and was truncated; refusing to parse partial output. Reduce the list size and retry.`,
      );
    }
  }

  private parseAvdList(output: string): AvdInventory {
    const inventory: AvdInventory = { valid: [], unloadable: [] };
    let current: AvdInfo | undefined;
    let unloadableSection = false;
    const finishEntry = () => {
      if (!current?.name) {
        return;
      }
      if (unloadableSection) {
        inventory.unloadable.push({
          name: current.name,
          path: current.path ?? "",
          error: current.error ?? "",
        });
      } else {
        inventory.valid.push(current);
      }
      current = undefined;
    };
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "The following Android Virtual Devices could not be loaded:") {
        finishEntry();
        unloadableSection = true;
      } else if (trimmed.startsWith("Name:")) {
        finishEntry();
        current = { name: trimmed.slice("Name:".length).trim() };
      } else if (!current) {
        continue;
      } else if (trimmed.startsWith("Path:")) {
        current.path = trimmed.slice("Path:".length).trim();
      } else if (trimmed.startsWith("Target:")) {
        current.target = trimmed.slice("Target:".length).trim();
      } else if (trimmed.startsWith("Based on:")) {
        current.basedOn = trimmed.slice("Based on:".length).trim();
      } else if (trimmed.startsWith("Error:")) {
        current.error = trimmed.slice("Error:".length).trim();
      }
    }
    finishEntry();
    return inventory;
  }

  private parseDeviceList(output: string): DeviceProfile[] {
    const devices: DeviceProfile[] = [];
    let current: Partial<DeviceProfile> = {};
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      const field = /^(\w+)\s*:\s*(.*)$/.exec(trimmed);
      if (!field) {
        continue;
      }
      const fieldName = field[1]?.toLowerCase();
      const value = field[2]?.trim() ?? "";
      if (fieldName === "id") {
        if (current.id) {
          devices.push(current as DeviceProfile);
        }
        current = { id: this.normalizeDeviceProfileId(value) };
      } else if (fieldName === "name") {
        current.name = value;
      } else if (fieldName === "oem") {
        current.oem = value;
      }
    }
    if (current.id) {
      devices.push(current as DeviceProfile);
    }
    return devices;
  }

  private normalizeDeviceProfileId(id: string): string {
    // Recent Android SDKs render the numeric ID and accepted profile name together.
    const match = /^\d+\s+or\s+"([^"]+)"$/.exec(id);
    return match?.[1] ?? id;
  }
}
