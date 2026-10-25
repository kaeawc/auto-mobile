import type { SimulatorContainerOwnershipOptions } from "../utils/ios-cmdline-tools/simulatorOwnContainer";
import { ActionableError, type BootedDevice, type ExecResult, type Platform } from "../models";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { HostCommandExecutor } from "../utils/HostCommandExecutor";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { AppFileContainer } from "./appFileContract";
import { decodeUtf8Text } from "./appFileSupport";
import { type AppFileFileSystem } from "./appFileService";
import type {
  SessionLogAppGroupRequest,
  SessionLogAppGroupResult,
  SessionLogCollectionRequest,
  SessionLogCollectionResult,
  SessionLogFileOutcome,
  SessionLogFilesRequest,
  SessionLogFilesResult,
  AndroidLogcatWindowResult,
  SessionLogSourceOutcome,
  ResetAppLogsPathOutcome,
  ResetAppLogsResult,
  UnifiedLogWindowRequest,
  UnifiedLogWindowResult,
} from "./sessionLogContract";
import { SessionLogSourceError } from "./SessionLogSourceError";
import { SessionLogTimeoutError } from "./SessionLogTimeoutError";

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
  collectAndroidLogcat?(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<AndroidLogcatWindowResult>;
}

export interface SessionLogServiceDependencies {
  containerOwnership?: SimulatorContainerOwnershipOptions;
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => SessionLogSimctl;
  fileSystem?: AppFileFileSystem;
  timer?: Timer;
  /** Hard ceiling on one `log show` invocation; the window itself is bounded by the contract. */
  unifiedLogTimeoutMs?: number;
  /** Physical iOS unified-log seams (`log collect --device-udid` on the host). */
  physicalIos?: {
    host?: HostCommandExecutor;
    /** Ceiling on `log collect` plus `log show`; defaults to 60 s. */
    timeoutMs?: number;
    hostPlatform?: NodeJS.Platform;
    tempRoot?: string;
  };
  providers?: SessionLogProvider[];
}

export class DefaultSessionLogService implements SessionLogService {
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
      if (device.platform === "android") {
        result.androidLogcat = provider.collectAndroidLogcat
          ? await runSource("Android logcat", () =>
              provider.collectAndroidLogcat!(device, appId, unifiedLog, maxBytes, signal),
            )
          : unavailable(`Android logcat is not available on ${device.deviceId}.`);
      } else {
        result.unifiedLog = provider.collectUnifiedLog
          ? await runSource("unified log", () =>
              provider.collectUnifiedLog!(device, appId, unifiedLog, maxBytes, signal),
            )
          : unavailable(`The unified log is not available on ${device.platform}.`);
      }
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
    if (error instanceof SessionLogSourceError) {
      return { status: error.status, reason, code: error.code };
    }
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

export function boundedContent(
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

export function failedPath(
  path: string,
  error: unknown,
): { path: string; status: "failed"; reason: string } {
  return { path, status: "failed", reason: errorMessage(error) };
}
