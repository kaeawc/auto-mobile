import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer } from "../utils/SystemTimer";
import { nodeAppFileFileSystem } from "./appFileSupport";
import {
  DefaultSessionLogService,
  type SessionLogService,
  type SessionLogServiceDependencies,
} from "./DefaultSessionLogService";
import { AndroidSessionLogProvider } from "./AndroidSessionLogProvider";
import { IosSimulatorSessionLogProvider } from "./IosSimulatorSessionLogProvider";
export { AndroidSessionLogProvider } from "./AndroidSessionLogProvider";
export { IosSimulatorSessionLogProvider } from "./IosSimulatorSessionLogProvider";
export { SessionLogTimeoutError } from "./SessionLogTimeoutError";
export type {
  SessionLogSimctl,
  SessionLogCollectRequest,
  ResetAppLogsRequest,
  SessionLogService,
  SessionLogProvider,
  SessionLogServiceDependencies,
} from "./DefaultSessionLogService";

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
