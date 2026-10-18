import { ActionableError, type BootedDevice, type ExecResult, type Platform } from "../models";
import {
  type AndroidLogcatWindowResult,
  type ResetAppLogsPathOutcome,
  type ResetAppLogsResult,
  type SessionLogAppGroupRequest,
  type SessionLogAppGroupResult,
  type SessionLogCollectionRequest,
  type SessionLogCollectionResult,
  type SessionLogFilesRequest,
  type SessionLogFilesResult,
  type UnifiedLogWindowRequest,
  type UnifiedLogWindowResult,
} from "./sessionLogContract";
import { type AppFileContainer } from "./appFileContract";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { type AppFileFileSystem } from "./appFileService";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { AndroidSessionLogProvider } from "./AndroidSessionLogProvider";
import { IosSimulatorSessionLogProvider } from "./IosSimulatorSessionLogProvider";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { nodeAppFileFileSystem } from "./appFileSupport";
import { runSource, unavailable } from "./sessionLogSupport";

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
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => SessionLogSimctl;
  fileSystem?: AppFileFileSystem;
  timer?: Timer;
  /** Hard ceiling on one `log show` invocation; the window itself is bounded by the contract. */
  unifiedLogTimeoutMs?: number;
  providers?: SessionLogProvider[];
}

export const UNIFIED_LOG_DEFAULT_TIMEOUT_MS = 20_000;

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
