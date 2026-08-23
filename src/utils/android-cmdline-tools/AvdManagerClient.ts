import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ActionableError } from "../../models";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";
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

function defaults(): AvdManagerClientDependencies {
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

function getFailureSummary(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || "Unknown error";
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
}

export class AvdManagerClient {
  private static readonly homebrewWarningLoggers = new WeakSet<object>();

  constructor(private readonly dependencies: AvdManagerClientDependencies = defaults()) {}

  async listDeviceImages(options: AvdManagerExecutionOptions = {}): Promise<AvdInfo[]> {
    const { path, env } = await this.resolve();
    const result = await this.execute(path, ["list", "avd"], { env, timeoutMs: 60_000 }, options);
    this.throwIfUnsuccessful("Failed to list AVDs", path, result);
    return this.parseAvdList(result.stdout);
  }

  async createAvd(
    params: CreateAvdParams,
    options: AvdManagerExecutionOptions = {},
  ): Promise<{ success: boolean; message: string; avdName?: string }> {
    try {
      const { path, env } = await this.resolve();
      const args = ["create", "avd", "-n", params.name, "-k", params.package];
      if (params.device) {
        args.push("-d", params.device);
      }
      if (params.force) {
        args.push("--force");
      }
      if (params.path) {
        args.push("-p", params.path);
      }
      if (params.tag) {
        args.push("-t", params.tag);
      }
      if (params.abi) {
        args.push("--abi", params.abi);
      }
      const result = await this.execute(
        path,
        args,
        { input: "\n", env, timeoutMs: 300_000 },
        options,
      );
      if (result.exitCode === 0) {
        return {
          success: true,
          message: `AVD ${params.name} created successfully`,
          avdName: params.name,
        };
      }
      return {
        success: false,
        message:
          incompatibleMessage(path, `${result.stderr}\n${result.stdout}`) ??
          `AVD creation failed: ${getFailureSummary(result)}`,
      };
    } catch (error) {
      const message = `Failed to create AVD ${params.name}: ${(error as Error).message}`;
      this.dependencies.logger.error(message);
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
      const message = `Failed to delete AVD ${name}: ${(error as Error).message}`;
      this.dependencies.logger.error(message);
      return { success: false, message };
    }
  }

  async listDevices(options: AvdManagerExecutionOptions = {}): Promise<DeviceProfile[]> {
    const { path, env } = await this.resolve();
    const result = await this.execute(
      path,
      ["list", "device"],
      { env, timeoutMs: 60_000 },
      options,
    );
    this.throwIfUnsuccessful("Failed to list devices", path, result);
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
    const candidates = [
      env.ANDROID_SDK_ROOT,
      env.ANDROID_HOME,
      env.ANDROID_SDK_HOME,
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

  private async execute(
    path: string,
    args: string[],
    inputOptions: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
    options: AvdManagerExecutionOptions,
  ): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
      if (options.signal?.aborted) {
        return reject(new Error("avdmanager command cancelled"));
      }
      const invocation = this.windowsBatchInvocation(path, args, inputOptions.env);
      const child = this.dependencies.spawn(invocation.command, invocation.args, {
        env: inputOptions.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let settled = false;
      let terminationError: Error | undefined;
      let escalationTimeout: NodeJS.Timeout | undefined;
      let forcedSettlementTimeout: NodeJS.Timeout | undefined;
      let stdout = "";
      let stderr = "";
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        this.dependencies.timer.clearTimeout(timeout);
        if (escalationTimeout) {
          this.dependencies.timer.clearTimeout(escalationTimeout);
        }
        if (forcedSettlementTimeout) {
          this.dependencies.timer.clearTimeout(forcedSettlementTimeout);
        }
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const rejectTermination = () => {
        settle(() => reject(terminationError));
      };
      const requestTermination = (error: Error) => {
        if (settled || terminationError) {
          return;
        }
        terminationError = error;
        this.dependencies.timer.clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        child.kill("SIGTERM");
        if (settled) {
          return;
        }
        escalationTimeout = this.dependencies.timer.setTimeout(() => {
          child.kill("SIGKILL");
          if (settled) {
            return;
          }
          forcedSettlementTimeout = this.dependencies.timer.setTimeout(
            rejectTermination,
            TERMINATION_ESCALATION_MS,
          );
        }, TERMINATION_ESCALATION_MS);
      };
      const onAbort = () => requestTermination(new Error("avdmanager command cancelled"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = this.dependencies.timer.setTimeout(
        () =>
          requestTermination(
            new Error(`avdmanager command timed out after ${inputOptions.timeoutMs}ms`),
          ),
        inputOptions.timeoutMs,
      );
      this.dependencies.logger.info(`Executing: ${path} ${args.join(" ")}`);
      child.stdout?.on("data", (data) => {
        const output = data.toString();
        stdout += output;
        if (output.trim()) {
          this.dependencies.logger.info(`[${path}] ${output.trim()}`);
        }
      });
      child.stderr?.on("data", (data) => {
        const output = data.toString();
        stderr += output;
        if (output.trim()) {
          this.dependencies.logger.warn(`[${path}] ${output.trim()}`);
        }
      });
      child.on("close", (code) =>
        settle(() => {
          if (terminationError) {
            reject(terminationError);
            return;
          }
          resolvePromise({ stdout, stderr, exitCode: code });
        }),
      );
      child.on("exit", () => {
        if (terminationError) {
          rejectTermination();
        }
      });
      child.on("error", (error) =>
        settle(() => reject(new Error(`Failed to spawn avdmanager: ${error.message}`))),
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

  private parseAvdList(output: string): AvdInfo[] {
    const avds: AvdInfo[] = [];
    let current: Partial<AvdInfo> = {};
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Name:")) {
        if (current.name) {
          avds.push(current as AvdInfo);
        }
        current = { name: trimmed.slice("Name:".length).trim() };
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
    if (current.name) {
      avds.push(current as AvdInfo);
    }
    return avds;
  }

  private parseDeviceList(output: string): DeviceProfile[] {
    const devices: DeviceProfile[] = [];
    let current: Partial<DeviceProfile> = {};
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("id:")) {
        if (current.id) {
          devices.push(current as DeviceProfile);
        }
        current = { id: trimmed.slice(3).trim() };
      } else if (trimmed.startsWith("Name:")) {
        current.name = trimmed.slice(5).trim();
      } else if (trimmed.startsWith("OEM:")) {
        current.oem = trimmed.slice(4).trim();
      }
    }
    if (current.id) {
      devices.push(current as DeviceProfile);
    }
    return devices;
  }
}
