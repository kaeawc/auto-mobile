import { dirname, join, posix } from "node:path";
import { ActionableError, type BootedDevice, type ExecResult, type Platform } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import { normalizeAppFileRelativePath, type AppFileContainer } from "./appFileContract";
import {
  decodeUtf8Text,
  executeAndroidAppFileCommand,
  executeIosAppContainerCommand,
  iosContainerRelativePath,
  listLocalFiles,
  nodeAppFileFileSystem,
  resolveAndroidTarget,
  type AndroidTarget,
  type AppFileFileSystem,
  type LocalFileListEntry,
} from "./appFileService";
import {
  type SessionLogAppGroupRequest,
  type SessionLogAppGroupResult,
  type SessionLogCollectionRequest,
  type SessionLogCollectionResult,
  type SessionLogFileOutcome,
  type SessionLogFilesRequest,
  type SessionLogFilesResult,
  type SessionLogSourceOutcome,
  type ResetAppLogsPathOutcome,
  type ResetAppLogsResult,
  type UnifiedLogWindowRequest,
  type UnifiedLogWindowResult,
} from "./sessionLogContract";

/** The narrow simctl surface the iOS provider needs: one argv exec and one shell-string exec. */
export interface SessionLogSimctl {
  executeCommand(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface SessionLogCollectRequest {
  sessionUuid: string;
  device: BootedDevice;
  request: SessionLogCollectionRequest;
  signal?: AbortSignal;
}

export interface ResetAppLogsRequest {
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  paths: string[];
  signal?: AbortSignal;
}

export interface SessionLogService {
  collect(request: SessionLogCollectRequest): Promise<SessionLogCollectionResult>;
  resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsResult>;
}

/**
 * A platform's log sources. Optional members are sources the platform does not
 * have; the service reports those as `unavailable` rather than failing the
 * collection.
 */
export interface SessionLogProvider {
  readonly platform: Platform;
  readAppLogs(
    device: BootedDevice,
    appId: string,
    request: SessionLogFilesRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SessionLogFilesResult>;
  resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]>;
  readAppGroup?(
    device: BootedDevice,
    appId: string,
    request: SessionLogAppGroupRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SessionLogAppGroupResult>;
  collectUnifiedLog?(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<UnifiedLogWindowResult>;
}

export interface SessionLogServiceDependencies {
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => SessionLogSimctl;
  fileSystem?: AppFileFileSystem;
  timer?: Timer;
  /** Hard ceiling on one `log show` invocation; the window itself is bounded by the contract. */
  unifiedLogTimeoutMs?: number;
  providers?: SessionLogProvider[];
}

export const UNIFIED_LOG_DEFAULT_TIMEOUT_MS = 20_000;
const ANDROID_LOG_READ_MAX_BUFFER = 16 * 1024 * 1024;
const ANDROID_MISSING_MARKER = "__AUTOMOBILE_MISSING__";

let sessionLogService: SessionLogService | null = null;

export function getSessionLogService(): SessionLogService {
  if (!sessionLogService) {
    sessionLogService = createSessionLogService();
  }
  return sessionLogService;
}

export function createSessionLogService(
  deps: SessionLogServiceDependencies = {},
): SessionLogService {
  const timer = deps.timer ?? defaultTimer;
  const providers = deps.providers ?? [
    new AndroidSessionLogProvider(deps.adbFactory ?? defaultAdbClientFactory),
    new IosSimulatorSessionLogProvider(
      deps.simctlFactory ?? ((device) => new SimCtlClient(device)),
      deps.fileSystem ?? nodeAppFileFileSystem,
      timer,
      deps.unifiedLogTimeoutMs ?? UNIFIED_LOG_DEFAULT_TIMEOUT_MS,
    ),
  ];
  return new DefaultSessionLogService(providers);
}

class DefaultSessionLogService implements SessionLogService {
  private readonly providers = new Map<Platform, SessionLogProvider>();

  constructor(providers: SessionLogProvider[]) {
    for (const provider of providers) {
      this.providers.set(provider.platform, provider);
    }
  }

  async collect(request: SessionLogCollectRequest): Promise<SessionLogCollectionResult> {
    const { device, sessionUuid, signal } = request;
    const { appId, maxBytes } = request.request;
    const provider = this.requireProvider(device.platform);
    const result: SessionLogCollectionResult = {
      sessionUuid,
      deviceId: device.deviceId,
      platform: device.platform,
      appId,
      maxBytes,
    };

    // Each source is isolated: one failing (or absent) source becomes its own
    // outcome and never blocks the others.
    const files = request.request.files;
    if (files) {
      result.files = await runSource("app-container logs", () =>
        provider.readAppLogs(device, appId, files, maxBytes, signal),
      );
    }
    const appGroup = request.request.appGroup;
    if (appGroup) {
      result.appGroup = provider.readAppGroup
        ? await runSource("App Group files", () =>
            provider.readAppGroup!(device, appId, appGroup, maxBytes, signal),
          )
        : unavailable(`App Group containers are not available on ${device.platform}.`);
    }
    const unifiedLog = request.request.unifiedLog;
    if (unifiedLog) {
      result.unifiedLog = provider.collectUnifiedLog
        ? await runSource("unified log", () =>
            provider.collectUnifiedLog!(device, appId, unifiedLog, maxBytes, signal),
          )
        : unavailable(`The unified log is not available on ${device.platform}.`);
    }
    return result;
  }

  async resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsResult> {
    const provider = this.requireProvider(request.device.platform);
    const entries = await provider.resetAppLogs(request);
    return {
      success: true,
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      entries,
    };
  }

  private requireProvider(platform: Platform): SessionLogProvider {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new ActionableError(`Session logs are not supported on ${platform}.`);
    }
    return provider;
  }
}

export class SessionLogTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLogTimeoutError";
  }
}

function unavailable<T>(reason: string): SessionLogSourceOutcome<T> {
  return { status: "unavailable", reason };
}

async function runSource<T extends object>(
  label: string,
  read: () => Promise<T>,
): Promise<SessionLogSourceOutcome<T>> {
  try {
    return { status: "ok", ...(await read()) };
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn(`[SessionLogService] ${label} source failed: ${reason}`, error);
    if (error instanceof SessionLogTimeoutError) {
      return { status: "timedOut", reason };
    }
    if (
      error instanceof ActionableError &&
      /not supported|only supported|not available/i.test(reason)
    ) {
      return { status: "unavailable", reason };
    }
    return { status: "failed", reason };
  }
}

function boundedContent(
  buffer: Buffer,
  byteCount: number,
  maxBytes: number,
): Pick<SessionLogFileOutcome, "byteCount" | "truncated" | "text" | "blob"> {
  const bounded = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  const text = decodeUtf8Text(bounded);
  return {
    byteCount,
    truncated: byteCount > bounded.byteLength,
    ...(text === undefined ? { blob: bounded.toString("base64") } : { text }),
  };
}

function failedPath(
  path: string,
  error: unknown,
): { path: string; status: "failed"; reason: string } {
  return { path, status: "failed", reason: errorMessage(error) };
}

/** Same rotation convention as Android's `Log`/logback rotators: `<name>`, `<name>.1`, `<name>.2`, … */
function isRotatedSibling(name: string, base: string): boolean {
  return name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1));
}

// --- Android ----------------------------------------------------------------

function androidResetScript(target: AndroidTarget & { kind: "runAs" | "external" }): string {
  const quoted = shellQuote(target.kind === "runAs" ? target.relativePath : target.absolutePath);
  return (
    `found=0; for f in ${quoted} ${quoted}.[0-9]*; do ` +
    `if [ -e "$f" ]; then rm -f -- "$f" && found=1; fi; done; ` +
    `if [ "$found" = 1 ]; then echo reset; else echo missing; fi`
  );
}

function androidReadScript(
  target: AndroidTarget & { kind: "runAs" | "external" },
  maxBytes: number,
): string {
  const quoted = shellQuote(target.kind === "runAs" ? target.relativePath : target.absolutePath);
  return (
    `if [ -f ${quoted} ]; then wc -c < ${quoted}; head -c ${maxBytes} ${quoted} | base64; ` +
    `else echo ${ANDROID_MISSING_MARKER}; fi`
  );
}

function parseAndroidRead(path: string, stdout: string, maxBytes: number): SessionLogFileOutcome {
  const trimmed = stdout.trim();
  if (trimmed === ANDROID_MISSING_MARKER) {
    return { path, status: "missing" };
  }
  const newline = trimmed.indexOf("\n");
  const sizeText = (newline < 0 ? trimmed : trimmed.slice(0, newline)).trim();
  const byteCount = Number(sizeText);
  if (!Number.isFinite(byteCount)) {
    return { path, status: "failed", reason: `Unexpected device response: ${sizeText}` };
  }
  const blob = newline < 0 ? "" : trimmed.slice(newline + 1).replace(/\s+/g, "");
  const buffer = Buffer.from(blob, "base64");
  return { path, status: "read", ...boundedContent(buffer, byteCount, maxBytes) };
}

export class AndroidSessionLogProvider implements SessionLogProvider {
  readonly platform = "android" as const;

  constructor(private readonly adbFactory: AdbClientFactory) {}

  async readAppLogs(
    device: BootedDevice,
    appId: string,
    request: SessionLogFilesRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SessionLogFilesResult> {
    const adb = this.adbFactory.create(device);
    const entries: SessionLogFileOutcome[] = [];
    for (const path of request.paths) {
      const target = resolveAndroidTarget(appId, request.container, path);
      if (target.kind === "unsupported") {
        entries.push({ path, status: "failed", reason: target.message });
        continue;
      }
      try {
        const result = await this.run(
          adb,
          device,
          appId,
          request.container,
          target,
          androidReadScript(target, maxBytes),
          "read",
          signal,
        );
        entries.push(parseAndroidRead(path, result.stdout, maxBytes));
      } catch (error) {
        entries.push(failedPath(path, error));
      }
    }
    return { container: request.container, entries };
  }

  async resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]> {
    const adb = this.adbFactory.create(request.device);
    const entries: ResetAppLogsPathOutcome[] = [];
    for (const path of request.paths) {
      const target = resolveAndroidTarget(request.appId, request.container, path);
      if (target.kind === "unsupported") {
        entries.push({ path, status: "failed", reason: target.message });
        continue;
      }
      try {
        const result = await this.run(
          adb,
          request.device,
          request.appId,
          request.container,
          target,
          androidResetScript(target),
          "reset",
          request.signal,
        );
        entries.push({ path, status: result.stdout.trim() === "reset" ? "reset" : "missing" });
      } catch (error) {
        entries.push(failedPath(path, error));
      }
    }
    return entries;
  }

  private run(
    adb: AdbExecutor,
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    target: AndroidTarget & { kind: "runAs" | "external" },
    script: string,
    operation: "read" | "reset",
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const command =
      target.kind === "external"
        ? `shell sh -c ${shellQuote(script)}`
        : `shell run-as ${shellQuote(appId)} sh -c ${shellQuote(script)}`;
    return executeAndroidAppFileCommand(
      adb,
      command,
      {
        device,
        appId,
        container,
        operation,
        access: target.kind === "external" ? "externalFiles" : "run-as",
      },
      { maxBuffer: ANDROID_LOG_READ_MAX_BUFFER, noRetry: true, signal },
    );
  }
}

// --- iOS Simulator ----------------------------------------------------------

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A missing log file is an expected per-path outcome; anything else is a traced failure. */
function readOutcomeForError(path: string, target: string, error: unknown): SessionLogFileOutcome {
  if (isMissing(error)) {
    logger.debug(`[SessionLogService] log file missing: ${target}: ${error}`);
    return { path, status: "missing" };
  }
  logger.warn(`[SessionLogService] read ${target} failed: ${errorMessage(error)}`, error);
  return failedPath(path, error);
}

export class IosSimulatorSessionLogProvider implements SessionLogProvider {
  readonly platform = "ios" as const;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => SessionLogSimctl,
    private readonly fileSystem: AppFileFileSystem,
    private readonly timer: Timer,
    private readonly unifiedLogTimeoutMs: number,
  ) {}

  async readAppLogs(
    device: BootedDevice,
    appId: string,
    request: SessionLogFilesRequest,
    maxBytes: number,
  ): Promise<SessionLogFilesResult> {
    const root = await this.resolveContainerRoot(device, appId, request.container, "read", "data");
    const containerRoot = join(
      root,
      iosContainerRelativePath(request.container, "read", appId, device.platform),
    );
    const entries: SessionLogFileOutcome[] = [];
    for (const path of request.paths) {
      entries.push(await this.readBounded(containerRoot, path, maxBytes));
    }
    return { container: request.container, entries };
  }

  async resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]> {
    const { device, appId, container } = request;
    const root = await this.resolveContainerRoot(device, appId, container, "reset", "data");
    const containerRoot = join(
      root,
      iosContainerRelativePath(container, "reset", appId, device.platform),
    );
    const entries: ResetAppLogsPathOutcome[] = [];
    for (const path of request.paths) {
      try {
        entries.push({ path, status: await this.resetOne(containerRoot, path) });
      } catch (error) {
        entries.push({ path, status: "failed", reason: errorMessage(error) });
      }
    }
    return entries;
  }

  async readAppGroup(
    device: BootedDevice,
    appId: string,
    request: SessionLogAppGroupRequest,
    maxBytes: number,
  ): Promise<SessionLogAppGroupResult> {
    const root = await this.resolveContainerRoot(
      device,
      appId,
      request.groupId,
      "read",
      request.groupId,
    );
    const files: LocalFileListEntry[] = await listLocalFiles(root, this.fileSystem);
    const entries: SessionLogFileOutcome[] = [];
    for (const path of request.paths) {
      entries.push(await this.readBounded(root, path, maxBytes));
    }
    return { groupId: request.groupId, files, entries };
  }

  async collectUnifiedLog(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<UnifiedLogWindowResult> {
    this.requireSimulator(device, "collect the unified log");
    const predicate = `subsystem == "${appId}" OR subsystem BEGINSWITH "${appId}."`;
    const args = [
      "spawn",
      device.deviceId,
      "log",
      "show",
      "--last",
      `${request.lastSeconds}`,
      "--style",
      "compact",
      "--predicate",
      predicate,
      ...(request.level === "info" ? ["--info"] : []),
      ...(request.level === "debug" ? ["--info", "--debug"] : []),
    ];
    const stdout = await this.runBounded(device, args, signal);
    const buffer = Buffer.from(stdout, "utf8");
    const bounded = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
    return {
      lastSeconds: request.lastSeconds,
      level: request.level,
      predicate,
      timeoutMs: this.unifiedLogTimeoutMs,
      byteCount: buffer.byteLength,
      truncated: bounded.byteLength < buffer.byteLength,
      text: bounded.toString("utf8"),
    };
  }

  /**
   * Run one `simctl spawn … log show` under the injected timer. The window is
   * bounded by the contract; this bounds the wall clock, aborting the child on
   * expiry so a wedged `log show` never pins the collection.
   */
  private async runBounded(
    device: BootedDevice,
    args: string[],
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const simctl = this.simctlFactory(device);
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = this.timer.setTimeout(() => {
        const error = new SessionLogTimeoutError(
          `Unified log collection timed out after ${this.unifiedLogTimeoutMs}ms on ${device.deviceId}.`,
        );
        controller.abort(error);
        reject(error);
      }, this.unifiedLogTimeoutMs);
    });
    const run = simctl.executeCommandArgs(args, undefined, signal);
    // Once the timer wins, the aborted run settles later; keep it handled.
    run.catch(() => {});
    try {
      return (await Promise.race([run, timeout])).stdout;
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private requireSimulator(device: BootedDevice, action: string): void {
    if (!isIosSimulatorUdid(device.deviceId)) {
      throw new ActionableError(
        `iOS session logs are only supported on iOS simulators; cannot ${action} on ` +
          `${device.deviceId}, which looks like a physical iOS device.`,
      );
    }
  }

  private async resolveContainerRoot(
    device: BootedDevice,
    appId: string,
    containerLabel: string,
    operation: string,
    simctlContainer: string,
  ): Promise<string> {
    this.requireSimulator(device, `${operation} ${containerLabel} logs for ${appId}`);
    const result = await executeIosAppContainerCommand(
      this.simctlFactory(device),
      `get_app_container ${shellQuote(device.deviceId)} ${shellQuote(appId)} ${shellQuote(simctlContainer)}`,
      { device, appId, container: containerLabel, operation },
    );
    const root = result.stdout.trim();
    if (!root) {
      throw new ActionableError(
        `Unable to resolve the ${containerLabel} container for ${appId} on ${device.deviceId}. ` +
          "Confirm the simulator is booted, the app is installed, and the app declares the container.",
      );
    }
    return root;
  }

  private async readBounded(
    root: string,
    path: string,
    maxBytes: number,
  ): Promise<SessionLogFileOutcome> {
    const target = join(root, normalizeAppFileRelativePath(path));
    try {
      const stat = await this.fileSystem.lstat(target);
      if (!stat.isFile()) {
        return { path, status: "failed", reason: "Not a regular file." };
      }
      const buffer = await this.fileSystem.readFileBuffer(target);
      return { path, status: "read", ...boundedContent(buffer, buffer.byteLength, maxBytes) };
    } catch (error) {
      return readOutcomeForError(path, target, error);
    }
  }

  private async resetOne(
    containerRoot: string,
    path: string,
  ): Promise<ResetAppLogsPathOutcome["status"]> {
    const target = join(containerRoot, normalizeAppFileRelativePath(path));
    const directory = dirname(target);
    const base = posix.basename(path);
    let siblings: string[] = [];
    try {
      siblings = (await this.fileSystem.readdir(directory))
        .map((entry) => entry.name)
        .filter((name) => name === base || isRotatedSibling(name, base));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      // A missing parent directory means there is nothing to reset.
      logger.debug(`[SessionLogService] log directory missing: ${directory}: ${error}`);
    }
    if (siblings.length === 0) {
      return "missing";
    }
    for (const name of siblings) {
      await this.fileSystem.rm(join(directory, name));
    }
    return "reset";
  }
}
